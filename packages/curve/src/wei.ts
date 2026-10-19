/**
 * Exact integer curve math, line for line with SwayKeys.sol. Every function here must give the
 * same wei as the contract; the Foundry suite checks this against vectors generated from this file.
 *
 * Supply and trade sizes are in units (1 key = 100 units).
 *
 *   price(u)      = K * (u + 200)^2 / 10^4                 marginal price at supply u
 *   cumulative(u) = K * (u + 200)^3 / (3 * 10^6)           area under the curve from -O to u
 *   cost(a -> b)  = cumulative(b) - cumulative(a)
 *
 * Flooring each cumulative value (instead of the difference) keeps cost path-independent to the wei:
 * splitting one trade into several never changes the total, so the contract's reserve for a market is
 * always exactly cumulative(supply) - cumulative(100).
 */
import {
  ACC_PRECISION,
  ANTI_DUMP_BPS,
  ANTI_DUMP_WINDOW_SECONDS,
  BPS,
  CREATOR_FEE_BPS,
  CUBE_DIV,
  HOLDER_FEE_BPS,
  K_WEI,
  LEVEL_CUT_BPS,
  LOCKED_UNITS,
  OFFSET_UNITS,
  PROTOCOL_FEE_BPS,
  REFERRAL_FEE_BPS,
  SQUARE_DIV,
} from './constants';

export type Side = 'buy' | 'sell';

export function priceWei(supplyUnits: bigint): bigint {
  const x = supplyUnits + OFFSET_UNITS;
  return (K_WEI * x * x) / SQUARE_DIV;
}

export function cumulativeWei(supplyUnits: bigint): bigint {
  const x = supplyUnits + OFFSET_UNITS;
  return (K_WEI * x * x * x) / CUBE_DIV;
}

/** Curve cost of moving supply from `fromUnits` to `toUnits` (either direction), always >= 0. */
export function areaWei(fromUnits: bigint, toUnits: bigint): bigint {
  const lo = fromUnits < toUnits ? fromUnits : toUnits;
  const hi = fromUnits < toUnits ? toUnits : fromUnits;
  return cumulativeWei(hi) - cumulativeWei(lo);
}

/** True when a sell now would pay the anti-dump surcharge, given the seller's last buy (ISO date or ms). */
export function inAntiDumpWindow(lastBuyAt: string | number | Date | null | undefined, now = Date.now()): boolean {
  if (!lastBuyAt) return false;
  return now < new Date(lastBuyAt).getTime() + ANTI_DUMP_WINDOW_SECONDS * 1000;
}

/** Reserve the contract holds for a market at this supply. */
export function reserveWei(supplyUnits: bigint): bigint {
  return supplyUnits <= LOCKED_UNITS ? 0n : cumulativeWei(supplyUnits) - cumulativeWei(LOCKED_UNITS);
}

export function levelCutBps(level: number): bigint {
  const i = Math.max(0, Math.min(LEVEL_CUT_BPS.length - 1, Math.trunc(level)));
  return LEVEL_CUT_BPS[i];
}

export interface FeeBreakdown {
  /** 6% to the market owner, or to FanEscrow while a fan market is unclaimed. 0 while the creator is inactive. */
  creatorFee: bigint;
  /** 2% cut by the trader's staking level. Missing referral halves are added on top (see protocolTotal). */
  protocolFee: bigint;
  /**
   * 1% streamed pro rata to current holders through the reward-per-unit accumulator, plus the creator's 6%
   * while they are inactive (activity bond) and the 5% anti-dump surcharge on early sells.
   */
  holderFee: bigint;
  /** The part of holderFee that is the anti-dump surcharge. */
  antiDumpFee: bigint;
  /** 1% referral pool: half to the trader's referrer, half to the creator's referrer. */
  referralFee: bigint;
  traderReferrerShare: bigint;
  creatorReferrerShare: bigint;
  /** protocolFee plus any referral half that had no referrer. */
  protocolTotal: bigint;
  /** Half of protocolTotal, credited to the staking contract. */
  stakerShare: bigint;
  /** protocolTotal - stakerShare, credited to the treasury. */
  treasuryShare: bigint;
  /** creatorFee + protocolFee + holderFee + referralFee (what the trader pays, independent of referrers). */
  totalFee: bigint;
}

export interface FeeOptions {
  /** Trader's staking level 0..4. */
  level?: number;
  hasTraderReferrer?: boolean;
  hasCreatorReferrer?: boolean;
  /** Creator activity bond in effect (SwayKeys.creatorInactive): the creator fee goes to holders. */
  creatorInactive?: boolean;
  /** Apply the anti-dump surcharge (a sell within 24h of the trader's last buy in this market). */
  antiDump?: boolean;
}

export function feesWei(base: bigint, opts: FeeOptions = {}): FeeBreakdown {
  const cut = levelCutBps(opts.level ?? 0);
  let creatorFee = (base * CREATOR_FEE_BPS) / BPS;
  const protocolFee = (base * PROTOCOL_FEE_BPS * (BPS - cut)) / (BPS * BPS);
  let holderFee = (base * HOLDER_FEE_BPS) / BPS;
  const referralFee = (base * REFERRAL_FEE_BPS) / BPS;
  if (opts.creatorInactive) {
    holderFee += creatorFee;
    creatorFee = 0n;
  }
  const antiDumpFee = opts.antiDump ? (base * ANTI_DUMP_BPS) / BPS : 0n;
  holderFee += antiDumpFee;
  const traderHalf = referralFee / 2n;
  const creatorHalf = referralFee - traderHalf;
  const traderReferrerShare = opts.hasTraderReferrer ? traderHalf : 0n;
  const creatorReferrerShare = opts.hasCreatorReferrer ? creatorHalf : 0n;
  const protocolTotal = protocolFee + (referralFee - traderReferrerShare - creatorReferrerShare);
  const stakerShare = protocolTotal / 2n;
  return {
    creatorFee,
    protocolFee,
    holderFee,
    antiDumpFee,
    referralFee,
    traderReferrerShare,
    creatorReferrerShare,
    protocolTotal,
    stakerShare,
    treasuryShare: protocolTotal - stakerShare,
    totalFee: creatorFee + protocolFee + holderFee + referralFee,
  };
}

export interface QuoteWei extends FeeBreakdown {
  side: Side;
  units: bigint;
  supplyBefore: bigint;
  supplyAfter: bigint;
  /** Curve price of the trade (area under the curve). */
  base: bigint;
  /** Buy: ETH the trader pays. Sell: ETH the trader receives. */
  total: bigint;
  priceBefore: bigint;
  priceAfter: bigint;
}

export class CurveError extends Error {}

export function quoteWei(supplyUnits: bigint, side: Side, units: bigint, opts: FeeOptions = {}): QuoteWei {
  if (units <= 0n) throw new CurveError('units must be positive');
  if (supplyUnits < LOCKED_UNITS) throw new CurveError('market not open');
  if (side === 'sell' && supplyUnits - units < LOCKED_UNITS) throw new CurveError('cannot sell the locked first key');
  const supplyAfter = side === 'buy' ? supplyUnits + units : supplyUnits - units;
  const base = areaWei(supplyUnits, supplyAfter);
  const fees = feesWei(base, { ...opts, antiDump: side === 'sell' && !!opts.antiDump });
  return {
    side,
    units,
    supplyBefore: supplyUnits,
    supplyAfter,
    base,
    ...fees,
    total: side === 'buy' ? base + fees.totalFee : base - fees.totalFee,
    priceBefore: priceWei(supplyUnits),
    priceAfter: priceWei(supplyAfter),
  };
}

/**
 * Holder-fee accumulator step. Buys spread the fee over holders before the trade, sells over holders
 * after it, so the denominator is never below the locked first key.
 */
export function accIncrement(holderFee: bigint, denominatorUnits: bigint): bigint {
  return (holderFee * ACC_PRECISION) / denominatorUnits;
}

/** Rewards owed to a holder of `balanceUnits` since their debt snapshot. */
export function pendingHolderReward(balanceUnits: bigint, acc: bigint, debt: bigint): bigint {
  return (balanceUnits * (acc - debt)) / ACC_PRECISION;
}

/**
 * Largest buy (in units) whose total cost fits in `budgetWei`. Binary search over the exact quote,
 * so the result always passes the contract's msg.value check.
 */
export function maxBuyUnits(supplyUnits: bigint, budgetWei: bigint, opts: FeeOptions = {}): bigint {
  let lo = 0n;
  let hi = 1n;
  while (quoteWei(supplyUnits, 'buy', hi, opts).total <= budgetWei) {
    lo = hi;
    hi *= 2n;
    if (hi > 10n ** 12n) break;
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (quoteWei(supplyUnits, 'buy', mid, opts).total <= budgetWei) lo = mid;
    else hi = mid;
  }
  return lo;
}
