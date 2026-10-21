/**
 * [C] Launchpad attestation + key-holder airdrop, token views, airdrop claims, staking, dev faucet $SWAY and the
 * frozen Genesis list, against a fake LaunchChain. launch-anvil.test.ts runs the same flow on a real chain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { hashTypedData, recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { usdToWei } from '@sway/curve';
import { dec } from '@sway/db';
import {
  DEV_FAUCET_SWAY,
  LAUNCH_HOLDER_ALLOCATION,
  LAUNCH_TYPES,
  STAKING_COOLDOWN_S,
  airdropLeaf,
  launchDomain,
  launchInitialCurve,
  launchMarketCap,
  verifyMerkleProof,
  type Address,
  type AirdropsResponse,
  type GenesisListResponse,
  type GenesisResponse,
  type LaunchAttestation,
  type LaunchTokenResponse,
  type LaunchpadResponse,
  type StakingResponse,
} from '@sway/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { MemoryJobQueue } from '../src/services/jobs';
import { resetOfficialCache } from '../src/services/notify';
import { resetPriceMemo } from '../src/services/price';
import type { OperatorTxResult } from '../src/services/chain';
import type { LaunchChain, LaunchMessage, OnchainCurve, OnchainStaking } from '../src/services/launch-chain';
import {
  FakeChain,
  TEST_ENV,
  fakeHash,
  login,
  member,
  openMarketRow,
  prisma,
  resetState,
  type Member,
  type TestCtx,
} from './helpers';

const OPERATOR_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const OPERATOR = privateKeyToAccount(OPERATOR_KEY).address.toLowerCase() as Address;
const PAD = '0x5fc8d32690cc91d4c39d9d3abcbd16989f875707' as Address;
const STK = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9' as Address;
const SWAY = '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0' as Address;
const E18 = 10n ** 18n;

class FakeLaunchChain implements LaunchChain {
  launchpad: Address | null = PAD;
  staking: Address | null = STK;
  launchEnabled = true;
  stakingEnabled = true;
  signerAddr: Address = OPERATOR;
  readonly tokens = new Map<string, Address>();
  readonly curves = new Map<string, OnchainCurve>();
  readonly fees = new Map<string, bigint>();
  readonly claimed = new Set<string>();
  readonly erc20 = new Map<string, bigint>();
  readonly sent: Array<{ to: Address; amount: bigint }> = [];
  stake: OnchainStaking = {
    token: SWAY,
    balance: 0n,
    allowance: 0n,
    staked: 0n,
    unstaking: 0n,
    unlockAt: 0,
    level: 0,
    thresholds: [1_000n * E18, 10_000n * E18, 50_000n * E18, 250_000n * E18],
    pendingRewards: 0n,
    totalStaked: 0n,
    blockTime: 0,
  };
  stakingReads: Array<Address | null> = [];

  async signer() {
    return this.signerAddr;
  }
  async launchDigest(m: LaunchMessage) {
    return hashTypedData({
      domain: launchDomain(31337, PAD),
      types: LAUNCH_TYPES,
      primaryType: 'Launch',
      message: m,
    });
  }
  async tokenOf(creator: Address) {
    return this.tokens.get(creator.toLowerCase()) ?? null;
  }
  async curve(token: Address) {
    return this.curves.get(token.toLowerCase()) ?? null;
  }
  async pairOf() {
    return null;
  }
  async creatorFees(creator: Address) {
    return this.fees.get(creator.toLowerCase()) ?? 0n;
  }
  async airdropClaimed(token: Address, account: Address) {
    return this.claimed.has(`${token}:${account}`.toLowerCase());
  }
  async tokenBalances(token: Address, owners: Address[]) {
    return owners.map((o) => ({
      balance: this.erc20.get(`${token}:${o}`.toLowerCase()) ?? 0n,
      allowance: 0n,
    }));
  }
  async stakingState(account: Address | null) {
    this.stakingReads.push(account);
    return account
      ? this.stake
      : {
          ...this.stake,
          balance: 0n,
          allowance: 0n,
          staked: 0n,
          unstaking: 0n,
          unlockAt: 0,
          level: 0,
          pendingRewards: 0n,
        };
  }
  async sendSway(to: Address, amount: bigint): Promise<OperatorTxResult> {
    this.sent.push({ to, amount });
    return { hash: fakeHash(), status: 'success' };
  }
  /** Simulates SwayLaunchpad.launch for `creator` with the stored attestation. */
  launch(creator: Address, token: Address, startCapWei: bigint, graduationCapWei: bigint, airdropRoot: Hex) {
    this.tokens.set(creator.toLowerCase(), token);
    this.curves.set(token.toLowerCase(), {
      creator,
      ...launchInitialCurve(startCapWei),
      graduationCapWei,
      airdropRoot,
      graduated: false,
      migrated: false,
    });
  }
}

let ctx: TestCtx;
let lc: FakeLaunchChain;
beforeAll(async () => {
  const config = loadConfig({
    ...TEST_ENV,
    OPERATOR_PRIVATE_KEY: OPERATOR_KEY,
    LAUNCHPAD_ADDRESS: PAD,
    SWAY_STAKING_ADDRESS: STK,
    EXPLORER_URL: 'https://explorer.test',
  });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  const chain = new FakeChain();
  const jobs = new MemoryJobQueue();
  lc = new FakeLaunchChain();
  resetOfficialCache();
  resetPriceMemo();
  const app = await buildApp({ config, prisma, redis, chain, jobs, launchChain: lc });
  await app.ready();
  ctx = {
    app,
    chain,
    jobs,
    redis,
    config,
    async close() {
      await app.close();
      redis.disconnect();
    },
  };
});
beforeEach(async () => {
  await resetState(ctx.redis);
  lc.tokens.clear();
  lc.curves.clear();
  lc.claimed.clear();
  lc.erc20.clear();
  lc.sent.length = 0;
  lc.signerAddr = OPERATOR;
});
afterAll(() => ctx.close());

const get = <T>(url: string, cookie?: string) =>
  ctx.app
    .inject({ url, headers: cookie ? { cookie } : {} })
    .then((r) => ({ status: r.statusCode, body: r.json<T>() }));
const post = <T>(url: string, cookie: string, payload?: unknown) =>
  ctx.app
    .inject({ method: 'POST', url, headers: { cookie }, payload: payload as object })
    .then((r) => ({ status: r.statusCode, body: r.json<T>() }));

/** Creator with an opened market and holders mirrored the way the indexer writes them. */
async function creatorWithHolders(holders: Array<[Member, bigint]>, ownUnits = 100n) {
  const c = await member(ctx, 'novareyes', 41000);
  const m = await openMarketRow(c, ownUnits + holders.reduce((s, [, u]) => s + u, 0n));
  await prisma.holding.create({ data: { marketId: m.id, address: c.address, units: ownUnits } });
  for (const [h, u] of holders)
    await prisma.holding.create({ data: { marketId: m.id, address: h.address, units: u } });
  return { c, m };
}

describe('POST /api/launchpad/attest', () => {
  it('refuses without a wallet, without a market, once launched, and when the signer differs', async () => {
    const guest = await ctx.app.inject({ method: 'POST', url: '/api/launchpad/attest' });
    expect(guest.statusCode).toBe(401);
    const { cookie } = await login(ctx, 'nowallet');
    expect((await post<{ error: string }>('/api/launchpad/attest', cookie)).body.error).toBe('no_wallet');
    const noMarket = await member(ctx, 'nomarket');
    expect((await post<{ error: string }>('/api/launchpad/attest', noMarket.cookie)).body.error).toBe(
      'no_market',
    );

    const { c } = await creatorWithHolders([]);
    lc.signerAddr = '0x000000000000000000000000000000000000dead';
    const bad = await post<{ error: string; message: string }>('/api/launchpad/attest', c.cookie);
    expect(bad.status).toBe(503);
    expect(bad.body.error).toBe('signer_mismatch');
    lc.signerAddr = OPERATOR;

    expect((await post('/api/launchpad/attest', c.cookie)).status).toBe(200);
    // Launched onchain (indexer not caught up yet): refused from the tokenOf read.
    lc.tokens.set(c.address, '0x00000000000000000000000000000000000000aa');
    expect((await post<{ error: string }>('/api/launchpad/attest', c.cookie)).body.error).toBe(
      'already_launched',
    );
    lc.tokens.clear();
    // Mirrored by the indexer: refused from the LaunchToken row.
    await prisma.launchToken.update({
      where: { userId: c.user.id },
      data: { tokenAddress: '0x00000000000000000000000000000000000000aa' },
    });
    const again = await post<{ error: string }>('/api/launchpad/attest', c.cookie);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_launched');
  });

  it('a market nobody has bought yet comes with the creator’s open permit', async () => {
    const c = await member(ctx, 'lazylauncher', 41000);
    await prisma.keyMarket.create({ data: { subject: c.address, userId: c.user.id, xId: c.user.xId, claimed: true, opened: false, supplyUnits: 100n, holders: 1 } });
    const a = (await post<LaunchAttestation>('/api/launchpad/attest', c.cookie)).body;
    expect(a.permit).toMatchObject({ kind: 'open', wallet: c.address, xId: c.user.xId });
    const { c: opened } = await creatorWithHolders([]);
    expect((await post<LaunchAttestation>('/api/launchpad/attest', opened.cookie)).body.permit).toBeNull();
  });

  it('the creator picks the name and ticker; bad, reserved and taken tickers are refused', async () => {
    const { c } = await creatorWithHolders([]);
    const a = (await post<LaunchAttestation>('/api/launchpad/attest', c.cookie, { name: ' Nova Coin ', symbol: '$nova' })).body;
    expect(a).toMatchObject({ name: 'Nova Coin', symbol: 'NOVA' });
    expect(await prisma.launchToken.findUniqueOrThrow({ where: { userId: c.user.id } })).toMatchObject({ name: 'Nova Coin', symbol: 'NOVA' });
    // Comes back prefilled until launch.
    expect((await get<LaunchpadResponse>('/api/launchpad', c.cookie)).body.terms).toMatchObject({ name: 'Nova Coin', symbol: 'NOVA' });

    const err = async (payload: object) => {
      const r = await post<{ error: string }>('/api/launchpad/attest', c.cookie, payload);
      return [r.status, r.body.error];
    };
    expect(await err({ symbol: 'A' })).toEqual([400, 'bad_symbol']);
    expect(await err({ symbol: 'NO-DASH' })).toEqual([400, 'bad_symbol']);
    expect(await err({ symbol: 'SWAY' })).toEqual([400, 'bad_symbol']);
    expect(await err({ name: 'x'.repeat(40) })).toEqual([400, 'bad_name']);
    const other = await member(ctx, 'tickerowner');
    await prisma.launchToken.create({
      data: { userId: other.user.id, name: 'Taken', symbol: 'TAKEN', tokenAddress: '0x00000000000000000000000000000000000000bb' },
    });
    expect(await err({ symbol: 'taken' })).toEqual([409, 'symbol_taken']);
    // The official account may use the reserved ticker.
    await prisma.user.update({ where: { id: c.user.id }, data: { official: true } });
    expect((await post<LaunchAttestation>('/api/launchpad/attest', c.cookie, { symbol: 'SWAY' })).body.symbol).toBe('SWAY');
  });

  it('creator only: the whole 10% goes to the account wallet', async () => {
    const { c } = await creatorWithHolders([]);
    const a = (await post<LaunchAttestation>('/api/launchpad/attest', c.cookie)).body;
    expect(a.holders).toBe(0);
    expect(a.creator).toBe(c.address);
    const rows = await prisma.launchAirdrop.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe(c.address);
    expect(rows[0]!.amount.toFixed(0)).toBe(LAUNCH_HOLDER_ALLOCATION.toString());
    // One leaf: the root is the leaf and the proof is empty.
    expect(a.airdropRoot).toBe(airdropLeaf(c.address, LAUNCH_HOLDER_ALLOCATION));
    expect(rows[0]!.proof).toEqual([]);
  });

  it('holders: pro rata to keys held, the locked first key excluded; sums to the allocation; proofs verify', async () => {
    const bob = await member(ctx, 'bob');
    const carol = await member(ctx, 'carol');
    const { c } = await creatorWithHolders(
      [
        [bob, 300n],
        [carol, 100n],
      ],
      150n, // locked key + half a key the creator bought back
    );
    // A linked wallet of carol's also holds keys: its own leaf.
    const carolLinked = privateKeyToAccount(
      '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    ).address.toLowerCase();
    await prisma.linkedWallet.create({ data: { userId: carol.user.id, address: carolLinked } });
    const m = await prisma.keyMarket.findFirstOrThrow({ where: { userId: c.user.id } });
    await prisma.holding.create({ data: { marketId: m.id, address: carolLinked, units: 50n } });
    await prisma.holding.create({
      data: { marketId: m.id, address: '0x00000000000000000000000000000000000000ee', units: 0n },
    });

    const preview = (await get<LaunchpadResponse>('/api/launchpad', c.cookie)).body;
    expect(preview.terms!.creatorOnly).toBe(false);
    expect(preview.terms!.holders.map((h) => [h.user?.handle ?? null, h.units])).toEqual([
      ['bob', '300'],
      ['carol', '100'],
      ['novareyes', '50'],
      ['carol', '50'],
    ]);
    expect(preview.terms!.symbol).toBe('NOVAREYES');
    expect(preview.terms!.startCapUsd).toBe(2000 + c.user.score * 60);
    expect(preview.terms!.startCapWei).toBe(usdToWei(2000 + c.user.score * 60, 3420).toString());
    expect(preview.terms!.graduationCapWei).toBe(usdToWei(69_000, 3420).toString());
    expect(preview.terms!.holders.reduce((s, h) => s + h.sharePct, 0)).toBeCloseTo(100, 3);

    const res = await post<LaunchAttestation>('/api/launchpad/attest', c.cookie);
    expect(res.status).toBe(200);
    const a = res.body;
    expect(a.holders).toBe(4);
    const rows = await prisma.launchAirdrop.findMany();
    const by = new Map(rows.map((r) => [r.address, BigInt(r.amount.toFixed(0))]));
    expect(rows.reduce((s, r) => s + BigInt(r.amount.toFixed(0)), 0n)).toBe(LAUNCH_HOLDER_ALLOCATION);
    expect(by.get(bob.address)).toBe((LAUNCH_HOLDER_ALLOCATION * 300n) / 500n);
    expect(by.get(carol.address)).toBe((LAUNCH_HOLDER_ALLOCATION * 100n) / 500n);
    expect(by.get(c.address)).toBe((LAUNCH_HOLDER_ALLOCATION * 50n) / 500n);
    expect(by.has('0x00000000000000000000000000000000000000ee')).toBe(false);
    for (const r of rows)
      expect(
        verifyMerkleProof(
          a.airdropRoot,
          airdropLeaf(r.address, BigInt(r.amount.toFixed(0))),
          r.proof as Hex[],
        ),
      ).toBe(true);
    const lt = await prisma.launchToken.findUniqueOrThrow({ where: { userId: c.user.id } });
    expect(lt).toMatchObject({
      symbol: 'NOVAREYES',
      name: c.user.name,
      airdropRoot: a.airdropRoot,
      tokenAddress: null,
    });
    expect(lt.startCapWei!.toFixed(0)).toBe(a.startCapWei);

    // Re-attesting replaces the leaves (not launched yet), it never duplicates them.
    await prisma.holding.updateMany({ where: { address: bob.address }, data: { units: 400n } });
    const b = (await post<LaunchAttestation>('/api/launchpad/attest', c.cookie)).body;
    expect(b.airdropRoot).not.toBe(a.airdropRoot);
    expect(await prisma.launchAirdrop.count()).toBe(4);
  });

  it('signs the EIP-712 Launch struct with the operator key: recovers to the operator, digest = launchDigest', async () => {
    const bob = await member(ctx, 'bob');
    const { c } = await creatorWithHolders([[bob, 200n]]);
    const before = Math.floor(Date.now() / 1000);
    const a = (await post<LaunchAttestation>('/api/launchpad/attest', c.cookie)).body;
    expect(a.launchpad).toBe(PAD);
    expect(a.deadline).toBeGreaterThanOrEqual(before + 30 * 60);
    expect(a.deadline).toBeLessThanOrEqual(before + 30 * 60 + 5);
    const message: LaunchMessage = {
      creator: c.address,
      name: a.name,
      symbol: a.symbol,
      startCapWei: BigInt(a.startCapWei),
      graduationCapWei: BigInt(a.graduationCapWei),
      airdropRoot: a.airdropRoot,
      deadline: BigInt(a.deadline),
    };
    const domain = launchDomain(31337, PAD);
    const signer = await recoverTypedDataAddress({
      domain,
      types: LAUNCH_TYPES,
      primaryType: 'Launch',
      message,
      signature: a.signature,
    });
    expect(signer.toLowerCase()).toBe(OPERATOR);
    expect(hashTypedData({ domain, types: LAUNCH_TYPES, primaryType: 'Launch', message })).toBe(
      await lc.launchDigest(message),
    );
    expect(BigInt(a.graduationCapWei) > BigInt(a.startCapWei)).toBe(true);
  });
});

describe('launched tokens and airdrops', () => {
  it('GET /api/launchpad shows the token (tokenOf fallback before the indexer), any creator at /tokens/:handle', async () => {
    const bob = await member(ctx, 'bob');
    const { c } = await creatorWithHolders([[bob, 200n]]);
    const a = (await post<LaunchAttestation>('/api/launchpad/attest', c.cookie)).body;
    const token = '0x00000000000000000000000000000000000000aa' as Address;
    lc.launch(c.address, token, BigInt(a.startCapWei), BigInt(a.graduationCapWei), a.airdropRoot);
    lc.fees.set(c.address, 12345n);
    lc.erc20.set(`${token}:${c.address}`, 7n * E18);

    const lp = (await get<LaunchpadResponse>('/api/launchpad', c.cookie)).body;
    expect(lp.launched).toBe(true);
    expect(lp.tokenAddress).toBe(token);
    expect(lp.terms).toBeUndefined();
    const t = lp.token!;
    expect(t).toMatchObject({
      address: token,
      symbol: 'NOVAREYES',
      creatorAddress: c.address,
      creatorFeesWei: '12345',
      graduated: false,
      isMine: true,
      source: 'chain',
      explorer: `https://explorer.test/token/${token}`,
      startCapWei: a.startCapWei,
      graduationCapWei: a.graduationCapWei,
    });
    expect(t.marketCapWei).toBe(launchMarketCap(launchInitialCurve(BigInt(a.startCapWei))).toString());
    expect(t.progress).toBe(0);
    expect(t.balances).toEqual([{ address: c.address, balance: (7n * E18).toString(), allowance: '0' }]);

    const pub = (await get<LaunchTokenResponse>('/api/launchpad/tokens/novareyes')).body;
    expect(pub).toMatchObject({ symbol: '$NOVAREYES', launched: true, creator: { handle: 'novareyes' } });
    expect(pub.token!.isMine).toBe(false);
    expect(pub.token!.balances).toEqual([]);
    const asBob = (await get<LaunchTokenResponse>('/api/launchpad/tokens/novareyes', bob.cookie)).body;
    expect(asBob.token!.balances.map((b) => b.address)).toEqual([bob.address]);
    expect((await get<LaunchTokenResponse>('/api/launchpad/tokens/bob')).body).toMatchObject({
      launched: false,
      token: null,
      symbol: '$BOB',
    });
    expect((await get('/api/launchpad/tokens/nobody')).status).toBe(404);

    // Chain unreachable: the indexer's mirror answers.
    const curve = lc.curve.bind(lc);
    lc.curve = async () => {
      throw new Error('rpc down');
    };
    await prisma.launchToken.update({
      where: { userId: c.user.id },
      data: {
        tokenAddress: token,
        ethReserveWei: dec(0),
        tokenReserve: dec(900_000_000n * E18),
        launchedAt: new Date(),
      },
    });
    const mirror = (await get<LaunchpadResponse>('/api/launchpad', c.cookie)).body.token!;
    expect(mirror.source).toBe('mirror');
    expect(mirror.marketCapWei).toBe(t.marketCapWei);
    lc.curve = curve;
  });

  it('GET /api/launchpad/airdrops: unclaimed allocations across account and linked wallets, launched only', async () => {
    const bob = await member(ctx, 'bob');
    const bobLinked = '0x00000000000000000000000000000000000000b2';
    await prisma.linkedWallet.create({ data: { userId: bob.user.id, address: bobLinked } });
    const { c, m } = await creatorWithHolders([[bob, 200n]]);
    await prisma.holding.create({ data: { marketId: m.id, address: bobLinked, units: 100n } });
    const a = (await post<LaunchAttestation>('/api/launchpad/attest', c.cookie)).body;

    // Attested, not launched: nothing to claim yet.
    expect((await get<AirdropsResponse>('/api/launchpad/airdrops', bob.cookie)).body.allocations).toEqual([]);
    const token = '0x00000000000000000000000000000000000000aa' as Address;
    lc.launch(c.address, token, BigInt(a.startCapWei), BigInt(a.graduationCapWei), a.airdropRoot);

    const r = (await get<AirdropsResponse>('/api/launchpad/airdrops', bob.cookie)).body;
    expect(r.launchpad).toBe(PAD);
    expect(r.allocations.map((x) => [x.address, x.walletKind, x.symbol, x.creator.handle])).toEqual(
      expect.arrayContaining([
        [bob.address, 'account', 'NOVAREYES', 'novareyes'],
        [bobLinked, 'linked', 'NOVAREYES', 'novareyes'],
      ]),
    );
    expect(r.allocations).toHaveLength(2);
    const mine = r.allocations.find((x) => x.address === bob.address)!;
    // Floored pro rata; the 1 wei remainder goes to the largest holder.
    expect(mine.amount).toBe(((LAUNCH_HOLDER_ALLOCATION * 200n) / 300n + 1n).toString());
    expect(verifyMerkleProof(a.airdropRoot, airdropLeaf(bob.address, BigInt(mine.amount)), mine.proof)).toBe(
      true,
    );

    // Claimed onchain: gone before the indexer mirrors claimTx; mirrored claimTx hides it too.
    lc.claimed.add(`${token}:${bob.address}`);
    expect(
      (await get<AirdropsResponse>('/api/launchpad/airdrops', bob.cookie)).body.allocations.map(
        (x) => x.address,
      ),
    ).toEqual([bobLinked]);
    await prisma.launchAirdrop.updateMany({ where: { address: bobLinked }, data: { claimTx: fakeHash() } });
    expect((await get<AirdropsResponse>('/api/launchpad/airdrops', bob.cookie)).body.allocations).toEqual([]);
    // Guests and the creator (nothing left for them here).
    expect((await get<AirdropsResponse>('/api/launchpad/airdrops')).body.allocations).toEqual([]);
  });

  it('hides leaves of a stale attestation whose root differs from the onchain root', async () => {
    const bob = await member(ctx, 'bob');
    const { c } = await creatorWithHolders([[bob, 200n]]);
    const a = (await post<LaunchAttestation>('/api/launchpad/attest', c.cookie)).body;
    lc.launch(
      c.address,
      '0x00000000000000000000000000000000000000aa',
      BigInt(a.startCapWei),
      BigInt(a.graduationCapWei),
      `0x${'11'.repeat(32)}`,
    );
    expect((await get<AirdropsResponse>('/api/launchpad/airdrops', bob.cookie)).body.allocations).toEqual([]);
  });
});

describe('GET /api/staking', () => {
  it('reads the viewer’s account wallet: balance, stake, level, thresholds, cooldown, rewards', async () => {
    const guest = (await get<StakingResponse>('/api/staking')).body;
    expect(guest).toMatchObject({
      enabled: true,
      address: null,
      stakedWei: '0',
      level: 0,
      stakingAddress: STK,
      tokenAddress: SWAY,
    });
    expect(guest.levels.map((l) => [l.level, l.name, l.cut, l.thresholdWei, l.postMax])).toEqual([
      [1, 'Beat', 0.1, (1_000n * E18).toString(), 2000],
      [2, 'Rhythm', 0.25, (10_000n * E18).toString(), 2000],
      [3, 'Tempo', 0.5, (50_000n * E18).toString(), 2000],
      [4, 'Crescendo', 0.75, (250_000n * E18).toString(), 2000],
    ]);
    const bob = await member(ctx, 'bob');
    const unlock = Math.floor(Date.now() / 1000) + STAKING_COOLDOWN_S;
    lc.stake = {
      ...lc.stake,
      balance: 9_000n * E18,
      allowance: 0n,
      staked: 1_000n * E18,
      unstaking: 500n * E18,
      unlockAt: unlock,
      level: 1,
      pendingRewards: 42n,
      totalStaked: 1_000n * E18,
    };
    const s = (await get<StakingResponse>('/api/staking', bob.cookie)).body;
    expect(lc.stakingReads.at(-1)).toBe(bob.address);
    expect(s).toMatchObject({
      enabled: true,
      address: bob.address,
      balanceWei: (9_000n * E18).toString(),
      stakedWei: (1_000n * E18).toString(),
      unstakingWei: (500n * E18).toString(),
      unlockAt: new Date(unlock * 1000).toISOString(),
      canWithdraw: false,
      level: 1,
      pendingRewardsWei: '42',
      totalStakedWei: (1_000n * E18).toString(),
      cooldownSeconds: 7 * 86400,
    });
    lc.stake = { ...lc.stake, unlockAt: Math.floor(Date.now() / 1000) - 1 };
    expect((await get<StakingResponse>('/api/staking', bob.cookie)).body.canWithdraw).toBe(true);
  });

  it('degrades to the placeholder thresholds when the chain is unreachable', async () => {
    const read = lc.stakingState.bind(lc);
    lc.stakingState = async () => {
      throw new Error('rpc down');
    };
    const s = (await get<StakingResponse>('/api/staking')).body;
    expect(s.enabled).toBe(false);
    expect(s.levels[0]!.thresholdWei).toBe((1_000n * E18).toString());
    lc.stakingState = read;
  });
});

describe('dev faucet', () => {
  it('also sends 10,000 $SWAY to the account wallet', async () => {
    const bob = await member(ctx, 'bob');
    const r = await post<{ txHash: string; swayTxHash?: string }>('/api/dev/faucet', bob.cookie);
    expect(r.status).toBe(200);
    expect(r.body.swayTxHash).toMatch(/^0x/);
    expect(lc.sent).toEqual([{ to: bob.address, amount: DEV_FAUCET_SWAY }]);
    expect(ctx.chain.calls.find((c) => c.fn === 'sendEth')?.args[0]).toBe(bob.address);
  });
});

describe('Genesis snapshot list', () => {
  async function snapshot(takenAt: Date) {
    const a = await member(ctx, 'gen1');
    const b = await member(ctx, 'gen2');
    const pool = 1_000n * E18;
    const snap = await prisma.genesisSnapshot.create({
      data: { takenAt, listHash: `0x${'ab'.repeat(32)}`, poolUnits: dec(pool), published: true },
    });
    await prisma.genesisEntry.createMany({
      data: [
        {
          snapshotId: snap.id,
          rank: 1,
          userId: b.user.id,
          points: 90000,
          wallet: b.address,
          units: dec(600n * E18),
          mintTx: fakeHash(),
        },
        {
          snapshotId: snap.id,
          rank: 2,
          userId: a.user.id,
          points: 50000,
          wallet: a.address,
          units: dec(400n * E18),
        },
      ],
    });
    return { a, b, snap };
  }

  it('404 before the freeze, then the frozen ranked list by latest and by id', async () => {
    expect((await get<{ error: string }>('/api/genesis/snapshots/latest')).body.error).toBe('no_snapshot');
    expect((await get<{ error: string }>('/api/genesis/snapshots/nope')).status).toBe(404);
    const { a, b, snap } = await snapshot(new Date(Date.now() - 60_000));
    const l = (await get<GenesisListResponse>('/api/genesis/snapshots/latest', a.cookie)).body;
    expect(l).toMatchObject({
      snapshotId: snap.id,
      listHash: snap.listHash,
      count: 2,
      minted: 1,
      published: true,
      poolUnits: (1_000n * E18).toString(),
    });
    expect(
      l.rows.map((r) => [r.rank, r.user.handle, r.points, r.sharePct, r.minted, r.me, r.walletShort]),
    ).toEqual([
      [1, 'gen2', 90000, 60, true, false, `${b.address.slice(0, 6)}…${b.address.slice(-4)}`],
      [2, 'gen1', 50000, 40, false, true, `${a.address.slice(0, 6)}…${a.address.slice(-4)}`],
    ]);
    expect(l.rows[0]!.units).toBe((600n * E18).toString());
    expect((await get<GenesisListResponse>(`/api/genesis/snapshots/${snap.id}`)).body.rows).toHaveLength(2);
  });

  it('GenesisResponse once frozen: snapshot id, list hash, me and top from the snapshot', async () => {
    const { a, snap } = await snapshot(new Date(Date.now() - 60_000));
    const g = (await get<GenesisResponse>('/api/genesis', a.cookie)).body;
    expect(g).toMatchObject({
      frozen: true,
      snapshotId: snap.id,
      listHash: snap.listHash,
      snapshotAt: snap.takenAt.toISOString(),
    });
    expect(g.me).toMatchObject({ rank: 2, points: 50000, inCut: true, sharePct: 40 });
    expect(g.top.map((r) => [r.rank, r.user.handle, r.sharePct])).toEqual([
      [1, 'gen2', 60],
      [2, 'gen1', 40],
    ]);
    const outsider = await member(ctx, 'outsider');
    expect((await get<GenesisResponse>('/api/genesis', outsider.cookie)).body.me).toMatchObject({
      inCut: false,
      rank: 0,
    });
  });
});
