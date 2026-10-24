/**
 * The wallet audit against a real anvil chain, the real indexer and a stand-in explorer built from the chain itself
 * (blocks + call traces): three wallets of one person fund from outside, trade one of their keys among themselves,
 * claim and withdraw. Every wallet's balance must match its history, and the trades must account for the ETH.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { quoteWei } from '@sway/curve';
import { swayChain } from '@sway/shared';
import { swayKeysAbi } from '@sway/shared/abi';
import { prisma } from '@sway/db';
import { startChain, KEYS, type TestChain } from './anvil';
import { loadConfig } from '../src/config';
import { makeClients, type Clients } from '../src/clients';
import { Indexer } from '../src/indexer/indexer';
import { auditWallet, sum4, totals, type AuditContext, type ExplorerTx, type TxSource } from '../src/audit';

let chain: TestChain;
let c: Clients;
let keys: Address;
const lc = (a: string) => a.toLowerCase();

type Call = { from: string; to?: string; value?: Hex; calls?: Call[]; error?: string };
/** What Blockscout's txlist / txlistinternal would list, read straight off the chain. */
async function chainExplorer(): Promise<TxSource> {
  const normal: ExplorerTx[] = [];
  const internal: ExplorerTx[] = [];
  const head = await chain.pub.getBlockNumber({ cacheTime: 0 });
  for (let n = 0n; n <= head; n++) {
    const b = await chain.pub.getBlock({ blockNumber: n, includeTransactions: true });
    for (const tx of b.transactions) {
      const rc = await chain.pub.getTransactionReceipt({ hash: tx.hash });
      const isError = rc.status === 'success' ? '0' : '1';
      normal.push({ from: tx.from, to: tx.to ?? '', value: tx.value.toString(), gasUsed: rc.gasUsed.toString(), gasPrice: rc.effectiveGasPrice.toString(), isError, input: tx.input });
      const trace = (await chain.pub.request({ method: 'debug_traceTransaction', params: [tx.hash, { tracer: 'callTracer' }] } as never)) as Call;
      const walk = (calls: Call[] | undefined) => {
        for (const k of calls ?? []) {
          if (k.value && BigInt(k.value) > 0n) internal.push({ from: k.from, to: k.to ?? '', value: BigInt(k.value).toString(), isError: k.error ? '1' : '0' });
          walk(k.calls);
        }
      };
      walk(trace.calls);
    }
  }
  return async (address) => {
    const a = lc(address);
    const mine = (t: ExplorerTx) => lc(t.from) === a || lc(t.to) === a;
    return { normal: normal.filter(mine), internal: internal.filter(mine) };
  };
}

async function catchUp(indexer: Indexer) {
  for (let i = 0; i < 20; i++) if (!(await indexer.tick())) return;
}

beforeAll(async () => {
  // Its own port: the indexer test's anvil on :8547 may still be shutting down.
  chain = await startChain(8548);
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
  // A fresh chain: earlier files' cursor points at blocks that no longer exist.
  await prisma.indexerCursor.deleteMany();
  await prisma.indexedBlock.deleteMany();
  c = makeClients(loadConfig(), new Redis('redis://localhost:6379/15'));
}, 180_000);

afterAll(async () => {
  chain?.stop();
  await c?.redis.quit();
  await prisma.$disconnect();
});

describe('wallet audit', () => {
  it('reconciles deposits, trades, fees and claims across one person’s wallets', async () => {
    const viemChain = swayChain({ chainId: chain.chainId, rpcUrl: chain.rpcUrl });
    const mk = () => {
      const account = privateKeyToAccount(generatePrivateKey());
      return Object.assign(createWalletClient({ chain: viemChain, account, transport: http(chain.rpcUrl) }), { address: account.address });
    };
    const [a, b, d] = [mk(), mk(), mk()];
    const funder = chain.wallet(5);
    const send = async (w: { sendTransaction: (req: never) => Promise<Hex> }, to: Address, value: bigint) =>
      chain.pub.waitForTransactionReceipt({ hash: await w.sendTransaction({ to, value, chain: viemChain } as never) });
    for (const w of [a, b, d]) await send(funder, w.address, parseEther('1'));

    const user = await prisma.user.create({
      data: { xId: '880001', handle: 'audited', name: 'Audited', joinedAt: new Date(), memberNo: 880001, wallet: { create: { address: lc(a.address), kind: 'embedded' } } },
    });
    for (const w of [b, d]) await prisma.linkedWallet.create({ data: { userId: user.id, address: lc(w.address) } });
    const e = mk(); // another member's wallet
    await prisma.user.create({ data: { xId: '880002', handle: 'friend', name: 'Friend', wallet: { create: { address: lc(e.address), kind: 'embedded' } } } });
    const op = chain.wallet(0);
    await chain.pub.waitForTransactionReceipt({
      hash: await op.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'openMarket', args: [a.address, 880001n], chain: op.chain, account: op.account! }),
    });

    let supply = 100n;
    const fees = { creator: 0n, holder: 0n, referral: 0n, protocol: 0n };
    const trade = async (w: ReturnType<typeof mk>, side: 'buy' | 'sell', units: bigint) => {
      const q = quoteWei(supply, side, units);
      const args = side === 'buy' ? ([a.address, units] as const) : ([a.address, units, 0n] as const);
      const hash = await w.writeContract({ address: keys, abi: swayKeysAbi, functionName: side, args: args as never, value: side === 'buy' ? q.total : undefined, chain: viemChain, account: w.account! } as never);
      await chain.pub.waitForTransactionReceipt({ hash });
      supply += side === 'buy' ? units : -units;
      return q;
    };
    await trade(b, 'buy', 500n);
    await trade(d, 'buy', 300n);
    await trade(b, 'sell', 500n); // within 24h of buying: the anti-dump fee applies
    await trade(d, 'sell', 200n);
    await chain.pub.waitForTransactionReceipt({
      hash: await a.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'claim', args: [[a.address]], chain: viemChain, account: a.account! }),
    });
    await send(a, funder.address, parseEther('0.1'));
    await send(b, e.address, parseEther('0.05'));
    await send(d, a.address, parseEther('0.02'));

    const indexer = new Indexer(c);
    await catchUp(indexer);
    const rows = await prisma.trade.findMany({ where: { trader: { in: [b, d].map((w) => lc(w.address)) } } });
    expect(rows).toHaveLength(4);
    for (const t of rows) {
      fees.creator += BigInt(t.creatorFeeWei.toFixed());
      fees.holder += BigInt(t.holderFeeWei.toFixed());
      fees.referral += BigInt(t.referralFeeWei.toFixed());
      fees.protocol += BigInt(t.protocolFeeWei.toFixed());
    }

    const owners = new Map([a, b, d].map((w) => [lc(w.address), '@audited'] as [string, string]));
    const ctx: AuditContext = {
      prisma, pub: chain.pub as never, keys, owners, ownSubjects: new Set([lc(a.address)]), operator: lc(op.address), swayContracts: new Map(), members: new Map([...owners, [lc(e.address), '@friend']]), txs: await chainExplorer(),
    };
    const reports = [];
    for (const w of [a, b, d]) reports.push(await auditWallet(ctx, w.address));
    const [ra, rb, rd] = reports as [(typeof reports)[0], (typeof reports)[0], (typeof reports)[0]];

    for (const r of reports) {
      expect(r.explorerOk).toBe(true);
      expect(r.depositsIn).toBe(parseEther('1'));
      expect(r.balance).toBe(r.expectedBalance);
      expect(r.gas).toBeGreaterThan(0n);
    }
    expect(ra.withdrawnOut).toBe(parseEther('0.1'));
    expect(ra.others).toEqual([{ address: lc(funder.address), in: parseEther('1'), out: parseEther('0.1') }]);
    expect(rb.others).toEqual([
      { address: lc(funder.address), in: parseEther('1'), out: 0n },
      { address: lc(e.address), in: 0n, out: parseEther('0.05') },
    ]);
    expect(rb.toMembers).toBe(parseEther('0.05'));
    expect([ra.fromOwn, rd.toOwn]).toEqual([parseEther('0.02'), parseEther('0.02')]);
    // What each wallet's own transactions did, named from Sway's ABIs.
    expect(rb.actions.map((x) => [x.action, x.count]).sort()).toEqual([['ETH to other members', 1], ['SwayKeys.buy', 1], ['SwayKeys.sell', 1]]);
    expect(rb.actions.reduce((s, x) => s + x.gas, 0n)).toBe(rb.gas);
    expect(ra.actions.map((x) => [x.action, x.count, x.value]).sort()).toEqual([['ETH to outside addresses', 1, parseEther('0.1')], ['SwayKeys.claim', 1, 0n]]);
    expect(rb.buys + rb.sells + rd.buys + rd.sells).toBe(4);
    expect(rb.toKeysContract).toBe(rb.paid);
    expect(rb.fromKeysContract).toBe(rb.received);
    // A's market belongs to the same person: every creator fee comes back to them.
    expect(rb.creatorFeesToOwn + rd.creatorFeesToOwn).toBe(fees.creator);
    expect(rb.creatorFeesToOthers + rd.creatorFeesToOthers).toBe(0n);
    expect(sum4(ra.claimed)).toBe(ra.fromKeysContract);
    expect(ra.claimed.creator + ra.claimable.creator).toBe(fees.creator);
    // D still holds 100 units: their sell value is counted, A's locked first key is not.
    expect(rd.keysValue).toBe(quoteWei(supply, 'sell', 100n).total);
    expect(ra.keysValue).toBe(0n);

    const t = totals(reports);
    expect(t.deposits).toBe(parseEther('3'));
    expect(t.withdrawals).toBe(parseEther('0.1'));
    expect(t.toMembers).toBe(parseEther('0.05'));
    expect(t.fromOwn).toBe(t.toOwn);
    expect(t.fees).toEqual(fees);
    // Holders here are all the same person, so the holder fees come back too (less per-unit rounding dust).
    expect(t.holderRewardsEarned).toBeLessThanOrEqual(fees.holder);
    expect(fees.holder - t.holderRewardsEarned).toBeLessThan(10_000n);
    // ETH that left the wallets and didn't come back is exactly what the trades kept: paid − received − claimed.
    expect(t.deposits - t.withdrawals - t.toMembers - t.gas - t.balance).toBe(t.paid - t.received - t.claimed);
    expect(t.net).toBe(t.balance + t.claimable + t.keysValue - t.deposits + t.withdrawals + t.toMembers);
    // Apart from gas, what the person is down is the fees that left them (protocol, unreferred referral halves,
    // rounding dust) plus the fees a sale of the keys still held would pay.
    const held = quoteWei(supply, 'sell', 100n);
    expect(-(t.net! + t.gas)).toBe(fees.protocol + fees.referral + (fees.holder - t.holderRewardsEarned) + (held.base - held.total));
  });
});
