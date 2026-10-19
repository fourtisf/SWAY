import { describe, expect, it } from 'vitest';
import {
  LAUNCH_CURVE_SUPPLY,
  LAUNCH_TOTAL_SUPPLY,
  launchInitialCurve,
  launchMarketCap,
  launchMinOut,
  launchProgress,
  launchQuoteBuy,
  launchQuoteSell,
  launchStartCapUsd,
  launchSymbol,
} from '../src/launch';

const E18 = 10n ** 18n;

describe('launch curve (SwayLaunchpad port)', () => {
  it('symbol and start cap follow the prototype', () => {
    expect(launchSymbol('kenji_onchain99')).toBe('KENJIO');
    expect(launchSymbol('Nova.Reyes')).toBe('NOVARE');
    expect(launchStartCapUsd(82)).toBe(2000 + 82 * 60);
  });

  it('the start cap seeds the market cap (virtualEth = cap × 90%)', () => {
    const c = launchInitialCurve(E18);
    expect(c.virtualEth).toBe((E18 * LAUNCH_CURVE_SUPPLY) / LAUNCH_TOTAL_SUPPLY);
    expect(launchMarketCap(c)).toBe(E18);
    expect(launchProgress(E18, E18, 20n * E18)).toBe(0);
    expect(launchProgress(20n * E18, E18, 20n * E18)).toBe(1);
  });

  it('buy then sell never returns more than was paid, and charges 1% each way', () => {
    const c = launchInitialCurve(E18);
    const ethIn = E18 / 2n;
    const b = launchQuoteBuy(c, ethIn);
    expect(b.fee).toBe(ethIn / 100n);
    const after = { ...c, ethReserve: ethIn - b.fee, tokenReserve: c.tokenReserve - b.tokensOut };
    expect(launchMarketCap(after)).toBeGreaterThan(E18);
    const s = launchQuoteSell(after, b.tokensOut);
    expect(s.ethOut + s.fee).toBeLessThanOrEqual(after.ethReserve);
    expect(s.ethOut).toBeLessThan(ethIn);
    expect(launchMinOut(1000n)).toBe(990n);
  });
});
