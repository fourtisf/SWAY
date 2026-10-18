/**
 * Local demo only: opens key markets on anvil for the seeded members and fan accounts and trades keys
 * up to the prototype's supplies, so the indexer mirrors real events. Run after
 * `pnpm db:seed` and `bash scripts/deploy-local.sh`, with the workers running (or run them afterwards;
 * the indexer catches up). Refuses any chain but 31337.
 *
 * Wallet keys are derived from keccak256("sway-dev:<handle>"): public and insecure by design.
 */
import { createTestClient, http, keccak256, parseEther, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient } from 'viem';
import { quoteWei } from '@sway/curve';
import { fanSubject, hash, LOCAL_CHAIN_ID } from '@sway/shared';
import { swayKeysAbi } from '@sway/shared/abi';
import { addr, prisma } from '@sway/db';
import { demoCreators, demoFans, demoLeaderboard, rng } from '@sway/db/demo';
import { loadConfig } from '../config';
import { makeClients } from '../clients';

const devKey = (handle: string): Hex => keccak256(toBytes(`sway-dev:${handle}`));

async function main() {
  const cfg = loadConfig();
  if (cfg.chainId !== LOCAL_CHAIN_ID) throw new Error(`seed-chain only runs on the local chain (${LOCAL_CHAIN_ID}), not ${cfg.chainId}`);
  const keys = cfg.contracts.swayKeys;
  if (!keys || !cfg.operatorKey) throw new Error('SWAY_KEYS_ADDRESS and OPERATOR_PRIVATE_KEY are required (run scripts/deploy-local.sh)');
  const c = makeClients(cfg);
  const test = createTestClient({ chain: c.chain, mode: 'anvil', transport: http(cfg.rpcUrl) });
  const op = c.operator!;
  const wallet = (handle: string) => createWalletClient({ chain: c.chain, transport: http(cfg.rpcUrl), account: privateKeyToAccount(devKey(handle)) });

  const ensureWallet = async (handle: string) => {
    const w = wallet(handle);
    const user = await prisma.user.findUnique({ where: { handle }, include: { wallet: true } });
    if (user && !user.wallet && user.joinedAt) {
      await prisma.wallet.create({ data: { userId: user.id, address: addr(w.account.address), kind: 'embedded' } });
    }
    await test.setBalance({ address: w.account.address, value: parseEther('50') });
    return w;
  };

  const readSupply = async (subject: Address) =>
    ((await c.pub.readContract({ address: keys, abi: swayKeysAbi, functionName: 'markets', args: [subject] })) as readonly unknown[])[6] as bigint;

  // 1. open markets
  const creators = demoCreators();
  const fans = demoFans();
  const markets: Array<{ subject: Address; target: bigint; holders: number; seed: string }> = [];
  for (const cr of creators) {
    const w = await ensureWallet(cr.handle);
    const subject = w.account.address;
    if ((await readSupply(subject)) === 0n) {
      const h = await op.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'openMarket', args: [subject, BigInt(cr.xId)] });
      await c.pub.waitForTransactionReceipt({ hash: h });
    }
    markets.push({ subject, target: BigInt(Math.round(cr.supply * 100)), holders: cr.holders, seed: cr.handle });
  }
  for (const f of fans) {
    const subject = fanSubject(f.xId);
    if ((await readSupply(subject)) === 0n) {
      const h = await op.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'openFanMarket', args: [BigInt(f.xId)] });
      await c.pub.waitForTransactionReceipt({ hash: h });
    }
    markets.push({ subject, target: BigInt(Math.round(f.supply * 100)), holders: Math.max(1, f.holders), seed: f.handle });
  }
  console.log(`opened ${markets.length} markets`);

  // 2. buyers: leaderboard members who aren't creators
  const buyers = [];
  for (const row of demoLeaderboard().filter((r) => !r.creator).slice(0, 30)) buyers.push(await ensureWallet(row.handle));

  // 3. one small first trade per market, then skip past the 5-minute anti-snipe window
  for (const m of markets) {
    const supply = await readSupply(m.subject);
    if (supply !== 100n || m.target <= 100n) continue;
    const b = buyers[hash(m.seed) % buyers.length]!;
    const q = quoteWei(supply, 'buy', 1n);
    const h = await b.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'buy', args: [m.subject, 1n], value: q.total });
    await c.pub.waitForTransactionReceipt({ hash: h });
  }
  await test.increaseTime({ seconds: 400 });
  await test.mine({ blocks: 1 });

  // 4. spread the rest of each market's supply over its holders, with a few sells for price history
  const pending: Hex[] = [];
  for (const m of markets) {
    let supply = await readSupply(m.subject);
    if (supply >= m.target) continue;
    const r = rng(hash(m.seed + 'chain'));
    const n = Math.max(1, Math.min(buyers.length, m.holders - 1));
    let left = m.target - supply;
    for (let i = 0; i < n && left > 0n; i++) {
      const units = i === n - 1 ? left : BigInt(Math.max(1, Math.round(Number(left) * (0.2 + r() * 0.5))));
      const u = units > left ? left : units;
      const b = buyers[(hash(m.seed) + i) % buyers.length]!;
      const q = quoteWei(supply, 'buy', u);
      pending.push(await b.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'buy', args: [m.subject, u], value: (q.total * 3n) / 2n }));
      supply += u;
      left -= u;
      if (r() < 0.3 && u > 20n) {
        const sell = u / 4n;
        pending.push(await b.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'sell', args: [m.subject, sell, 0n] }));
        const back = quoteWei(supply - sell, 'buy', sell);
        pending.push(await b.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'buy', args: [m.subject, sell], value: (back.total * 3n) / 2n }));
      }
    }
  }
  let failed = 0;
  let total = pending.length;
  const settle = async () => {
    for (const h of pending.splice(0)) {
      const rcpt = await c.pub.waitForTransactionReceipt({ hash: h });
      if (rcpt.status !== 'success') failed++;
    }
  };
  await settle();

  // 5. churn: two dozen small round trips around the target so "change over the last 24 trades" reads
  //    like a market at equilibrium (a few percent either way) instead of the whole run-up.
  for (const m of markets) {
    if (m.target <= 150n) continue;
    const r = rng(hash(m.seed + 'churn'));
    const trader = buyers[(hash(m.seed) + 1) % buyers.length]!;
    let supply = await readSupply(m.subject);
    let held = 0n; // what the churner bought here beyond its earlier holdings
    const size = () => 1n + BigInt(Math.floor(r() * Math.max(1, Number(m.target) * 0.02)));
    for (let i = 0; i < 13; i++) {
      const u = size();
      const q = quoteWei(supply, 'buy', u);
      pending.push(await trader.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'buy', args: [m.subject, u], value: (q.total * 3n) / 2n }));
      const drift = (size() / 2n) * (r() < 0.5 ? 1n : -1n);
      let sell = u + drift;
      if (sell > held + u) sell = held + u;
      if (sell < 1n) sell = 1n;
      pending.push(await trader.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'sell', args: [m.subject, sell, 0n] }));
      held += u - sell;
      supply += u - sell;
      total += 2;
    }
  }
  await settle();
  console.log(`sent ${total} trades (${failed} reverted); the indexer will mirror them`);
  await prisma.$disconnect();
  c.redis.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
