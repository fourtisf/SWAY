import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { quoteWei, ethToWei } from '@sway/curve';
import { recoverTypedDataAddress } from 'viem';
import { MEMBER_PERMIT_TYPES, type MeDTO, type MemberPermit, type OnboardingStatus, type TradePermitsResponse, type WalletDTO } from '@sway/shared';
import {
  PERMIT_DOMAIN,
  fanMarket,
  FakeChain,
  login,
  makeApp,
  member,
  openMarketRow,
  prisma,
  resetState,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
beforeEach(async () => {
  await resetState(ctx.redis);
  ctx.chain.calls.length = 0;
});
afterAll(() => ctx.close());

async function link(
  cookie: string,
  pk = generatePrivateKey(),
  opts: { fill?: (m: string, a: string) => string; kind?: string } = {},
) {
  const account = privateKeyToAccount(pk);
  const n = await ctx.app.inject({ method: 'POST', url: '/api/wallet/nonce', headers: { cookie } });
  expect(n.statusCode).toBe(200);
  const { message } = n.json<{ nonce: string; message: string }>();
  expect(message).toContain('Address: {address}');
  const filled = (opts.fill ?? ((m, a) => m.replace('{address}', a)))(message, account.address);
  const signature = await account.signMessage({ message: filled });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/wallet/link',
    headers: { cookie },
    payload: { address: account.address, signature, kind: opts.kind ?? 'external' },
  });
  return { res, account };
}

describe('wallet link', () => {
  it('verifies the signature and links the wallet (lowercased)', async () => {
    const { cookie } = await login(ctx, 'walleter');
    const { res, account } = await link(cookie);
    expect(res.statusCode).toBe(200);
    const me = res.json<MeDTO>();
    expect(me.wallet).toEqual({ address: account.address.toLowerCase(), kind: 'external' });
    // Local chain + DEV_AUTH: the operator funds 0.75 ETH.
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.chain.calls.find((c) => c.fn === 'sendEth')?.args).toEqual([
      account.address.toLowerCase(),
      ethToWei('0.75'),
    ]);
  });

  it('accepts the message filled in by the server when address is sent to /nonce', async () => {
    const { cookie } = await login(ctx, 'prefill');
    const account = privateKeyToAccount(generatePrivateKey());
    const n = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallet/nonce',
      headers: { cookie },
      payload: { address: account.address },
    });
    const { message } = n.json<{ message: string }>();
    expect(message).toContain(`Address: ${account.address}`);
    expect(message).toContain('@prefill');
    const signature = await account.signMessage({ message });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallet/link',
      headers: { cookie },
      payload: { address: account.address, signature, kind: 'embedded' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a bad signature and a missing nonce', async () => {
    const { cookie } = await login(ctx, 'forger');
    const other = privateKeyToAccount(generatePrivateKey());
    const victim = privateKeyToAccount(generatePrivateKey());
    const n = await ctx.app.inject({ method: 'POST', url: '/api/wallet/nonce', headers: { cookie } });
    const message = n.json<{ message: string }>().message.replace('{address}', victim.address);
    const signature = await other.signMessage({ message });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallet/link',
      headers: { cookie },
      payload: { address: victim.address, signature, kind: 'external' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_signature');

    const { cookie: c2 } = await login(ctx, 'nononce');
    const sig2 = await victim.signMessage({ message: 'anything' });
    const r2 = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallet/link',
      headers: { cookie: c2 },
      payload: { address: victim.address, signature: sig2, kind: 'external' },
    });
    expect(r2.json().error).toBe('nonce_expired');
  });

  it('enforces one wallet per member and one member per wallet', async () => {
    const a = await login(ctx, 'memberone');
    const pk = generatePrivateKey();
    expect((await link(a.cookie, pk)).res.statusCode).toBe(200);
    // Same wallet again is idempotent; a second wallet is refused.
    expect((await link(a.cookie, pk)).res.statusCode).toBe(200);
    const second = await link(a.cookie);
    expect(second.res.statusCode).toBe(409);
    expect(second.res.json().error).toBe('wallet_exists');
    // Another member cannot take the same wallet.
    const b = await login(ctx, 'membertwo');
    const taken = await link(b.cookie, pk);
    expect(taken.res.statusCode).toBe(409);
    expect(taken.res.json().error).toBe('wallet_taken');
    expect(await prisma.wallet.count()).toBe(1);
  });
});

describe('onboarding (SPONSOR_ONBOARDING=1: the operator pays)', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await makeApp({ env: { SPONSOR_ONBOARDING: '1' } });
  });
  beforeEach(() => {
    ctx.chain.calls.length = 0;
  });
  afterAll(() => ctx.close());

  it('opens the member market through the operator and is idempotent', async () => {
    const m = await member(ctx, 'opener');
    const before = await ctx.app.inject({ url: '/api/onboarding', headers: { cookie: m.cookie } });
    expect(before.json<OnboardingStatus>()).toEqual({
      profile: true,
      engagement: true,
      scored: true,
      wallet: true,
      market: false,
      marketTx: null,
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/onboarding/market',
      headers: { cookie: m.cookie },
    });
    expect(res.statusCode).toBe(200);
    const st = res.json<OnboardingStatus>();
    expect(st.market).toBe(true);
    expect(st.marketTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ctx.chain.calls.filter((c) => c.fn === 'openMarket')).toEqual([
      { fn: 'openMarket', args: [m.address, BigInt(m.user.xId)] },
    ]);
    const row = await prisma.keyMarket.findUniqueOrThrow({ where: { userId: m.user.id } });
    expect(row).toMatchObject({
      subject: m.address,
      xId: m.user.xId,
      opened: true,
      claimed: true,
      fan: false,
      openTx: st.marketTx,
    });
    expect(row.openedAt).not.toBeNull();
    expect(await prisma.holding.findFirst({ where: { marketId: row.id } })).toMatchObject({
      address: m.address,
      units: 100n,
    });

    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/onboarding/market',
      headers: { cookie: m.cookie },
    });
    expect(again.json<OnboardingStatus>().market).toBe(true);
    expect(ctx.chain.calls.filter((c) => c.fn === 'openMarket')).toHaveLength(1);
    const me = await ctx.app.inject({ url: '/api/me', headers: { cookie: m.cookie } });
    expect(me.json<MeDTO>().market).toEqual({ subject: m.address, opened: true });
  });

  it('claims an unclaimed fan market instead of opening a new one', async () => {
    const { market } = await fanMarket('haloexchange', '424242');
    ctx.chain.markets.set(market.subject, {
      owner: '0x0000000000000000000000000000000000000000',
      xId: 424242n,
      fan: true,
      halted: false,
      supply: 300n,
    });
    const m = await member(ctx, 'haloexchange');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/onboarding/market',
      headers: { cookie: m.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.chain.calls.map((c) => c.fn)).toEqual(['claimFanMarket']);
    expect(ctx.chain.calls[0]!.args).toEqual([market.subject, m.address]);
    const row = await prisma.keyMarket.findUniqueOrThrow({ where: { id: market.id } });
    expect(row.claimed).toBe(true);
    expect(row.subject).toBe(market.subject);
    expect(res.json<OnboardingStatus>().market).toBe(true);
  });
});

describe('onboarding (default: signed permits, no operator transaction)', () => {
  it('makes the market a DB row and sends nothing', async () => {
    const m = await member(ctx, 'freejoin');
    const res = await ctx.app.inject({ method: 'POST', url: '/api/onboarding/market', headers: { cookie: m.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json<OnboardingStatus>()).toMatchObject({ market: true, marketTx: null });
    expect(ctx.chain.calls).toEqual([]);
    const row = await prisma.keyMarket.findUniqueOrThrow({ where: { userId: m.user.id } });
    expect(row).toMatchObject({ subject: m.address, opened: false, claimed: true, fan: false });
    expect(await prisma.holding.findFirst({ where: { marketId: row.id } })).toMatchObject({ address: m.address, units: 100n });
  });

  it('claims a fan market in the DB only; the claim goes onchain with a permit', async () => {
    const { market } = await fanMarket('fanjoin', '515151');
    const m = await member(ctx, 'fanjoin');
    const res = await ctx.app.inject({ method: 'POST', url: '/api/onboarding/market', headers: { cookie: m.cookie } });
    expect(res.json<OnboardingStatus>().market).toBe(true);
    expect(ctx.chain.calls).toEqual([]);
    expect(await prisma.keyMarket.findUniqueOrThrow({ where: { id: market.id } })).toMatchObject({ claimed: true, userId: m.user.id });
  });

  it('requires a wallet', async () => {
    const { cookie } = await login(ctx, 'nowallet');
    const res = await ctx.app.inject({ method: 'POST', url: '/api/onboarding/market', headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_wallet');
  });

  it('is a no-op onchain without SwayKeys (row only, market usable in dev)', async () => {
    const chain = new FakeChain();
    chain.keysEnabled = false;
    chain.operatorEnabled = false;
    const off = await makeApp({ chain, env: { SWAY_KEYS_ADDRESS: '' } });
    try {
      const m = await member(off, 'offline');
      const res = await off.app.inject({
        method: 'POST',
        url: '/api/onboarding/market',
        headers: { cookie: m.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<OnboardingStatus>()).toMatchObject({ market: true, marketTx: null });
      expect(chain.calls).toEqual([]);
      expect((await prisma.keyMarket.findUniqueOrThrow({ where: { userId: m.user.id } })).opened).toBe(false);
    } finally {
      await off.close();
    }
  });
});

describe('trade permits', () => {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const permits = async (m: { cookie: string }, subject: string, trader: string) => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/trade/permits', headers: { cookie: m.cookie }, payload: { subject, trader } });
    return { res, permits: res.statusCode === 200 ? res.json<TradePermitsResponse>().permits : [] };
  };
  const signer = (p: MemberPermit) =>
    recoverTypedDataAddress({
      domain: PERMIT_DOMAIN,
      types: MEMBER_PERMIT_TYPES,
      primaryType: 'Member',
      message: { wallet: p.wallet, xId: BigInt(p.xId), referrer: p.referrer, deadline: BigInt(p.deadline) },
      signature: p.signature,
    });
  const unopened = (m: { address: string; user: { id: string; xId: string } }) =>
    prisma.keyMarket.create({ data: { subject: m.address, userId: m.user.id, xId: m.user.xId, claimed: true, opened: false, supplyUnits: 100n, holders: 1 } });
  const credit = (inviter: { user: { id: string } }, invitee: { user: { id: string } }) =>
    prisma.referral.create({ data: { inviterId: inviter.user.id, inviteeId: invitee.user.id, status: 'credited', creditedAt: new Date() } });

  it('signs the creator’s open for the first buyer, then nothing once it is open', async () => {
    const creator = await member(ctx, 'unopened');
    const buyer = await member(ctx, 'firstbuyer');
    await unopened(creator);
    const { res, permits: ps } = await permits(buyer, creator.address, buyer.address);
    expect(res.statusCode).toBe(200);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ kind: 'open', wallet: creator.address, xId: creator.user.xId, referrer: ZERO });
    expect(ps[0]!.deadline).toBeGreaterThan(Date.now() / 1000 + 60);
    expect(await signer(ps[0]!)).toBe(ctx.chain.operator.address);
    expect(ctx.chain.calls.filter((c) => c.fn !== 'signMember')).toEqual([]);

    ctx.chain.markets.set(creator.address, { owner: creator.address, xId: BigInt(creator.user.xId), fan: false, halted: false, supply: 100n });
    expect((await permits(buyer, creator.address, buyer.address)).permits).toEqual([]);
  });

  it('carries the creator’s credited referrer, and the buyer’s own', async () => {
    const inviter = await member(ctx, 'inviter');
    const creator = await member(ctx, 'invitedcreator');
    const buyer = await member(ctx, 'invitedbuyer');
    await unopened(creator);
    await credit(inviter, creator);
    await credit(inviter, buyer);
    const { permits: ps } = await permits(buyer, creator.address, buyer.address);
    expect(ps.map((p) => [p.kind, p.wallet, p.xId, p.referrer])).toEqual([
      ['open', creator.address, creator.user.xId, inviter.address],
      ['referrer', buyer.address, '0', inviter.address],
    ]);
    // Set onchain: no permit, and remembered without another read.
    ctx.chain.referrers.set(buyer.address, inviter.address);
    ctx.chain.markets.set(creator.address, { owner: creator.address, xId: BigInt(creator.user.xId), fan: false, halted: false, supply: 100n });
    expect((await permits(buyer, creator.address, buyer.address)).permits).toEqual([]);
    expect(await ctx.redis.sismember('referrer:set', buyer.address)).toBe(1);
  });

  it('a pending referral signs nothing', async () => {
    const inviter = await member(ctx, 'inviter2');
    const buyer = await member(ctx, 'pendingbuyer');
    const creator = await member(ctx, 'opencreator');
    await openMarketRow(creator);
    ctx.chain.markets.set(creator.address, { owner: creator.address, xId: BigInt(creator.user.xId), fan: false, halted: false, supply: 100n });
    await prisma.referral.create({ data: { inviterId: inviter.user.id, inviteeId: buyer.user.id } });
    expect((await permits(buyer, creator.address, buyer.address)).permits).toEqual([]);
  });

  it('signs the claim of a fan market its X account claimed in the app', async () => {
    const { market } = await fanMarket('fanclaimer', '626262');
    ctx.chain.markets.set(market.subject, { owner: ZERO, xId: 626262n, fan: true, halted: false, supply: 300n });
    const owner = await member(ctx, 'fanclaimer');
    await ctx.app.inject({ method: 'POST', url: '/api/onboarding/market', headers: { cookie: owner.cookie } });
    const buyer = await member(ctx, 'fanbuyer');
    const { permits: ps } = await permits(buyer, market.subject, buyer.address);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ kind: 'claim', wallet: owner.address, xId: '626262', referrer: ZERO });
    expect(await signer(ps[0]!)).toBe(ctx.chain.operator.address);
  });

  it('only for the viewer’s own wallets', async () => {
    const creator = await member(ctx, 'someone');
    const buyer = await member(ctx, 'impostor');
    await unopened(creator);
    const { res } = await permits(buyer, creator.address, creator.address);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_your_wallet');
  });

  it('signs nothing when the operator sponsors onboarding', async () => {
    const sp = await makeApp({ env: { SPONSOR_ONBOARDING: '1' } });
    try {
      const creator = await member(sp, 'sponsoredc');
      const buyer = await member(sp, 'sponsoredb');
      await unopened(creator);
      const res = await sp.app.inject({ method: 'POST', url: '/api/trade/permits', headers: { cookie: buyer.cookie }, payload: { subject: creator.address, trader: buyer.address } });
      expect(res.json<TradePermitsResponse>().permits).toEqual([]);
    } finally {
      await sp.close();
    }
  });

  it('lists an unopened member market as buyable', async () => {
    const creator = await member(ctx, 'listedlazy');
    await unopened(creator);
    const res = await ctx.app.inject({ url: '/api/markets?tab=creators' });
    expect(JSON.stringify(res.json())).toContain(creator.address);
  });
});

describe('wallet page', () => {
  it('builds WalletDTO from the chain and the mirror, never from the client', async () => {
    const me = await member(ctx, 'holder');
    const myMarket = await openMarketRow(me);
    const creator = await member(ctx, 'creatorx');
    const cm = await openMarketRow(creator, 500n);
    await prisma.holding.createMany({
      data: [
        { marketId: cm.id, address: me.address, units: 250n },
        { marketId: myMarket.id, address: me.address, units: 100n },
      ],
    });
    ctx.chain.eth.set(me.address, 10n ** 18n);
    ctx.chain.claim = { creator: 5n, holder: 7n, referral: 11n, protocol: 999n };
    await prisma.earningsClaim.create({
      data: {
        address: me.address,
        creatorWei: 1,
        holderWei: 2,
        referralWei: 3,
        protocolWei: 0,
        txHash: '0xabc',
        logIndex: 0,
        blockNumber: 1n,
        ts: new Date(),
      },
    });
    await prisma.activity.create({
      data: { userId: me.user.id, label: 'Deposit', amountWei: '100', txHash: null },
    });

    const res = await ctx.app.inject({ url: '/api/wallet', headers: { cookie: me.cookie } });
    expect(res.statusCode).toBe(200);
    const w = res.json<WalletDTO>();
    const value = quoteWei(500n, 'sell', 250n).total.toString();
    expect(w).toMatchObject({
      address: me.address,
      kind: 'external',
      cashWei: (10n ** 18n).toString(),
      keysValueWei: value,
      keys: { units: '250', markets: 1 },
      earnings: { creatorWei: '5', holderWei: '7', referralWei: '11', totalWei: '23', claimedWei: '6' },
    });
    expect(w.holdings).toHaveLength(1);
    expect(w.holdings[0]).toMatchObject({
      units: '250',
      valueWei: value,
      market: { handle: 'creatorx', supplyUnits: '500' },
    });
    expect(new Set(w.earnings.claimSubjects)).toEqual(new Set([cm.subject, myMarket.subject]));
    expect(w.activity.map((a) => a.label)).toEqual(['Deposit']);
  });

  it('caps a holding’s value so the creator’s locked key is never counted', async () => {
    const me = await member(ctx, 'bigholder');
    const creator = await member(ctx, 'tinycreator');
    const cm = await openMarketRow(creator, 150n);
    await prisma.holding.create({ data: { marketId: cm.id, address: me.address, units: 50n } });
    const w = (
      await ctx.app.inject({ url: '/api/wallet', headers: { cookie: me.cookie } })
    ).json<WalletDTO>();
    expect(w.holdings[0]!.valueWei).toBe(quoteWei(150n, 'sell', 50n).total.toString());
  });

  it('records client activity only for transactions from the member’s wallet', async () => {
    const me = await member(ctx, 'withdrawer');
    const mine = ctx.chain.addTx({
      from: me.address,
      to: '0x000000000000000000000000000000000000dead',
      value: 5n,
      status: 'success',
    });
    const theirs = ctx.chain.addTx({
      from: '0x1111111111111111111111111111111111111111',
      to: me.address,
      value: 5n,
      status: 'success',
    });
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallet/activity',
      headers: { cookie: me.cookie },
      payload: { label: 'Withdrawal to external wallet', amountWei: '-5', txHash: mine },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      label: 'Withdrawal to external wallet',
      amountWei: '-5',
      txHash: mine,
    });
    const dup = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallet/activity',
      headers: { cookie: me.cookie },
      payload: { label: 'again', amountWei: '-5', txHash: mine },
    });
    expect(dup.json().id).toBe(ok.json().id);
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallet/activity',
      headers: { cookie: me.cookie },
      payload: { label: 'x', amountWei: '5', txHash: theirs },
    });
    expect(bad.json().error).toBe('tx_not_yours');
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/api/wallet/activity',
      headers: { cookie: me.cookie },
      payload: { label: 'x', amountWei: '5', txHash: '0x' + 'f'.repeat(64) },
    });
    expect(missing.json().error).toBe('tx_not_found');
  });

  it('dev faucet sends $100 worth on the local chain', async () => {
    const me = await member(ctx, 'faucetuser');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/dev/faucet',
      headers: { cookie: me.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().txHash).toMatch(/^0x/);
    const sent = ctx.chain.calls.find((c) => c.fn === 'sendEth')!.args[1] as bigint;
    expect(Number(sent) / 1e18).toBeCloseTo(100 / 3420, 9);
  });
});
