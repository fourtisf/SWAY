import { describe, expect, it } from 'vitest';
import {
  area,
  areaWei,
  cumulativeWei,
  ethToWei,
  feePercent,
  feesWei,
  keysToUnits,
  maxBuyUnits,
  priceAt,
  priceWei,
  quote,
  quoteWei,
  reserveWei,
  unitsToKeys,
  weiToEth,
} from '../src';

const eth = (wei: bigint) => weiToEth(wei);

describe('reference prices from the brief', () => {
  it('first, 10th and 100th key', () => {
    expect(priceAt(1)).toBeCloseTo(0.0001575, 12);
    expect(priceAt(10)).toBeCloseTo(0.00252, 12);
    expect(priceAt(100)).toBeCloseTo(0.18207, 10);
    expect(priceWei(100n)).toBe(157_500_000_000_000n);
    expect(priceWei(1_000n)).toBe(2_520_000_000_000_000n);
    expect(priceWei(10_000n)).toBe(182_070_000_000_000_000n);
  });

  it('area matches K/3 * ((b+O)^3 - (a+O)^3)', () => {
    // 1 -> 2 keys: K/3 * (64 - 27) = K * 37 / 3
    expect(eth(areaWei(100n, 200n))).toBeCloseTo((0.0000175 * 37) / 3, 15);
    expect(area(1, 2)).toBeCloseTo((0.0000175 * 37) / 3, 15);
  });
});

describe('wei math agrees with the prototype float math', () => {
  const cases: Array<[number, 'buy' | 'sell', number, number]> = [
    [1, 'buy', 1, 0],
    [1, 'buy', 0.01, 0],
    [4.37, 'buy', 2.5, 0.25],
    [23.11, 'sell', 3.2, 0.5],
    [48, 'sell', 0.1, 0.75],
    [150.5, 'buy', 12, 0.1],
  ];
  for (const [supply, side, amt, cut] of cases) {
    it(`${side} ${amt} at supply ${supply} with cut ${cut}`, () => {
      const level = [0, 0.1, 0.25, 0.5, 0.75].indexOf(cut);
      const f = quote(supply, side, amt, cut);
      const w = quoteWei(keysToUnits(supply), side, keysToUnits(amt), { level });
      const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-18, Math.abs(b));
      expect(rel(eth(w.base), f.base)).toBeLessThan(1e-9);
      expect(rel(eth(w.total), f.total)).toBeLessThan(1e-9);
      expect(rel(eth(w.creatorFee), f.creator)).toBeLessThan(1e-9);
      expect(rel(eth(w.protocolFee), f.protocol)).toBeLessThan(1e-9);
      expect(rel(eth(w.holderFee), f.holders)).toBeLessThan(1e-9);
      expect(rel(eth(w.referralFee), f.ref)).toBeLessThan(1e-9);
      expect(rel(eth(w.priceAfter), f.after)).toBeLessThan(1e-9);
    });
  }
});

describe('fees', () => {
  it('buy pays base * 1.10, sell receives base * 0.90 at level 0', () => {
    const q = quoteWei(1_000n, 'buy', 100n);
    expect(q.totalFee).toBe(q.creatorFee + q.protocolFee + q.holderFee + q.referralFee);
    expect(q.total).toBe(q.base + q.totalFee);
    const s = quoteWei(1_100n, 'sell', 100n);
    expect(s.base).toBe(q.base);
    expect(s.total).toBe(s.base - s.totalFee);
    expect(feePercent(0)).toBe(10);
    expect(feePercent(0.75)).toBe(9);
  });

  it('staking level cuts only the protocol fee', () => {
    const base = 1_000_000_000_000_000n;
    expect(feesWei(base, { level: 0 }).protocolFee).toBe(20_000_000_000_000n);
    expect(feesWei(base, { level: 1 }).protocolFee).toBe(18_000_000_000_000n);
    expect(feesWei(base, { level: 2 }).protocolFee).toBe(15_000_000_000_000n);
    expect(feesWei(base, { level: 3 }).protocolFee).toBe(10_000_000_000_000n);
    expect(feesWei(base, { level: 4 }).protocolFee).toBe(5_000_000_000_000n);
    expect(feesWei(base, { level: 4 }).creatorFee).toBe(60_000_000_000_000n);
  });

  it('missing referral halves go to protocol, total unchanged', () => {
    const base = 123_456_789_012_345n;
    const none = feesWei(base);
    const both = feesWei(base, { hasTraderReferrer: true, hasCreatorReferrer: true });
    const one = feesWei(base, { hasTraderReferrer: true });
    expect(none.totalFee).toBe(both.totalFee);
    expect(none.protocolTotal).toBe(none.protocolFee + none.referralFee);
    expect(both.protocolTotal).toBe(both.protocolFee);
    expect(both.traderReferrerShare + both.creatorReferrerShare).toBe(both.referralFee);
    expect(one.protocolTotal).toBe(one.protocolFee + one.referralFee - one.traderReferrerShare);
    expect(none.stakerShare + none.treasuryShare).toBe(none.protocolTotal);
  });
});

describe('path independence and reserves', () => {
  it('splitting a buy never changes its cost', () => {
    const whole = areaWei(137n, 1_337n);
    let sum = 0n;
    for (let s = 137n; s < 1_337n; s += 7n) sum += areaWei(s, s + 7n > 1_337n ? 1_337n : s + 7n);
    expect(sum).toBe(whole);
  });

  it('reserve equals what buyers paid in base', () => {
    let supply = 100n;
    let paid = 0n;
    for (const u of [1n, 33n, 250n, 4n, 999n]) {
      paid += quoteWei(supply, 'buy', u).base;
      supply += u;
    }
    expect(reserveWei(supply)).toBe(paid);
    expect(reserveWei(100n)).toBe(0n);
    expect(cumulativeWei(supply) - cumulativeWei(100n)).toBe(paid);
  });

  it('cannot sell the locked first key', () => {
    expect(() => quoteWei(150n, 'sell', 51n)).toThrow();
    expect(quoteWei(150n, 'sell', 50n).supplyAfter).toBe(100n);
  });
});

describe('helpers', () => {
  it('unit conversion', () => {
    expect(keysToUnits(1)).toBe(100n);
    expect(keysToUnits('0,01')).toBe(1n);
    expect(keysToUnits(0.1 + 0.2)).toBe(30n);
    expect(unitsToKeys(250n)).toBe(2.5);
    expect(ethToWei('0.0001575')).toBe(157_500_000_000_000n);
    expect(ethToWei('1')).toBe(10n ** 18n);
  });

  it('maxBuyUnits fits the budget', () => {
    const budget = ethToWei('0.75');
    const u = maxBuyUnits(500n, budget);
    expect(quoteWei(500n, 'buy', u).total).toBeLessThanOrEqual(budget);
    expect(quoteWei(500n, 'buy', u + 1n).total).toBeGreaterThan(budget);
  });
});
