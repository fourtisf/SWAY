/**
 * Genesis pool split (brief §8). 5% of supply goes to the top 500 by points at the snapshot,
 * weighted by 1/√rank with an integer recipe so the result is reproducible to the unit:
 *
 *   W(r)     = isqrt(10^40 / r)
 *   share(r) = floor(pool * W(r) / ΣW)
 *   leftover units go one each to the largest remainders, lower rank first on ties.
 */

export const GENESIS_MAX = 500;
const SCALE = 10n ** 40n;

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of negative');
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  // Newton refinement from the float estimate; converge to floor(sqrt(n)).
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

export const genesisWeight = (rank: number): bigint => isqrt(SCALE / BigInt(rank));

export interface GenesisAllocation {
  rank: number;
  weight: bigint;
  units: bigint;
}

/** Splits `poolUnits` across ranks 1..count (count ≤ 500). Sum of units always equals poolUnits. */
export function allocateGenesis(poolUnits: bigint, count = GENESIS_MAX): GenesisAllocation[] {
  if (count < 1 || count > GENESIS_MAX) throw new RangeError('count must be 1..500');
  const rows = Array.from({ length: count }, (_, i) => ({ rank: i + 1, weight: genesisWeight(i + 1) }));
  const sumW = rows.reduce((s, r) => s + r.weight, 0n);
  const out = rows.map((r) => {
    const num = poolUnits * r.weight;
    return { rank: r.rank, weight: r.weight, units: num / sumW, rem: num % sumW };
  });
  let leftover = poolUnits - out.reduce((s, r) => s + r.units, 0n);
  const order = [...out].sort((a, b) => (a.rem === b.rem ? a.rank - b.rank : a.rem > b.rem ? -1 : 1));
  for (let i = 0; leftover > 0n; i++, leftover--) order[i % order.length]!.units += 1n;
  return out.map(({ rank, weight, units }) => ({ rank, weight, units }));
}

/** Float share in percent of the pool, as the Genesis page shows it (1/√r normalised over 500). */
export function genesisSharePercent(rank: number, count = GENESIS_MAX): number {
  let sum = 0;
  for (let r = 1; r <= count; r++) sum += 1 / Math.sqrt(r);
  return ((1 / Math.sqrt(rank)) / sum) * 100;
}

export interface GenesisCandidate {
  userId: string;
  points: number;
  wallet: string | null;
  tasksVerified: number;
  botFlag: boolean;
  score: number;
  /** Tie-breaker: earlier member number ranks first. */
  memberNo: number;
}

/** Eligibility: has a wallet, ≥1 task verified on X, no bot flag, score ≥ reward minimum. */
export function genesisEligible(c: GenesisCandidate, minScore: number): boolean {
  return !!c.wallet && c.tasksVerified >= 1 && !c.botFlag && c.score >= minScore;
}

/** Ranks eligible candidates by points (desc), then member number (asc), and keeps the top 500. */
export function rankGenesis(cands: GenesisCandidate[], minScore: number): Array<GenesisCandidate & { rank: number }> {
  return cands
    .filter((c) => genesisEligible(c, minScore))
    .sort((a, b) => b.points - a.points || a.memberNo - b.memberNo)
    .slice(0, GENESIS_MAX)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}
