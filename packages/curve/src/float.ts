/**
 * The prototype's float curve math, ported verbatim (sway-prototype.html: priceAt, area, quote).
 * Use it for charts and instant UI previews. Anything that moves money uses ./wei instead.
 * Supply here is in keys (1 unit = 0.01 key).
 */
import { CURVE, FEE_TOTAL } from './constants';

export const priceAt = (s: number): number => CURVE.K * Math.pow(s + CURVE.O, 2);

export const area = (a: number, b: number): number =>
  (CURVE.K / 3) * (Math.pow(b + CURVE.O, 3) - Math.pow(a + CURVE.O, 3));

export interface QuoteFloat {
  base: number;
  creator: number;
  protocol: number;
  holders: number;
  ref: number;
  total: number;
  after: number;
}

/** Same as the prototype's quote(c, side, amt) with `levelCut` passed in instead of read from S. */
export function quote(supply: number, side: 'buy' | 'sell', amt: number, levelCut = 0): QuoteFloat {
  amt = Math.max(0, +amt || 0);
  const pf = CURVE.PROTOCOL * (1 - levelCut);
  const feeRate = CURVE.CREATOR + CURVE.HOLDERS + CURVE.REF + pf;
  const base = side === 'buy' ? area(supply, supply + amt) : area(supply - amt, supply);
  return {
    base,
    creator: base * CURVE.CREATOR,
    protocol: base * pf,
    holders: base * CURVE.HOLDERS,
    ref: base * CURVE.REF,
    total: side === 'buy' ? base * (1 + feeRate) : base * (1 - feeRate),
    after: priceAt(side === 'buy' ? supply + amt : supply - amt),
  };
}

/** Fee percentage shown in the trade sheet ("Includes 10% in fees"). */
export const feePercent = (levelCut = 0): number => Math.round((FEE_TOTAL - CURVE.PROTOCOL * levelCut) * 100);

/** Sell value of `held` keys after fees, as the prototype's holdValue() computes it. */
export const sellValue = (supply: number, held: number): number => area(supply - held, supply) * (1 - FEE_TOTAL);
