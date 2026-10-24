/**
 * Read-only audit of wallets (scripts/audit.ts prints it): where their ETH came from and went, what their key
 * trades cost, which fees went where, and what is still waiting to be claimed. Money in and out comes from the
 * explorer (Blockscout's account API: normal and internal transactions), trades and claims from the indexer's
 * mirror, claimable earnings and balances from the chain.
 */
import { quoteWei } from '@sway/curve';
import type { prisma as Prisma } from '@sway/db';
import { parseAbi, type Address, type PublicClient } from 'viem';

export const KEYS_ABI = parseAbi([
  'function claimable(address account, address[] subjects) view returns (uint256 creator, uint256 holder, uint256 referral, uint256 protocol)',
  'function treasury() view returns (address)',
  'function staking() view returns (address)',
  'function referrerOf(address user) view returns (address)',
]);
const LOCKED = 100n;
const lc = (a: string) => a.toLowerCase();
const big = (d: unknown) => BigInt(String(d ?? 0).split('.')[0] || '0');

/** One transaction as Blockscout's etherscan-style account API lists it. */
export interface ExplorerTx {
  from: string;
  to: string;
  value: string;
  gasUsed?: string;
  gasPrice?: string;
  isError?: string;
}
/** Normal and internal transactions of an address, or null when the explorer can't be read. */
export type TxSource = (address: string) => Promise<{ normal: ExplorerTx[]; internal: ExplorerTx[] } | null>;

export function blockscout(explorer: string): TxSource {
  const base = explorer.replace(/\/$/, '');
  const get = async (url: string): Promise<{ result?: ExplorerTx[] | string } | null> => {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (r.ok) return (await r.json()) as { result?: ExplorerTx[] | string };
      } catch {
        /* retry */
      }
      await new Promise((ok) => setTimeout(ok, 1500));
    }
    return null;
  };
  const list = async (address: string, action: string): Promise<ExplorerTx[] | null> => {
    const out: ExplorerTx[] = [];
    for (let page = 1; page <= 20; page++) {
      const body = await get(`${base}/api?module=account&action=${action}&address=${address}&sort=asc&page=${page}&offset=1000`);
      if (!body) return null;
      const rows = Array.isArray(body.result) ? body.result : [];
      out.push(...rows);
      if (rows.length < 1000) break;
      await new Promise((ok) => setTimeout(ok, 250));
    }
    return out;
  };
  return async (address) => {
    const [normal, internal] = await Promise.all([list(address, 'txlist'), list(address, 'txlistinternal')]);
    return normal && internal ? { normal, internal } : null;
  };
}

type Four = { creator: bigint; holder: bigint; referral: bigint; protocol: bigint };
const four = (): Four => ({ creator: 0n, holder: 0n, referral: 0n, protocol: 0n });
export const sum4 = (f: Four) => f.creator + f.holder + f.referral + f.protocol;

export interface WalletReport {
  address: string;
  owner: string;
  explorerOk: boolean;
  /** ETH from addresses outside the audited set (and not Sway's own contracts). */
  depositsIn: bigint;
  fromOperator: bigint;
  fromOwn: bigint;
  fromKeysContract: bigint;
  fromOtherSway: bigint;
  withdrawnOut: bigint;
  toOwn: bigint;
  toKeysContract: bigint;
  toOtherSway: bigint;
  gas: bigint;
  /** What the history adds up to; equals `balance` when every movement was found. */
  expectedBalance: bigint;
  balance: bigint;
  buys: number;
  paid: bigint;
  sells: number;
  received: bigint;
  fees: Four;
  creatorFeesToOwn: bigint;
  creatorFeesToOthers: bigint;
  claimed: Four;
  claimable: Four;
  keysValue: bigint;
  referrer: string | null;
  /** Outside addresses this wallet sent ETH to or got ETH from (bridges, exchanges, Pons…), biggest first. */
  others: Array<{ address: string; in: bigint; out: bigint }>;
}

export interface AuditContext {
  prisma: typeof Prisma;
  pub: PublicClient;
  keys: Address;
  /** Every audited wallet → its label (@handle). Transfers between them count as moves, not deposits. */
  owners: Map<string, string>;
  operator: string | null;
  /** Sway's other contracts (launchpad, staking…), lowercase. */
  swayContracts: Set<string>;
  txs: TxSource | null;
}

export async function auditWallet(ctx: AuditContext, address: string): Promise<WalletReport> {
  const a = lc(address);
  const keys = lc(ctx.keys);
  const own = (x: string) => ctx.owners.has(x);
  const r: WalletReport = {
    address: a,
    owner: ctx.owners.get(a) ?? '',
    explorerOk: false,
    depositsIn: 0n, fromOperator: 0n, fromOwn: 0n, fromKeysContract: 0n, fromOtherSway: 0n,
    withdrawnOut: 0n, toOwn: 0n, toKeysContract: 0n, toOtherSway: 0n, gas: 0n, expectedBalance: 0n,
    balance: await ctx.pub.getBalance({ address: a as Address }),
    buys: 0, paid: 0n, sells: 0, received: 0n, fees: four(), creatorFeesToOwn: 0n, creatorFeesToOthers: 0n,
    claimed: four(), claimable: four(), keysValue: 0n, referrer: null, others: [],
  };
  const others = new Map<string, { address: string; in: bigint; out: bigint }>();
  const other = (x: string) => others.get(x) ?? others.set(x, { address: x, in: 0n, out: 0n }).get(x)!;

  const h = ctx.txs ? await ctx.txs(a) : null;
  if (h) {
    r.explorerOk = true;
    for (const t of h.normal) {
      const from = lc(t.from || ''), to = lc(t.to || ''), v = t.isError === '1' ? 0n : BigInt(t.value || '0');
      if (from === a) {
        r.gas += BigInt(t.gasUsed || '0') * BigInt(t.gasPrice || '0');
        if (to === a) continue;
        if (to === keys) r.toKeysContract += v;
        else if (ctx.swayContracts.has(to)) r.toOtherSway += v;
        else if (own(to)) r.toOwn += v;
        else if (v > 0n) {
          r.withdrawnOut += v;
          other(to).out += v;
        }
      } else if (to === a) {
        if (own(from)) r.fromOwn += v;
        else if (from === ctx.operator) r.fromOperator += v;
        else if (v > 0n) {
          r.depositsIn += v;
          other(from).in += v;
        }
      }
    }
    for (const t of h.internal) {
      if (lc(t.to || '') !== a || t.isError === '1') continue;
      const from = lc(t.from || ''), v = BigInt(t.value || '0');
      if (from === keys) r.fromKeysContract += v;
      else if (ctx.swayContracts.has(from)) r.fromOtherSway += v;
      else if (own(from)) r.fromOwn += v;
      else if (v > 0n) {
        r.depositsIn += v;
        other(from).in += v;
      }
    }
    r.others = [...others.values()].sort((x, y) => (y.in + y.out > x.in + x.out ? 1 : -1));
    r.expectedBalance =
      r.depositsIn + r.fromOperator + r.fromOwn + r.fromKeysContract + r.fromOtherSway - r.withdrawnOut - r.toOwn - r.toKeysContract - r.toOtherSway - r.gas;
  }

  const trades = await ctx.prisma.trade.findMany({ where: { trader: a }, include: { market: { select: { subject: true } } } });
  for (const t of trades) {
    if (t.isBuy) {
      r.buys++;
      r.paid += big(t.totalWei);
    } else {
      r.sells++;
      r.received += big(t.totalWei);
    }
    r.fees.creator += big(t.creatorFeeWei);
    r.fees.protocol += big(t.protocolFeeWei);
    r.fees.holder += big(t.holderFeeWei);
    r.fees.referral += big(t.referralFeeWei);
    if (own(lc(t.market.subject))) r.creatorFeesToOwn += big(t.creatorFeeWei);
    else r.creatorFeesToOthers += big(t.creatorFeeWei);
  }
  for (const c of await ctx.prisma.earningsClaim.findMany({ where: { address: a } })) {
    r.claimed.creator += big(c.creatorWei);
    r.claimed.holder += big(c.holderWei);
    r.claimed.referral += big(c.referralWei);
    r.claimed.protocol += big(c.protocolWei);
  }

  const holdings = await ctx.prisma.holding.findMany({ where: { address: a, units: { gt: 0n } }, include: { market: { select: { subject: true, supplyUnits: true } } } });
  const [creator, holder, referral, protocol] = await ctx.pub.readContract({
    address: ctx.keys,
    abi: KEYS_ABI,
    functionName: 'claimable',
    args: [a as Address, holdings.map((x) => x.market.subject as Address)],
  });
  r.claimable = { creator, holder, referral, protocol };
  for (const x of holdings) {
    const sellable = lc(x.market.subject) === a ? x.units - LOCKED : x.units;
    if (sellable > 0n && x.market.supplyUnits - sellable >= LOCKED) r.keysValue += quoteWei(x.market.supplyUnits, 'sell', sellable).total;
  }
  const ref = lc(await ctx.pub.readContract({ address: ctx.keys, abi: KEYS_ABI, functionName: 'referrerOf', args: [a as Address] }));
  r.referrer = /^0x0{40}$/.test(ref) ? null : ref;
  return r;
}

export interface AuditTotals {
  deposits: bigint;
  withdrawals: bigint;
  gas: bigint;
  paid: bigint;
  received: bigint;
  fees: Four;
  creatorFeesToOwn: bigint;
  creatorFeesToOthers: bigint;
  holderRewardsEarned: bigint;
  claimed: bigint;
  claimable: bigint;
  balance: bigint;
  keysValue: bigint;
  /** ETH + claimable + keys now, minus what came in from outside plus what went out. Null without the explorer. */
  net: bigint | null;
}

/** Totals across the audited wallets: transfers between them cancel out. */
export function totals(reports: WalletReport[]): AuditTotals {
  const T = (f: (r: WalletReport) => bigint) => reports.reduce((s, r) => s + f(r), 0n);
  const fees = { creator: T((r) => r.fees.creator), holder: T((r) => r.fees.holder), referral: T((r) => r.fees.referral), protocol: T((r) => r.fees.protocol) };
  const t: AuditTotals = {
    deposits: T((r) => r.depositsIn + r.fromOperator),
    withdrawals: T((r) => r.withdrawnOut),
    gas: T((r) => r.gas),
    paid: T((r) => r.paid),
    received: T((r) => r.received),
    fees,
    creatorFeesToOwn: T((r) => r.creatorFeesToOwn),
    creatorFeesToOthers: T((r) => r.creatorFeesToOthers),
    holderRewardsEarned: T((r) => r.claimed.holder + r.claimable.holder),
    claimed: T((r) => sum4(r.claimed)),
    claimable: T((r) => sum4(r.claimable)),
    balance: T((r) => r.balance),
    keysValue: T((r) => r.keysValue),
    net: null,
  };
  if (reports.every((r) => r.explorerOk)) t.net = t.balance + t.claimable + t.keysValue - t.deposits + t.withdrawals;
  return t;
}
