/**
 * Indexer against a real anvil chain and a real Postgres: deploys the contracts, trades through them,
 * indexes, checks the mirror matches packages/curve to the wei, then forces a reorg.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import type { Address } from 'viem';
import { priceWei, quoteWei } from '@sway/curve';
import { buildAirdrop, fanSubject } from '@sway/shared';
import { swayDropsAbi, swayKeysAbi, swayLaunchpadAbi } from '@sway/shared/abi';
import { privateKeyToAccount } from 'viem/accounts';
import { erc20Abi } from 'viem';
import { prisma, decToBig } from '@sway/db';
import { startChain, KEYS, type TestChain } from './anvil';
import { loadConfig } from '../src/config';
import { makeClients, type Clients } from '../src/clients';
import { Indexer } from '../src/indexer/indexer';
import { enforceActivityBond } from '../src/jobs/activity-bond';
import { syncReferrers } from '../src/jobs/referrals';

let chain: TestChain;
let c: Clients;
let indexer: Indexer;
let keys: Address;
const xAlice = 1001n;
const xFan = 5005n;

async function catchUp() {
  for (let i = 0; i < 20; i++) {
    const r = await indexer.tick();
    if (!r) return;
  }
}

async function buy(i: number, subject: Address, units: bigint) {
  const w = chain.wallet(i);
  const m = (await chain.pub.readContract({ address: keys, abi: swayKeysAbi, functionName: 'markets', args: [subject] })) as readonly unknown[];
  const q = quoteWei(m[6] as bigint, 'buy', units);
  const hash = await w.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'buy', args: [subject, units], value: q.total, chain: w.chain, account: w.account! });
  await chain.pub.waitForTransactionReceipt({ hash });
  return q;
}

beforeAll(async () => {
  chain = await startChain();
  keys = chain.deployment.swayKeys as Address;
  Object.assign(process.env, {
    CHAIN_ID: String(chain.chainId),
    RPC_URL: chain.rpcUrl,
    SWAY_KEYS_ADDRESS: chain.deployment.swayKeys,
    FAN_ESCROW_ADDRESS: chain.deployment.fanEscrow,
    SWAY_STAKING_ADDRESS: chain.deployment.swayStaking,
    GENESIS_PASS_ADDRESS: chain.deployment.genesisPass,
    LAUNCHPAD_ADDRESS: chain.deployment.launchpad,
    DROPS_ADDRESS: chain.deployment.drops,
    OPERATOR_PRIVATE_KEY: KEYS[0],
    INDEXER_START_BLOCK: '0',
    INDEXER_CONFIRMATIONS: '0',
  });
  c = makeClients(loadConfig(), new Redis('redis://localhost:6379/15'));
  indexer = new Indexer(c);

  const alice = chain.wallet(1);
  const bob = chain.wallet(2);
  const dave = chain.wallet(4);
  const mk = (handle: string, xId: bigint, wallet?: Address) =>
    prisma.user.create({
      data: {
        xId: xId.toString(), handle, name: handle[0]!.toUpperCase() + handle.slice(1), joinedAt: wallet ? new Date() : null,
        memberNo: wallet ? Number(xId) : null, wallet: wallet ? { create: { address: wallet.toLowerCase(), kind: 'embedded' } } : undefined,
      },
    });
  await mk('alice', xAlice, alice.address);
  await mk('bob', 2002n, bob.address);
  await mk('dave', 4004n, dave.address);
  const fanUser = await mk('orbitlabs', xFan);
  await prisma.keyMarket.create({ data: { subject: fanSubject(xFan).toLowerCase(), userId: fanUser.id, xId: xFan.toString(), fan: true, claimed: false, category: 'crypto' } });

  const op = chain.wallet(0);
  for (const [fn, args] of [['openMarket', [alice.address, xAlice]], ['openFanMarket', [xFan]]] as const) {
    const hash = await op.writeContract({ address: keys, abi: swayKeysAbi, functionName: fn, args: args as never, chain: op.chain, account: op.account! });
    await chain.pub.waitForTransactionReceipt({ hash });
  }
}, 180_000);

afterAll(async () => {
  chain?.stop();
  await c?.redis.quit();
  await prisma.$disconnect();
});

describe('indexer', () => {
  it('mirrors market opens, trades, holdings, fees, points and notifications', async () => {
    const alice = chain.wallet(1).address.toLowerCase();
    const bob = chain.wallet(2).address.toLowerCase();
    const q1 = await buy(2, alice as Address, 200n); // bob buys 2 keys of alice
    const fan = fanSubject(xFan);
    const q2 = await buy(3, fan, 150n); // a wallet with no Sway account buys a fan market
    await catchUp();

    const m = await prisma.keyMarket.findUniqueOrThrow({ where: { subject: alice } });
    expect(m.opened).toBe(true);
    expect(m.supplyUnits).toBe(300n);
    expect(decToBig(m.priceWei)).toBe(priceWei(300n));
    expect(decToBig(m.volumeWei)).toBe(q1.base);
    expect(decToBig(m.creatorFeesWei)).toBe(q1.creatorFee);
    expect(m.holders).toBe(2);

    const hb = await prisma.holding.findUniqueOrThrow({ where: { marketId_address: { marketId: m.id, address: bob } } });
    expect(hb.units).toBe(200n);
    expect(decToBig(hb.costBasisWei)).toBe(q1.total);
    const ha = await prisma.holding.findUniqueOrThrow({ where: { marketId_address: { marketId: m.id, address: alice } } });
    expect(ha.units).toBe(100n);

    const t = await prisma.trade.findFirstOrThrow({ where: { marketId: m.id } });
    expect(decToBig(t.totalWei)).toBe(q1.total);

    const bobUser = await prisma.user.findUniqueOrThrow({ where: { handle: 'bob' } });
    const pts = await prisma.pointsLedger.findMany({ where: { userId: bobUser.id, kind: 'trade_volume' } });
    expect(pts).toHaveLength(1);
    expect(pts[0]!.amount).toBe(Math.round((Number(q1.base) / 1e18) * 100_000));
    expect(await prisma.activity.count({ where: { userId: bobUser.id } })).toBe(1);
    const aliceUser = await prisma.user.findUniqueOrThrow({ where: { handle: 'alice' } });
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: aliceUser.id, type: 'trade' } });
    expect((n.body as Array<{ t: string }>)[0]!.t).toBe('Bob');

    const fm = await prisma.keyMarket.findUniqueOrThrow({ where: { subject: fan.toLowerCase() } });
    expect(fm.opened).toBe(true);
    expect(fm.category).toBe('crypto');
    expect(decToBig(fm.escrowWei)).toBe(q2.creatorFee);
    const lock = await prisma.holding.findUniqueOrThrow({ where: { marketId_address: { marketId: fm.id, address: String(chain.deployment.fanEscrow).toLowerCase() } } });
    expect(lock.units).toBe(100n);
  });

  it('rolls back a reorged trade and rebuilds the market', async () => {
    const alice = chain.wallet(1).address.toLowerCase() as Address;
    const bob = chain.wallet(2);
    const snap = await chain.test.snapshot();
    const hash = await bob.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'sell', args: [alice, 100n, 0n], chain: bob.chain, account: bob.account! });
    await chain.pub.waitForTransactionReceipt({ hash });
    await catchUp();
    const m = await prisma.keyMarket.findUniqueOrThrow({ where: { subject: alice } });
    expect(m.supplyUnits).toBe(200n);
    const bobUser = await prisma.user.findUniqueOrThrow({ where: { handle: 'bob' } });
    const before = await prisma.pointsLedger.aggregate({ where: { userId: bobUser.id }, _sum: { amount: true } });

    await chain.test.revert({ id: snap });
    await chain.test.mine({ blocks: 3 }); // a different chain at the same heights
    const r = await indexer.tick();
    expect(r?.reorgedTo).toBeDefined();
    await catchUp();

    const after = await prisma.keyMarket.findUniqueOrThrow({ where: { subject: alice } });
    expect(after.supplyUnits).toBe(300n);
    expect(await prisma.trade.count({ where: { txHash: hash } })).toBe(0);
    const hb = await prisma.holding.findUniqueOrThrow({ where: { marketId_address: { marketId: m.id, address: bob.address.toLowerCase() } } });
    expect(hb.units).toBe(200n);
    const sum = await prisma.pointsLedger.aggregate({ where: { userId: bobUser.id }, _sum: { amount: true } });
    expect(sum._sum.amount).toBeLessThan(before._sum.amount!);
    expect(await prisma.pointsLedger.count({ where: { userId: bobUser.id, kind: 'reorg_correction' } })).toBe(1);
  });

  it('hands a fan market to its owner on claim', async () => {
    const fan = fanSubject(xFan);
    const dave = chain.wallet(4).address;
    const op = chain.wallet(0);
    const hash = await op.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'claimFanMarket', args: [fan, dave], chain: op.chain, account: op.account! });
    await chain.pub.waitForTransactionReceipt({ hash });
    await catchUp();
    const fm = await prisma.keyMarket.findUniqueOrThrow({ where: { subject: fan.toLowerCase() } });
    expect(fm.claimed).toBe(true);
    expect(decToBig(fm.escrowWei)).toBe(0n);
    expect(decToBig(fm.creatorFeesWei)).toBeGreaterThan(0n);
    const h = await prisma.holding.findUniqueOrThrow({ where: { marketId_address: { marketId: fm.id, address: dave.toLowerCase() } } });
    expect(h.units).toBe(100n);
  });

  it('mirrors a token launch and curve trades', async () => {
    const pad = chain.deployment.launchpad as Address;
    const alice = chain.wallet(1);
    const bob = chain.wallet(2);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const root = '0x' + '00'.repeat(32);
    const digest = (await chain.pub.readContract({
      address: pad, abi: swayLaunchpadAbi, functionName: 'launchDigest',
      args: [alice.address, 'Alice', 'ALICE', 10n ** 18n, 20n * 10n ** 18n, root as `0x${string}`, deadline],
    })) as `0x${string}`;
    const signature = await privateKeyToAccount(KEYS[0]!).sign({ hash: digest });
    let hash = await alice.writeContract({
      address: pad, abi: swayLaunchpadAbi, functionName: 'launch',
      args: ['Alice', 'ALICE', 10n ** 18n, 20n * 10n ** 18n, root as `0x${string}`, deadline, signature], chain: alice.chain, account: alice.account!,
    });
    await chain.pub.waitForTransactionReceipt({ hash });
    const token = (await chain.pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'tokenOf', args: [alice.address] })) as Address;
    hash = await bob.writeContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'buy', args: [token, 0n], value: 10n ** 17n, chain: bob.chain, account: bob.account! });
    await chain.pub.waitForTransactionReceipt({ hash });
    await catchUp();

    const aliceUser = await prisma.user.findUniqueOrThrow({ where: { handle: 'alice' } });
    const lt = await prisma.launchToken.findUniqueOrThrow({ where: { userId: aliceUser.id } });
    expect(lt.tokenAddress).toBe(token.toLowerCase());
    expect(lt.symbol).toBe('ALICE');
    const curve = (await chain.pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'curves', args: [token] })) as readonly unknown[];
    expect(decToBig(lt.ethReserveWei)).toBe(curve[2] as bigint);
    expect(decToBig(lt.tokenReserve)).toBe(curve[3] as bigint);
    expect(decToBig(lt.creatorFeesWei)).toBe(10n ** 15n);
    const bobUser = await prisma.user.findUniqueOrThrow({ where: { handle: 'bob' } });
    const bal = (await chain.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [bob.address] })) as bigint;
    expect(bal).toBeGreaterThan(0n);
    expect(await prisma.activity.count({ where: { userId: bobUser.id, label: { contains: '$ALICE' } } })).toBe(1);
  });

  it('enforces the creator activity bond onchain and mirrors it', async () => {
    const alice = chain.wallet(1).address.toLowerCase();
    const later = new Date(Date.now() + 8 * 86400e3);
    const r1 = await enforceActivityBond(c, later);
    expect(r1.flagged).toBeGreaterThanOrEqual(1);
    expect(await chain.pub.readContract({ address: keys, abi: swayKeysAbi, functionName: 'creatorInactive', args: [alice as Address] })).toBe(true);
    await catchUp();
    const m = await prisma.keyMarket.findUniqueOrThrow({ where: { subject: alice } });
    expect(m.creatorInactive).toBe(true);
    const aliceUser = await prisma.user.findUniqueOrThrow({ where: { handle: 'alice' } });
    expect(await prisma.notification.count({ where: { userId: aliceUser.id, link: '/messages/room-alice' } })).toBe(1);

    await prisma.roomMessage.create({ data: { marketId: m.id, authorId: aliceUser.id, text: 'gm holders', createdAt: later } });
    const r2 = await enforceActivityBond(c, later);
    expect(r2.cleared).toBe(1);
    await catchUp();
    expect((await prisma.keyMarket.findUniqueOrThrow({ where: { subject: alice } })).creatorInactive).toBe(false);
  });
  it('mirrors a creator drop, its claims, and rolls a claim back on reorg', async () => {
    const drops = chain.deployment.drops as Address;
    const alice = chain.wallet(1);
    const aliceAddr = alice.address.toLowerCase();
    const market = await prisma.keyMarket.findUniqueOrThrow({ where: { subject: aliceAddr } });
    const aliceUser = await prisma.user.findUniqueOrThrow({ where: { handle: 'alice' } });
    const rows = await prisma.holding.findMany({ where: { marketId: market.id, units: { gt: 0n }, address: { not: aliceAddr } } });
    expect(rows.length).toBeGreaterThan(0);
    const total = 10n ** 16n;
    const tree = buildAirdrop(rows.map((h) => ({ address: h.address, units: h.units })), total);
    const members = new Map((await prisma.wallet.findMany()).map((w) => [w.address, w.userId]));
    await prisma.dropPlan.create({
      data: {
        root: tree.root.toLowerCase(), creatorId: aliceUser.id, totalWei: total.toString(), holders: tree.entries.length,
        allocations: {
          create: tree.entries.map((e) => ({
            address: e.address.toLowerCase(), userId: members.get(e.address.toLowerCase()) ?? null, amountWei: e.amount.toString(), proof: e.proof,
          })),
        },
      },
    });
    let hash = await alice.writeContract({ address: drops, abi: swayDropsAbi, functionName: 'create', args: [tree.root, 86_400n], value: total, chain: alice.chain, account: alice.account! });
    await chain.pub.waitForTransactionReceipt({ hash });
    await catchUp();
    const d = await prisma.creatorDrop.findUniqueOrThrow({ where: { id: 0 } });
    expect(d.root).toBe(tree.root.toLowerCase());
    expect(decToBig(d.totalWei)).toBe(total);
    const bob = chain.wallet(2);
    const bobUser = await prisma.user.findUniqueOrThrow({ where: { handle: 'bob' } });
    expect(await prisma.notification.count({ where: { userId: bobUser.id, fromUserId: aliceUser.id, link: '/wallet' } })).toBe(1);

    const mine = tree.entries.find((e) => e.address.toLowerCase() === bob.address.toLowerCase())!;
    const snap = await chain.test.snapshot();
    hash = await bob.writeContract({ address: drops, abi: swayDropsAbi, functionName: 'claim', args: [0n, mine.amount, mine.proof], chain: bob.chain, account: bob.account! });
    await chain.pub.waitForTransactionReceipt({ hash });
    await catchUp();
    const al = await prisma.dropAllocation.findUniqueOrThrow({ where: { root_address: { root: d.root, address: bob.address.toLowerCase() } } });
    expect(al.claimTx).toBe(hash);
    expect(decToBig((await prisma.creatorDrop.findUniqueOrThrow({ where: { id: 0 } })).claimedWei)).toBe(mine.amount);
    expect(await prisma.activity.count({ where: { userId: bobUser.id, txHash: hash } })).toBe(1);

    await chain.test.revert({ id: snap });
    await chain.test.mine({ blocks: 3 });
    expect((await indexer.tick())?.reorgedTo).toBeDefined();
    await catchUp();
    const back = await prisma.dropAllocation.findUniqueOrThrow({ where: { root_address: { root: d.root, address: bob.address.toLowerCase() } } });
    expect(back.claimTx).toBeNull();
    expect(decToBig((await prisma.creatorDrop.findUniqueOrThrow({ where: { id: 0 } })).claimedWei)).toBe(0n);
    expect(await prisma.activity.count({ where: { txHash: hash } })).toBe(0);
  });
  it('sets the referrer on every wallet of a credited invitee, linked ones included', async () => {
    const dave = await prisma.user.findUniqueOrThrow({ where: { handle: 'dave' }, include: { wallet: true } });
    const bob = await prisma.user.findUniqueOrThrow({ where: { handle: 'bob' }, include: { wallet: true } });
    const linked = '0x00000000000000000000000000000000000b0b02';
    await prisma.linkedWallet.create({ data: { userId: bob.id, address: linked, kind: 'external' } });
    await prisma.referral.create({ data: { inviterId: dave.id, inviteeId: bob.id, status: 'credited', creditedAt: new Date() } });
    await c.redis.del('referrer:set');
    expect(await syncReferrers(c)).toBe(2);
    for (const a of [bob.wallet!.address, linked]) {
      expect(String(await chain.pub.readContract({ address: keys, abi: swayKeysAbi, functionName: 'referrerOf', args: [a as Address] })).toLowerCase()).toBe(dave.wallet!.address);
    }
    expect((await prisma.referral.findUniqueOrThrow({ where: { inviteeId: bob.id } })).onchainTx).toMatch(/^0x/);
    expect(await syncReferrers(c)).toBe(0);
  });
});
