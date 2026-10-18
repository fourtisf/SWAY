/**
 * Sway score: the public, MIT-licensed scoring model. The same function runs in the workers and on the
 * Open model page. Nothing is weighted by hand.
 */

export interface ScoreInputs {
  followers: number;
  /** Engagement rate: (likes + 2·reposts + 3·replies) / followers, averaged per post over the last 50 posts. */
  er: number;
  /** Original posts per week, replies excluded. */
  ppw: number;
  /** Account age in years. */
  age: number;
  verified: boolean;
}

export interface ScoreParts {
  reach: number;
  eng: number;
  cons: number;
  auth: number;
}

export interface ScoreResult {
  /** 1..100 */
  score: number;
  /** Reach value in USD, an in-app estimate shown on cards and the launchpad. */
  value: number;
  raw: number;
  parts: ScoreParts;
}

export function score({ followers, er, ppw, age, verified }: ScoreInputs): ScoreResult {
  const reach = Math.min(1, Math.log10(followers + 1) / Math.log10(5e7));
  const eng = 1 - Math.exp(-er * 40);
  const cons = Math.min(1, ppw / 21);
  const auth = 0.6 * Math.min(1, age / 6) + 0.4 * (verified ? 1 : 0);
  const raw = 0.35 * reach + 0.35 * eng + 0.1 * cons + 0.2 * auth;
  return {
    score: Math.max(1, Math.round(raw * 100)),
    value: 0.42 * followers * Math.pow(raw, 1.6) * (0.6 + eng),
    raw,
    parts: { reach, eng, cons, auth },
  };
}

/** A post as read from the X API (public_metrics plus the fields scoring needs). */
export interface XPostSample {
  createdAt: Date | string;
  likes: number;
  reposts: number;
  replies: number;
  /** True for replies to other posts. */
  isReply?: boolean;
  /** True for plain reposts (retweets); they carry no engagement of their own. */
  isRepost?: boolean;
}

export const SCORE_POST_SAMPLE = 50;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

/**
 * Builds ScoreInputs from an X profile and its most recent posts (newest first or any order).
 * - er: average over the last 50 posts that are not plain reposts.
 * - ppw: original posts (no replies, no reposts) per week over the span those posts cover, at least one week.
 */
export function inputsFromX(
  profile: { followers: number; createdAt: Date | string; verified: boolean },
  posts: XPostSample[],
  now: Date = new Date(),
): ScoreInputs {
  const followers = Math.max(0, profile.followers);
  const own = posts
    .filter((p) => !p.isRepost)
    .map((p) => ({ ...p, t: new Date(p.createdAt).getTime() }))
    .sort((a, b) => b.t - a.t)
    .slice(0, SCORE_POST_SAMPLE);

  const er =
    own.length && followers > 0
      ? own.reduce((s, p) => s + (p.likes + 2 * p.reposts + 3 * p.replies) / followers, 0) / own.length
      : 0;

  const originals = own.filter((p) => !p.isReply);
  let ppw = 0;
  if (originals.length) {
    const oldest = originals[originals.length - 1]!.t;
    const weeks = Math.max(1, (now.getTime() - oldest) / WEEK_MS);
    ppw = originals.length / weeks;
  }

  const age = Math.max(0, (now.getTime() - new Date(profile.createdAt).getTime()) / YEAR_MS);
  return { followers, er, ppw, age, verified: profile.verified };
}
