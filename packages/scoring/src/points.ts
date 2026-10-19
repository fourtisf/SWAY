/** Points sources, tiers and invite rules (brief §6). Points have no monetary value until announced. */

export const SCORE_POINTS_PER_SCORE = 100;
export const SCORE_POINTS_MAX = 10_000;
export const INVITE_POINTS = 500;
export const INVITEE_POINTS = 100;
export const INVITES_CREDITED_PER_DAY = 25;
export const HELD_POINTS_PER_ETH = 400_000;
export const TRADED_POINTS_PER_ETH = 100_000;

export const scorePoints = (score: number): number => Math.min(SCORE_POINTS_MAX, score * SCORE_POINTS_PER_SCORE);

/** Points for keys held, from their current sell value in ETH (own key excluded by the caller). */
export const heldPoints = (sellValueEth: number): number => Math.round(sellValueEth * HELD_POINTS_PER_ETH);

/** Points for keys traded, from curve volume in ETH (own key excluded by the caller). */
export const tradedPoints = (volumeEth: number): number => Math.round(volumeEth * TRADED_POINTS_PER_ETH);

export interface InviteeProfile {
  accountAgeDays: number;
  followers: number;
  verified: boolean;
  botFlag: boolean;
}

/** A verified invite: the invitee is ≥30 days old, has ≥50 followers, an X checkmark, and no bot flag. */
export const inviteQualifies = (p: InviteeProfile): boolean =>
  p.accountAgeDays >= 30 && p.followers >= 50 && p.verified && !p.botFlag;

export interface Tier {
  name: 'Murmur' | 'Voice' | 'Echo' | 'Chorus' | 'Anthem';
  min: number;
  frame: string;
}

export const TIERS: readonly Tier[] = [
  { name: 'Murmur', min: 0, frame: '#AAB8C2' },
  { name: 'Voice', min: 50_000, frame: '#7856FF' },
  { name: 'Echo', min: 100_000, frame: '#1D9BF0' },
  { name: 'Chorus', min: 500_000, frame: '#F91880' },
  { name: 'Anthem', min: 2_000_000, frame: 'linear-gradient(90deg,#1D9BF0,#7856FF,#F91880)' },
];

export function tierOf(points: number): Tier {
  let t = TIERS[0]!;
  for (const x of TIERS) if (points >= x.min) t = x;
  return t;
}

export interface TierProgress {
  tier: Tier;
  index: number;
  next: Tier | null;
  /** 0..1 progress through the current tier. */
  progress: number;
  toNext: number;
}

export function tierProgress(points: number): TierProgress {
  const tier = tierOf(points);
  const index = TIERS.indexOf(tier);
  const next = TIERS[index + 1] ?? null;
  return {
    tier,
    index,
    next,
    progress: next ? (points - tier.min) / (next.min - tier.min) : 1,
    toNext: next ? Math.max(0, next.min - points) : 0,
  };
}

/** Card frame colour from a Sway score (prototype frameOfScore). */
export const frameOfScore = (s: number): string =>
  s >= 75
    ? TIERS[4]!.frame
    : s >= 66
      ? TIERS[3]!.frame
      : s >= 58
        ? TIERS[2]!.frame
        : s >= 48
          ? TIERS[1]!.frame
          : TIERS[0]!.frame;

export interface PointsBreakdown {
  score: number;
  ledger: number;
  held: number;
  total: number;
}

/**
 * Total = score points + append-only ledger sum (tasks, invites, trade volume, battles) + live held points.
 * Held points are recounted every minute from current sell values, so they are not ledger entries.
 */
export function totalPoints(scoreValue: number, ledgerSum: number, heldPts: number): PointsBreakdown {
  const s = scorePoints(scoreValue);
  return { score: s, ledger: ledgerSum, held: heldPts, total: Math.max(0, Math.round(s + ledgerSum + heldPts)) };
}

/** Daily check-in: day n of an unbroken streak pays n × 100 points, capped at day 7 (700 a day after that). */
export const STREAK_POINTS_PER_DAY = 100;
export const STREAK_CAP_DAYS = 7;
export const streakPoints = (day: number): number => Math.max(0, Math.min(day, STREAK_CAP_DAYS)) * STREAK_POINTS_PER_DAY;

/** UTC day key "YYYY-MM-DD". */
export const utcDayKey = (d: Date | number = Date.now()): string => new Date(d).toISOString().slice(0, 10);

/**
 * Next streak length for a check-in on `today`: continues when the last check-in was yesterday (UTC), stays
 * when it was today (already checked in), otherwise restarts at 1.
 */
export function nextStreak(lastDay: string | null | undefined, days: number, today: string): { days: number; already: boolean } {
  if (lastDay === today) return { days, already: true };
  const y = utcDayKey(Date.parse(`${today}T00:00:00Z`) - 86_400_000);
  return { days: lastDay === y ? days + 1 : 1, already: false };
}
