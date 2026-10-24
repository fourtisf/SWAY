/**
 * Read-only audit of wallets (scripts/audit.ts prints it): where their ETH came from and went, what their key
 * trades cost, which fees went where, and what is still waiting to be claimed. Money in and out comes from the
 * explorer (Blockscout: the etherscan-style account API, else its v2 API), trades and claims from the indexer's
 * mirror, claimable earnings and balances from the chain.
 */
import { quoteWei } from '@sway/curve';
import type { prisma as Prisma } from '@sway/db';
import * as abis from '@sway/shared/abi';
import { parseAbi, toFunctionSelector, type AbiFunction, type Address, type PublicClient } from 'viem';

export const KEYS_ABI = parseAbi([
  'function claimable(address account, address[] subjects) view returns (uint256 creator, uint256 holder, uint256 referral, uint256 protocol)',
  'function treasury() view returns (address)',
  'function staking() view returns (address)',
  'function referrerOf(address user) view returns (address)',
]);
export const LOCKED = 100n;
const lc = (a: string) => a.toLowerCase();
/** 4-byte selector → function name, for Sway's contracts, to name what a wallet spent gas on. */
const SELECTORS = new Map<string, string>(
  Object.values(abis).flatMap((abi) => (abi as readonly { type: string }[]).filter((x): x is AbiFunction => x.type === 'function').map((f) => [toFunctionSelector(f), f.name] as [string, string])),
);
// Prisma Decimals print large values in exponent form (1.08e+26), so read them with toFixed(0).
const big = (d: unknown): bigint =>
  d == null ? 0n : typeof d === 'bigint' ? d : BigInt(typeof (d as { toFixed?: unknown }).toFixed === 'function' ? (d as { toFixed(n: number): string }).toFixed(0) : String(d).split('.')[0] || '0');

/** One transaction, as Blockscout's etherscan-style account API lists it. `fee` (v2) is the whole fee paid. */
export interface ExplorerTx {
  from: string;
  to: string;
  value: string;
  gasUsed?: string;
  gasPrice?: string;
  fee?: string;
  isError?: string;
  input?: string;
  /** The explorer's name for the call (v2), when it knows it. */
  method?: string | null;
}
export type TxHistory = { normal: ExplorerTx[]; internal: ExplorerTx[] };
/** Normal and internal transactions of an address, or why the explorer couldn't give them. */
export type TxSource = (address: string) => Promise<TxHistory | { error: string }>;

type Got = { body: unknown } | { error: string };
async function getJson(url: string, retryMs: number, progress?: (msg: string) => void): Promise<Got> {
  let error = '';
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
      const text = await r.text();
      if (!r.ok) error = `HTTP ${r.status}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 80)}` : ''}`;
      else {
        try {
          return { body: JSON.parse(text) };
        } catch {
          error = `not JSON: ${text.replace(/\s+/g, ' ').slice(0, 80)}`;
        }
      }
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      error = `${(e as Error).message}${cause ? ` (${cause.code ?? cause.message})` : ''}`;
    }
    if (i < 2) {
      progress?.(`retrying: ${error.slice(0, 60)}`);
      await new Promise((ok) => setTimeout(ok, retryMs * (i + 1)));
    }
  }
  return { error };
}

export interface ExplorerOptions {
  apiKey?: string;
  retryMs?: number;
  progress?: (msg: string) => void;
}

/**
 * Blockscout's etherscan-style API (`/api?module=account…`), falling back to its v2 API (`/api/v2/addresses/…`).
 * Once neither answers, later addresses fail at once with the same reason instead of waiting out every retry.
 */
export function blockscout(explorer: string, { apiKey = '', retryMs = 1500, progress }: ExplorerOptions = {}): TxSource {
  const base = explorer.replace(/\/$/, '');
  let down: string | null = null;
  const key = apiKey ? `apikey=${encodeURIComponent(apiKey)}` : '';
  const v1 = async (address: string, action: 'txlist' | 'txlistinternal'): Promise<ExplorerTx[] | { error: string }> => {
    const out: ExplorerTx[] = [];
    for (let page = 1; page <= 50; page++) {
      const got = await getJson(`${base}/api?module=account&action=${action}&address=${address}&sort=asc&page=${page}&offset=1000${key ? `&${key}` : ''}`, retryMs, progress);
      if ('error' in got) return got;
      const body = got.body as { message?: string; result?: unknown };
      // "No transactions found" comes back as an empty result; a rate limit or a bad request as a string.
      if (!Array.isArray(body.result)) {
        if (/no .*found/i.test(String(body.message ?? '')) || body.result == null) break;
        return { error: `${body.message ?? 'error'}: ${String(body.result).slice(0, 80)}` };
      }
      out.push(...(body.result as ExplorerTx[]));
      progress?.(`${address.slice(0, 10)}… ${out.length} transactions`);
      if (body.result.length < 1000) break;
      await new Promise((ok) => setTimeout(ok, 250));
    }
    return out;
  };
  type V2Item = {
    from?: { hash?: string } | null;
    to?: { hash?: string } | null;
    created_contract?: { hash?: string } | null;
    value?: string;
    fee?: { value?: string } | null;
    status?: string | null;
    success?: boolean | null;
    method?: string | null;
    raw_input?: string | null;
  };
  const v2 = async (address: string, kind: 'transactions' | 'internal-transactions'): Promise<ExplorerTx[] | { error: string }> => {
    const out: ExplorerTx[] = [];
    let next = '';
    for (let page = 0; page < 500; page++) {
      const q = [next, key].filter(Boolean).join('&');
      const got = await getJson(`${base}/api/v2/addresses/${address}/${kind}${q ? `?${q}` : ''}`, retryMs, progress);
      if ('error' in got) return got;
      const body = got.body as { items?: V2Item[]; next_page_params?: Record<string, string | number> | null };
      if (!Array.isArray(body.items)) return { error: 'no items in the answer' };
      for (const t of body.items) {
        const failed = kind === 'transactions' ? t.status === 'error' : t.success === false;
        out.push({
          from: t.from?.hash ?? '',
          to: t.to?.hash ?? t.created_contract?.hash ?? '',
          value: t.value ?? '0',
          fee: kind === 'transactions' ? (t.fee?.value ?? '0') : undefined,
          isError: failed ? '1' : '0',
          ...(kind === 'transactions' ? { input: t.raw_input ?? undefined, method: t.method ?? null } : {}),
        });
      }
      progress?.(`${address.slice(0, 10)}… ${out.length} transactions`);
      if (!body.next_page_params) break;
      next = new URLSearchParams(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)] as [string, string])).toString();
      await new Promise((ok) => setTimeout(ok, 250));
    }
    return out;
  };
  const why = (x: ExplorerTx[] | { error: string }) => (Array.isArray(x) ? 'ok' : x.error);
  return async (address) => {
    if (down) return { error: down };
    const a = await v1(address, 'txlist');
    const b = Array.isArray(a) ? await v1(address, 'txlistinternal') : a;
    if (Array.isArray(a) && Array.isArray(b)) return { normal: a, internal: b };
    const c = await v2(address, 'transactions');
    const d = Array.isArray(c) ? await v2(address, 'internal-transactions') : c;
    if (Array.isArray(c) && Array.isArray(d)) return { normal: c, internal: d };
    down = `${base}/api → ${why(b)}; /api/v2 → ${why(d)}`;
    return { error: down };
  };
}

type Four = { creator: bigint; holder: bigint; referral: bigint; protocol: bigint };
const four = (): Four => ({ creator: 0n, holder: 0n, referral: 0n, protocol: 0n });
export const sum4 = (f: Four) => f.creator + f.holder + f.referral + f.protocol;

export interface WalletReport {
  address: string;
  owner: string;
  explorerOk: boolean;
  explorerError: string | null;
  /** ETH from addresses outside the audited set (and not Sway's own contracts). */
  depositsIn: bigint;
  fromOperator: bigint;
  fromOwn: bigint;
  fromKeysContract: bigint;
  fromOtherSway: bigint;
  withdrawnOut: bigint;
  /** ETH to and from other members' wallets (gas drips, transfers). */
  toMembers: bigint;
  fromMembers: bigint;
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
  /** What this wallet's own transactions did (SwayKeys.buy, ETH to other members…), by gas spent. */
  actions: Array<{ action: string; count: number; gas: bigint; value: bigint }>;
}

export interface AuditContext {
  prisma: typeof Prisma;
  pub: PublicClient;
  keys: Address;
  /** Every audited wallet → its label (@handle). Transfers between them count as moves, not deposits. */
  owners: Map<string, string>;
  /** Markets of the audited members (a claimed fan market keeps its fan subject), lowercase. */
  ownSubjects: Set<string>;
  operator: string | null;
  /** Sway's other contracts (launchpad, staking…), lowercase → name. */
  swayContracts: Map<string, string>;
  /** Every member's wallets (account + linked), lowercase → @handle. */
  members: Map<string, string>;
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
    explorerError: null,
    depositsIn: 0n, fromOperator: 0n, fromOwn: 0n, fromKeysContract: 0n, fromOtherSway: 0n,
    withdrawnOut: 0n, toMembers: 0n, fromMembers: 0n, toOwn: 0n, toKeysContract: 0n, toOtherSway: 0n, gas: 0n, expectedBalance: 0n,
    balance: await ctx.pub.getBalance({ address: a as Address }),
    buys: 0, paid: 0n, sells: 0, received: 0n, fees: four(), creatorFeesToOwn: 0n, creatorFeesToOthers: 0n,
    claimed: four(), claimable: four(), keysValue: 0n, referrer: null, others: [], actions: [],
  };
  const actions = new Map<string, { action: string; count: number; gas: bigint; value: bigint }>();
  const others = new Map<string, { address: string; in: bigint; out: bigint }>();
  const other = (x: string) => others.get(x) ?? others.set(x, { address: x, in: 0n, out: 0n }).get(x)!;

  const h = ctx.txs ? await ctx.txs(a) : null;
  if (h && 'error' in h) r.explorerError = h.error;
  else if (h) {
    r.explorerOk = true;
    for (const t of h.normal) {
      const from = lc(t.from || ''), to = lc(t.to || ''), v = t.isError === '1' ? 0n : BigInt(t.value || '0');
      if (from === a) {
        const gas = t.fee !== undefined ? BigInt(t.fee || '0') : BigInt(t.gasUsed || '0') * BigInt(t.gasPrice || '0');
        r.gas += gas;
        const name = action(ctx, t, to);
        const act = actions.get(name) ?? actions.set(name, { action: name, count: 0, gas: 0n, value: 0n }).get(name)!;
        act.count++;
        act.gas += gas;
        act.value += v;
        if (to === a) continue;
        if (to === keys) r.toKeysContract += v;
        else if (ctx.swayContracts.has(to)) r.toOtherSway += v;
        else if (own(to)) r.toOwn += v;
        else if (v > 0n) {
          if (ctx.members.has(to)) r.toMembers += v;
          else r.withdrawnOut += v;
          other(to).out += v;
        }
      } else if (to === a) {
        if (own(from)) r.fromOwn += v;
        else if (from === ctx.operator) r.fromOperator += v;
        else if (v > 0n) {
          if (ctx.members.has(from)) r.fromMembers += v;
          else r.depositsIn += v;
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
        if (ctx.members.has(from)) r.fromMembers += v;
        else r.depositsIn += v;
        other(from).in += v;
      }
    }
    r.actions = [...actions.values()].sort((x, y) => (y.gas > x.gas ? 1 : y.gas < x.gas ? -1 : y.count - x.count));
    r.others = [...others.values()].sort((x, y) => (y.in + y.out > x.in + x.out ? 1 : -1));
    r.expectedBalance =
      r.depositsIn + r.fromOperator + r.fromMembers + r.fromOwn + r.fromKeysContract + r.fromOtherSway -
      r.withdrawnOut - r.toMembers - r.toOwn - r.toKeysContract - r.toOtherSway - r.gas;
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
    if (ctx.ownSubjects.has(lc(t.market.subject))) r.creatorFeesToOwn += big(t.creatorFeeWei);
    else r.creatorFeesToOthers += big(t.creatorFeeWei);
  }
  for (const c of await ctx.prisma.earningsClaim.findMany({ where: { address: a } })) {
    r.claimed.creator += big(c.creatorWei);
    r.claimed.holder += big(c.holderWei);
    r.claimed.referral += big(c.referralWei);
    r.claimed.protocol += big(c.protocolWei);
  }

  const holdings = await ctx.prisma.holding.findMany({
    where: { address: a, units: { gt: 0n } },
    include: { market: { select: { subject: true, supplyUnits: true, user: { select: { wallet: { select: { address: true } } } } } } },
  });
  const [creator, holder, referral, protocol] = await ctx.pub.readContract({
    address: ctx.keys,
    abi: KEYS_ABI,
    functionName: 'claimable',
    args: [a as Address, holdings.map((x) => x.market.subject as Address)],
  });
  r.claimable = { creator, holder, referral, protocol };
  for (const x of holdings) {
    const isOwner = lc(x.market.subject) === a || lc(x.market.user.wallet?.address ?? '') === a;
    r.keysValue += sellValue(x.market.supplyUnits, isOwner ? x.units - LOCKED : x.units);
  }
  const ref = lc(await ctx.pub.readContract({ address: ctx.keys, abi: KEYS_ABI, functionName: 'referrerOf', args: [a as Address] }));
  r.referrer = /^0x0{40}$/.test(ref) ? null : ref;
  return r;
}

/** A transaction's action: the contract and function it called, or where a plain ETH transfer went. */
function action(ctx: AuditContext, t: ExplorerTx, to: string): string {
  const input = t.input ?? '';
  const named = t.method && !/^0x/.test(t.method) ? t.method : null;
  const fn = named ?? SELECTORS.get(input.slice(0, 10)) ?? (input.length >= 10 ? input.slice(0, 10) : '');
  if (to === lc(ctx.keys)) return `SwayKeys.${fn || 'transfer'}`;
  if (ctx.swayContracts.has(to)) return `${ctx.swayContracts.get(to)}.${fn || 'transfer'}`;
  if (!fn) {
    if (ctx.owners.has(to)) return 'ETH to own wallets';
    if (ctx.members.has(to)) return 'ETH to other members';
    if (!to) return 'contract deploy';
    return 'ETH to outside addresses';
  }
  return to ? `${fn} on ${to.slice(0, 10)}…` : 'contract deploy';
}

/** What selling `units` would pay now (before anyone else sells), or 0 when they can't be sold. */
export function sellValue(supply: bigint, units: bigint): bigint {
  return units > 0n && supply - units >= LOCKED ? quoteWei(supply, 'sell', units).total : 0n;
}

export interface AuditTotals {
  deposits: bigint;
  withdrawals: bigint;
  fromMembers: bigint;
  toMembers: bigint;
  /** Moves between audited wallets: they cancel out over all of them, not per account. */
  fromOwn: bigint;
  toOwn: bigint;
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
  /** ETH + claimable + keys now, minus what came in (outside, members) plus what went out. Null without the explorer. */
  net: bigint | null;
}

/** Totals across the audited wallets: transfers between them cancel out. */
export function totals(reports: WalletReport[]): AuditTotals {
  const T = (f: (r: WalletReport) => bigint) => reports.reduce((s, r) => s + f(r), 0n);
  const fees = { creator: T((r) => r.fees.creator), holder: T((r) => r.fees.holder), referral: T((r) => r.fees.referral), protocol: T((r) => r.fees.protocol) };
  const t: AuditTotals = {
    deposits: T((r) => r.depositsIn + r.fromOperator),
    withdrawals: T((r) => r.withdrawnOut),
    fromMembers: T((r) => r.fromMembers),
    toMembers: T((r) => r.toMembers),
    fromOwn: T((r) => r.fromOwn),
    toOwn: T((r) => r.toOwn),
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
  if (reports.length && reports.every((r) => r.explorerOk)) t.net = t.balance + t.claimable + t.keysValue - t.deposits - t.fromMembers - t.fromOwn + t.withdrawals + t.toMembers + t.toOwn;
  return t;
}
