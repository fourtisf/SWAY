import { quoteWei, type Side } from './wei';

/** Deterministic PRNG (mulberry32, the prototype's rng()). */
export function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CurveVectors {
  supply: string[];
  units: string[];
  isBuy: boolean[];
  level: number[];
  traderRef: boolean[];
  creatorRef: boolean[];
  base: string[];
  creatorFee: string[];
  protocolFee: string[];
  holderFee: string[];
  referralFee: string[];
  protocolTotal: string[];
  total: string[];
}

export function buildVectors(count = 160, seed = 20261027): CurveVectors {
  const r = rng(seed);
  const v: CurveVectors = {
    supply: [], units: [], isBuy: [], level: [], traderRef: [], creatorRef: [],
    base: [], creatorFee: [], protocolFee: [], holderFee: [], referralFee: [], protocolTotal: [], total: [],
  };
  const cases: Array<[bigint, Side, bigint, number, boolean, boolean]> = [
    [100n, 'buy', 1n, 0, false, false],
    [100n, 'buy', 100n, 0, false, false],
    [101n, 'sell', 1n, 0, true, true],
    [200n, 'sell', 100n, 4, true, false],
    [1_000n, 'buy', 1_000n, 2, false, true],
    [10_000n, 'buy', 10_000n, 3, true, true],
    [10_000n, 'sell', 9_900n, 1, false, false],
    [1_000_000n, 'buy', 1n, 0, true, true],
  ];
  while (cases.length < count) {
    const supply = 100n + BigInt(Math.floor(Math.pow(r(), 3) * 200_000));
    const side: Side = r() < 0.5 ? 'buy' : 'sell';
    const maxUnits = side === 'buy' ? 50_000 : Number(supply - 100n);
    if (maxUnits < 1) continue;
    const units = 1n + BigInt(Math.floor(Math.pow(r(), 2) * (maxUnits - 1)));
    cases.push([supply, side, units, Math.floor(r() * 5), r() < 0.5, r() < 0.5]);
  }
  for (const [supply, side, units, level, tr, cr] of cases) {
    const q = quoteWei(supply, side, units, { level, hasTraderReferrer: tr, hasCreatorReferrer: cr });
    v.supply.push(supply.toString());
    v.units.push(units.toString());
    v.isBuy.push(side === 'buy');
    v.level.push(level);
    v.traderRef.push(tr);
    v.creatorRef.push(cr);
    v.base.push(q.base.toString());
    v.creatorFee.push(q.creatorFee.toString());
    v.protocolFee.push(q.protocolFee.toString());
    v.holderFee.push(q.holderFee.toString());
    v.referralFee.push(q.referralFee.toString());
    v.protocolTotal.push(q.protocolTotal.toString());
    v.total.push(q.total.toString());
  }
  return v;
}
