/** Battles (brief §7): 1v1 engagement-rate contests settled from one X API read per side. */

export const BATTLE_WINDOW_HOURS = 24;
export const BATTLE_READ_DELAY_HOURS = 6;
export const BATTLE_EXPIRE_HOURS = 48;
export const BATTLE_MAX_ACTIVE = 3;
export const BATTLE_REMATCH_DAYS = 7;
export const BATTLE_TREASURY_BPS = 500;
export const BACKING_MIN = 100;
export const WEEKLY_PRIZE_SPLIT = [50, 30, 20] as const;
export const BATTLE_TAG = '#SwayBattle';

export interface BattleMetrics {
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  bookmarks: number;
}

/** score = (likes×1 + reposts×2 + replies×3 + quotes×3 + bookmarks×2) ÷ followers */
export function battleScore(m: BattleMetrics, followers: number): number {
  if (followers <= 0) return 0;
  return (m.likes + m.reposts * 2 + m.replies * 3 + m.quotes * 3 + m.bookmarks * 2) / followers;
}

export type BattleOutcome = 'a' | 'b' | 'draw';

export interface SideResult {
  posted: boolean;
  score: number;
}

/** No post = forfeit; both missing or a tie = draw. */
export function battleOutcome(a: SideResult, b: SideResult): BattleOutcome {
  if (!a.posted && !b.posted) return 'draw';
  if (!a.posted) return 'b';
  if (!b.posted) return 'a';
  if (a.score === b.score) return 'draw';
  return a.score > b.score ? 'a' : 'b';
}

export interface StakeSettlement {
  outcome: BattleOutcome;
  payoutA: number;
  payoutB: number;
  treasury: number;
}

/** Winner takes both stakes minus 5% to the treasury; a draw refunds both. Points are integers. */
export function settleStakes(outcome: BattleOutcome, stakeA: number, stakeB: number): StakeSettlement {
  if (outcome === 'draw') return { outcome, payoutA: stakeA, payoutB: stakeB, treasury: 0 };
  const pot = stakeA + stakeB;
  const treasury = Math.floor((pot * BATTLE_TREASURY_BPS) / 10_000);
  const prize = pot - treasury;
  return outcome === 'a'
    ? { outcome, payoutA: prize, payoutB: 0, treasury }
    : { outcome, payoutA: 0, payoutB: prize, treasury };
}

export interface Backing {
  userId: string;
  side: 'a' | 'b';
  amount: number;
}

export interface BackingPayout {
  userId: string;
  payout: number;
}

/**
 * Spectators: winners get their own amount back plus a pro-rata cut of the losing pool after 5% to the
 * treasury. Draws refund everyone. Rounding dust goes to the treasury.
 */
export function settleBackings(outcome: BattleOutcome, backings: Backing[]): { payouts: BackingPayout[]; treasury: number } {
  if (outcome === 'draw') return { payouts: backings.map((b) => ({ userId: b.userId, payout: b.amount })), treasury: 0 };
  const winners = backings.filter((b) => b.side === outcome);
  const losers = backings.filter((b) => b.side !== outcome);
  const losingPool = losers.reduce((s, b) => s + b.amount, 0);
  const winPool = winners.reduce((s, b) => s + b.amount, 0);
  if (winPool === 0) return { payouts: losers.map((b) => ({ userId: b.userId, payout: 0 })), treasury: losingPool };
  let treasury = Math.floor((losingPool * BATTLE_TREASURY_BPS) / 10_000);
  const distributable = losingPool - treasury;
  let paid = 0;
  const payouts = winners.map((b) => {
    const cut = Math.floor((distributable * b.amount) / winPool);
    paid += cut;
    return { userId: b.userId, payout: b.amount + cut };
  });
  treasury += distributable - paid;
  return { payouts: [...payouts, ...losers.map((b) => ({ userId: b.userId, payout: 0 }))], treasury };
}

/** Weekly (Mon 00:00 UTC): 50% of the treasury to the top three fighters by points won, 50/30/20. */
export function weeklyPrizes(treasury: number, top: string[]): Array<{ userId: string; prize: number }> {
  const pool = Math.floor(treasury / 2);
  return top.slice(0, 3).map((userId, i) => ({ userId, prize: Math.floor((pool * WEEKLY_PRIZE_SPLIT[i]!) / 100) }));
}

/** Max stake both sides can afford: earned points only (score points can't be staked). */
export const maxStake = (earnedA: number, earnedB: number): number => Math.max(0, Math.min(earnedA, earnedB));
