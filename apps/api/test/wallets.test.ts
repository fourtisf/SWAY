/** [A] Several wallets per member: linking, limits, labels, aggregation of holdings/access, and the gas drip. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { quoteWei } from '@sway/curve';
import {
  MAX_LINKED_WALLETS,
  WALLET_ROUTES,
  type HolderDTO,
  type MeDTO,
  type MessagesResponse,
  type ProfileDTO,
  type RoomResponse,
  type TasksResponse,
  type WalletDTO,
  type WalletInfoDTO,
  type WalletsResponse,
} from '@sway/shared';
import { login, makeApp, member, openMarketRow, prisma, resetState, type TestCtx } from './helpers';
import { gasDripBlocker, GAS_DRIP_LABEL } from '../src/services/wallets';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
beforeEach(async () => {
  await resetState(ctx.redis);
  ctx.chain.calls.length = 0;
  ctx.chain.keys.clear();
  ctx.chain.eth.clear();
});
afterAll(() => ctx.close());

/** Signs the /api/wallets/nonce message with `account` and posts /api/wallets/link. */
async function addWallet(
  c: TestCtx,
  cookie: string,
  account: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey()),
  extra: { connector?: string; label?: string; kind?: string } = {},
) {
  const n = await c.app.inject({ method: 'POST', url: '/api/wallets/nonce', headers: { cookie }, payload: {} });
  expect(n.statusCode).toBe(200);
  const { message } = n.json<{ message: string }>();
  const signature = await account.signMessage({ message: message.replace('{address}', account.address) });
  const res = await c.app.inject({
    method: 'POST',
    url: '/api/wallets/link',
    headers: { cookie },
    payload: { address: account.address, signature, connector: extra.connector ?? 'metaMask', ...extra },
  });
  return { res, account, address: account.address.toLowerCase() as `0x${string}` };
}

/** A member whose holdings in `market` are split across their account wallet and one linked wallet. */
async function splitHolder(handle: string, market: { id: string; subject: string }, a: bigint, b: bigint) {
  const m = await member(ctx, handle);
  const second = await addWallet(ctx, m.cookie);
  expect(second.res.statusCode).toBe(200);
  await prisma.holding.createMany({
    data: [
      { marketId: market.id, address: m.address, units: a, costBasisWei: '1000' },
      { marketId: market.id, address: second.address, units: b, costBasisWei: '500' },
    ],
  });
  ctx.chain.setKeys(market.subject, m.address, a);
  ctx.chain.setKeys(market.subject, second.address, b);
  return { m, second };
}

describe('linked wallets', () => {
  it('links, lists (account first), relabels and removes a wallet', async () => {
    const m = await member(ctx, 'multiwallet');
    const { res, address, account } = await addWallet(ctx, m.cookie, undefined, { connector: 'rabby', label: 'Trading' });
    expect(res.statusCode).toBe(200);
    const me = res.json<MeDTO>();
    expect(me.wallets).toEqual([
      expect.objectContaining({ address: m.address, account: true, label: null }),
      expect.objectContaining({ address, account: false, kind: 'external', connector: 'rabby', label: 'Trading' }),
    ]);
    // Same address again is a no-op.
    const again = await addWallet(ctx, m.cookie, account, { connector: 'rabby' });
    expect(again.res.statusCode).toBe(200);
    expect(await prisma.linkedWallet.count()).toBe(1);

    const rn = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/wallets/${address.toUpperCase().replace('0X', '0x')}`,
      headers: { cookie: m.cookie },
      payload: { label: '  Cold  ' },
    });
    expect(rn.statusCode).toBe(200);
    expect(rn.json<WalletInfoDTO>()).toMatchObject({ address, label: 'Cold', connector: 'rabby' });
    const clear = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/wallets/${address}`,
      headers: { cookie: m.cookie },
      payload: { label: null },
    });
    expect(clear.json<WalletInfoDTO>().label).toBeNull();
    const long = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/wallets/${address}`,
      headers: { cookie: m.cookie },
      payload: { label: 'x'.repeat(33) },
    });
    expect(long.statusCode).toBe(400);
    // The account wallet keeps its name and can't be removed.
    for (const method of ['PATCH', 'DELETE'] as const) {
      const r = await ctx.app.inject({ method, url: `/api/wallets/${m.address}`, headers: { cookie: m.cookie }, payload: { label: 'x' } });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('account_wallet');
    }
    // Another member can't touch it.
    const other = await member(ctx, 'notmine');
    const nope = await ctx.app.inject({ method: 'DELETE', url: `/api/wallets/${address}`, headers: { cookie: other.cookie } });
    expect(nope.statusCode).toBe(404);

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/wallets/${address}`, headers: { cookie: m.cookie } });
    expect(del.statusCode).toBe(200);
    expect(del.json<MeDTO>().wallets?.map((w) => w.address)).toEqual([m.address]);
    expect(await prisma.linkedWallet.count()).toBe(0);
  });

  it('needs an account wallet, a fresh nonce and a matching signature', async () => {
    const { cookie } = await login(ctx, 'nowalletyet');
    const r = await addWallet(ctx, cookie);
    expect(r.res.statusCode).toBe(409);
    expect(r.res.json().error).toBe('no_wallet');

    const m = await member(ctx, 'sigcheck');
    const victim = privateKeyToAccount(generatePrivateKey());
    const n = await ctx.app.inject({ method: 'POST', url: '/api/wallets/nonce', headers: { cookie: m.cookie }, payload: { address: victim.address } });
    const { message } = n.json<{ message: string }>();
    expect(message).toContain('@sigcheck');
    expect(message).toContain(`Address: ${victim.address}`);
    const forged = await privateKeyToAccount(generatePrivateKey()).signMessage({ message });
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallets/link',
      headers: { cookie: m.cookie },
      payload: { address: victim.address, signature: forged, connector: 'metaMask' },
    });
    expect(bad.json().error).toBe('bad_signature');
    // The account-wallet nonce does not work here.
    await ctx.redis.flushdb();
    const noNonce = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallets/link',
      headers: { cookie: (await login(ctx, 'sigcheck')).cookie },
      payload: { address: victim.address, signature: await victim.signMessage({ message }), connector: 'metaMask' },
    });
    expect(noNonce.json().error).toBe('nonce_expired');
  });

  it('allows an address once across account and linked wallets (409 wallet_taken)', async () => {
    const a = await member(ctx, 'ownera');
    const b = await member(ctx, 'ownerb');
    // b's account wallet can't become a's linked wallet.
    const takenAccount = await addWallet(ctx, a.cookie, b.account);
    expect(takenAccount.res.statusCode).toBe(409);
    expect(takenAccount.res.json().error).toBe('wallet_taken');
    // A wallet linked by a can't be linked by b, nor become b's (or anyone's) account wallet.
    const shared = privateKeyToAccount(generatePrivateKey());
    expect((await addWallet(ctx, a.cookie, shared)).res.statusCode).toBe(200);
    const again = await addWallet(ctx, b.cookie, shared);
    expect(again.res.statusCode).toBe(409);
    expect(again.res.json().error).toBe('wallet_taken');
    const fresh = await login(ctx, 'newcomer');
    const n = await ctx.app.inject({ method: 'POST', url: '/api/wallet/nonce', headers: { cookie: fresh.cookie } });
    const msg = n.json<{ message: string }>().message.replace('{address}', shared.address);
    const asAccount = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallet/link',
      headers: { cookie: fresh.cookie },
      payload: { address: shared.address, signature: await shared.signMessage({ message: msg }), kind: 'external', connector: 'metaMask' },
    });
    expect(asAccount.statusCode).toBe(409);
    expect(asAccount.json().error).toBe('wallet_taken');
    // Your own account wallet as a linked wallet.
    const self = await addWallet(ctx, a.cookie, a.account);
    expect(self.res.json().error).toBe('wallet_is_account');
  });

  it(`stops at ${MAX_LINKED_WALLETS} linked wallets`, async () => {
    const m = await member(ctx, 'collector');
    for (let i = 0; i < MAX_LINKED_WALLETS; i++) expect((await addWallet(ctx, m.cookie)).res.statusCode).toBe(200);
    const over = await addWallet(ctx, m.cookie);
    expect(over.res.statusCode).toBe(409);
    expect(over.res.json().error).toBe('wallet_limit');
    const me = (await ctx.app.inject({ url: '/api/me', headers: { cookie: m.cookie } })).json<MeDTO>();
    expect(me.wallets).toHaveLength(MAX_LINKED_WALLETS + 1);
    expect(me.wallets![0]!.account).toBe(true);
  });

  it('stores the connector of the account wallet', async () => {
    const { cookie } = await login(ctx, 'withlogo');
    const acct = privateKeyToAccount(generatePrivateKey());
    const n = await ctx.app.inject({ method: 'POST', url: '/api/wallet/nonce', headers: { cookie } });
    const message = n.json<{ message: string }>().message.replace('{address}', acct.address);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallet/link',
      headers: { cookie },
      payload: { address: acct.address, signature: await acct.signMessage({ message }), kind: 'external', connector: 'io.rabby' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<MeDTO>().wallets).toEqual([expect.objectContaining({ account: true, connector: 'io.rabby', kind: 'external' })]);
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallets/link',
      headers: { cookie },
      payload: { address: acct.address, signature: '0x00', connector: '<script>' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('serves every WALLET_ROUTES route', () => {
    const missing = Object.values(WALLET_ROUTES).filter((r) => {
      const [method, url] = r.split(' ') as ['GET' | 'POST' | 'PATCH' | 'DELETE', string];
      return !ctx.app.hasRoute({ method, url });
    });
    expect(missing).toEqual([]);
  });
});

describe('holdings across wallets', () => {
  it('a key split across two wallets opens the room, the Messages list, Following and the auto task', async () => {
    const creator = await member(ctx, 'splitcreator');
    const market = await openMarketRow(creator, 400n);
    await prisma.post.create({ data: { authorId: creator.user.id, text: 'holders only', visibility: 'holders' } });
    const { m, second } = await splitHolder('splitfan', market, 60n, 40n);

    const room = await ctx.app.inject({ url: '/api/users/splitcreator/room', headers: { cookie: m.cookie } });
    expect(room.json<RoomResponse>().access).toBe('open');
    const posted = await ctx.app.inject({
      method: 'POST',
      url: '/api/users/splitcreator/room',
      headers: { cookie: m.cookie },
      payload: { text: 'gm from two wallets' },
    });
    expect(posted.statusCode).toBe(200);

    const p = (await ctx.app.inject({ url: '/api/users/splitcreator', headers: { cookie: m.cookie } })).json<ProfileDTO>();
    expect(p.heldUnits).toBe('100');
    expect(p.heldBy).toEqual([
      { address: m.address, units: '60' },
      { address: second.address, units: '40' },
    ]);

    const holders = (await ctx.app.inject({ url: '/api/users/splitcreator/holders', headers: { cookie: m.cookie } })).json<HolderDTO[]>();
    expect(holders.filter((h) => h.handle === 'splitfan')).toEqual([expect.objectContaining({ units: '100', you: true })]);

    const msgs = (await ctx.app.inject({ url: '/api/messages', headers: { cookie: m.cookie } })).json<MessagesResponse>();
    expect(msgs.rooms.map((r) => r.with.handle)).toContain('splitcreator');

    const feed = (await ctx.app.inject({ url: '/api/feed?tab=following', headers: { cookie: m.cookie } })).json<{ posts: Array<{ text: string | null; locked: boolean }> }>();
    expect(feed.posts.find((x) => x.text === 'holders only')?.locked).toBe(false);

    const tasks = (await ctx.app.inject({ url: '/api/tasks', headers: { cookie: m.cookie } })).json<TasksResponse>();
    expect(tasks.tasks.find((t) => t.id === 'buykey')?.status).toBe('verified');

    // 99 units in total is not a key: locked again.
    ctx.chain.setKeys(market.subject, second.address, 39n);
    await ctx.app.access.invalidate(market.subject, second.address);
    expect((await ctx.app.inject({ url: '/api/users/splitcreator/room', headers: { cookie: m.cookie } })).json<RoomResponse>().access).toBe(
      'locked',
    );
  });

  it('GET /api/wallet sums every wallet and lists holdings per wallet with PnL; GET /api/wallets breaks it down', async () => {
    const creator = await member(ctx, 'pnlcreator');
    const market = await openMarketRow(creator, 400n);
    const { m, second } = await splitHolder('pnlfan', market, 120n, 80n);
    const mine = await openMarketRow(m);
    ctx.chain.eth.set(m.address, 10n ** 18n);
    ctx.chain.eth.set(second.address, 5n * 10n ** 17n);
    ctx.chain.claim = { creator: 3n, holder: 4n, referral: 5n, protocol: 0n };
    await prisma.earningsClaim.create({
      data: { address: second.address, creatorWei: 0, holderWei: 9, referralWei: 0, protocolWei: 0, txHash: '0xab', logIndex: 0, blockNumber: 1n, ts: new Date() },
    });

    const w = (await ctx.app.inject({ url: '/api/wallet', headers: { cookie: m.cookie } })).json<WalletDTO>();
    const v1 = quoteWei(400n, 'sell', 120n).total;
    const v2 = quoteWei(400n, 'sell', 80n).total;
    expect(w).toMatchObject({
      address: m.address,
      cashWei: (15n * 10n ** 17n).toString(),
      keysValueWei: (v1 + v2).toString(),
      keys: { units: '200', markets: 1 },
      earnings: { totalWei: '24', claimedWei: '9' },
    });
    expect(new Set(w.earnings.claimSubjects)).toEqual(new Set([market.subject, mine.subject]));
    expect(w.holdings).toEqual([
      expect.objectContaining({
        address: m.address,
        units: '120',
        valueWei: v1.toString(),
        costBasisWei: '1000',
        avgCostWei: ((1000n * 100n) / 120n).toString(),
        unrealizedPnlWei: (v1 - 1000n).toString(),
        realizedPnlWei: '0',
      }),
      expect.objectContaining({ address: second.address, units: '80', unrealizedPnlWei: (v2 - 500n).toString() }),
    ]);
    expect(w.wallets?.map((x) => [x.address, x.account, x.cashWei])).toEqual([
      [m.address, true, (10n ** 18n).toString()],
      [second.address, false, (5n * 10n ** 17n).toString()],
    ]);

    const list = (await ctx.app.inject({ url: '/api/wallets', headers: { cookie: m.cookie } })).json<WalletsResponse>();
    expect(list.maxLinked).toBe(MAX_LINKED_WALLETS);
    expect(list.wallets[1]).toMatchObject({
      address: second.address,
      connector: 'metaMask',
      keysValueWei: v2.toString(),
      keys: { units: '80', markets: 1 },
      earnings: { totalWei: '12', claimedWei: '9', claimSubjects: [market.subject] },
    });
    // Each wallet's claimable() is read with its own subjects.
    const reads = ctx.chain.calls.filter((c) => c.fn === 'claimable').map((c) => c.args[0]);
    expect(reads).toContain(second.address);
  });

  it('records payments and activity sent from a linked wallet', async () => {
    const { m, second } = await splitHolder('payer', await openMarketRow(await member(ctx, 'payee'), 200n), 0n, 0n);
    const tx = ctx.chain.addTx({ from: second.address, to: '0x000000000000000000000000000000000000dead', value: 5n, status: 'success' });
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallet/activity',
      headers: { cookie: m.cookie },
      payload: { label: 'Withdrawal to external wallet', amountWei: '-5', txHash: tx },
    });
    expect(ok.statusCode).toBe(200);
    // The dev faucet funds a linked wallet on request, but not a stranger's.
    const f = await ctx.app.inject({ method: 'POST', url: '/api/dev/faucet', headers: { cookie: m.cookie }, payload: { address: second.address } });
    expect(f.statusCode).toBe(200);
    expect(ctx.chain.calls.filter((c) => c.fn === 'sendEth').map((c) => c.args[0])).toContain(second.address);
    const stranger = await ctx.app.inject({
      method: 'POST',
      url: '/api/dev/faucet',
      headers: { cookie: m.cookie },
      payload: { address: '0x1111111111111111111111111111111111111111' },
    });
    expect(stranger.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ gas drip */

const TESTNET = { CHAIN_ID: '46630', GAS_DRIP_WEI: '200000000000000' };

/** A session that signed in through X (as the OAuth callback writes it). */
async function xSession(c: TestCtx, userId: string): Promise<string> {
  const sid = randomBytes(24).toString('base64url');
  await c.redis.set(
    `sess:${sid}`,
    JSON.stringify({ userId, x: { accessToken: 'x-token', expiresAt: Date.now() + 3_600_000 }, createdAt: Date.now() }),
    'EX',
    600,
  );
  return `sway_sid=${c.app.signCookie(sid)}`;
}

async function xMember(c: TestCtx, handle: string, data: { followers?: number; ageDays?: number; botFlag?: boolean } = {}) {
  const user = await prisma.user.create({
    data: {
      xId: String(1_000_000 + Math.floor(Math.random() * 1e9)),
      handle,
      name: handle,
      followers: data.followers ?? 500,
      xCreatedAt: new Date(Date.now() - (data.ageDays ?? 400) * 86_400_000),
      botFlag: data.botFlag ?? false,
      joinedAt: new Date(),
    },
  });
  return { user, cookie: await xSession(c, user.id) };
}

async function linkAccount(c: TestCtx, cookie: string) {
  const acct = privateKeyToAccount(generatePrivateKey());
  const n = await c.app.inject({ method: 'POST', url: '/api/wallet/nonce', headers: { cookie } });
  const message = n.json<{ message: string }>().message.replace('{address}', acct.address);
  const res = await c.app.inject({
    method: 'POST',
    url: '/api/wallet/link',
    headers: { cookie },
    payload: { address: acct.address, signature: await acct.signMessage({ message }), kind: 'embedded', connector: 'sway' },
  });
  expect(res.statusCode).toBe(200);
  return acct.address.toLowerCase();
}

/** The drip runs after the link response; wait for its Activity row to carry the tx hash. */
async function dripRow(userId: string) {
  for (let i = 0; i < 40; i++) {
    const row = await prisma.activity.findUnique({ where: { ref: `gasdrip:${userId}` } });
    if (row?.txHash) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('gas drip', () => {
  it('sends GAS_DRIP_WEI once to a qualifying X member’s account wallet on a real chain', async () => {
    const c = await makeApp({ env: TESTNET });
    try {
      const { user, cookie } = await xMember(c, 'realx');
      const address = await linkAccount(c, cookie);
      const row = await dripRow(user.id);
      expect(row).toMatchObject({ label: GAS_DRIP_LABEL, amountWei: expect.anything() });
      expect(row!.amountWei.toFixed(0)).toBe(TESTNET.GAS_DRIP_WEI);
      expect(row!.txHash).toMatch(/^0x/);
      expect(c.chain.calls.filter((x) => x.fn === 'sendEth')).toEqual([{ fn: 'sendEth', args: [address, BigInt(TESTNET.GAS_DRIP_WEI)] }]);
      const w = (await c.app.inject({ url: '/api/wallet', headers: { cookie } })).json<WalletDTO>();
      expect(w.activity.map((a) => a.label)).toContain(GAS_DRIP_LABEL);

      // Never twice, even if called again for the same member.
      const { maybeGasDrip } = await import('../src/services/wallets');
      const again = await maybeGasDrip(c.app.deps, user, address, { x: { accessToken: 't', expiresAt: 0 } } as never, c.app.log);
      expect(again).toEqual({ status: 'skipped', reason: 'already_sent' });
      expect(c.chain.calls.filter((x) => x.fn === 'sendEth')).toHaveLength(1);
    } finally {
      await c.close();
    }
  });

  it('skips dev sign-ins, young or small or flagged X accounts, local chains and GAS_DRIP_WEI=0', async () => {
    const c = await makeApp({ env: TESTNET });
    try {
      for (const [handle, data] of [
        ['youngx', { ageDays: 10 }],
        ['smallx', { followers: 49 }],
        ['botx', { botFlag: true }],
      ] as const) {
        const { user, cookie } = await xMember(c, handle, data);
        await linkAccount(c, cookie);
        await new Promise((r) => setTimeout(r, 60));
        expect(await prisma.activity.findUnique({ where: { ref: `gasdrip:${user.id}` } })).toBeNull();
      }
      const dev = await c.app.inject({ method: 'POST', url: '/api/auth/dev', payload: { handle: 'devuser', followers: 90000 } });
      const devCookie = `sway_sid=${dev.cookies.find((k) => k.name === 'sway_sid')!.value}`;
      await linkAccount(c, devCookie);
      await new Promise((r) => setTimeout(r, 60));
      expect(c.chain.calls.filter((x) => x.fn === 'sendEth')).toEqual([]);
    } finally {
      await c.close();
    }
    const cfg = (env: Record<string, string>) => makeApp({ env }).then(async (x) => (await x.close(), x.config));
    const user = { followers: 500, xCreatedAt: new Date(Date.now() - 400 * 86_400_000), botFlag: false };
    const xs = { x: { accessToken: 't', expiresAt: 0 } };
    expect(gasDripBlocker(await cfg(TESTNET), user, xs)).toBeNull();
    expect(gasDripBlocker(await cfg({ ...TESTNET, CHAIN_ID: '31337' }), user, xs)).toBe('local_chain');
    expect(gasDripBlocker(await cfg({ ...TESTNET, GAS_DRIP_WEI: '0' }), user, xs)).toBe('off');
    expect(gasDripBlocker(await cfg(TESTNET), user, { ...xs, dev: true })).toBe('not_x');
    expect(gasDripBlocker(await cfg(TESTNET), { ...user, xCreatedAt: null }, xs)).toBe('account_age');
  });
});
