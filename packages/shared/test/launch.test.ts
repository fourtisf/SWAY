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
  normalizeSymbol,
  symbolProblem,
  tokenNameProblem,
} from '../src/launch';

const E18 = 10n ** 18n;

describe('launch curve (SwayLaunchpad port)', () => {
  it('suggests a ticker from the display name, else the handle; the start cap follows the prototype', () => {
    expect(launchSymbol('swaydotfamily', 'Sway', true)).toBe('SWAY');
    expect(launchSymbol('novareyes', 'Nova Reyes')).toBe('NOVAREYES');
    expect(launchSymbol('kenji_onchain99', 'Kenji 🌊 on-chain builder')).toBe('KENJIONCHA');
    // Only the official account gets the protocol's own ticker.
    expect(launchSymbol('swayfan', 'Sway')).toBe('SWAYFAN');
    expect(launchStartCapUsd(82)).toBe(2000 + 82 * 60);
  });

  it('checks the ticker and name a creator picks', () => {
    expect(normalizeSymbol(' $sway ')).toBe('SWAY');
    expect(symbolProblem('SWAY', true)).toBeNull();
    expect(symbolProblem('SWAY')).toMatch(/reserved/);
    expect(symbolProblem('1INCH')).toBeNull();
    expect(symbolProblem('A')).toMatch(/2 to 10/);
    expect(symbolProblem('TOOLONGTICKER')).toMatch(/2 to 10/);
    expect(symbolProblem('NO-DASH')).toMatch(/2 to 10/);
    expect(tokenNameProblem(' Sway ')).toBeNull();
    expect(tokenNameProblem('  ')).toMatch(/name/);
    expect(tokenNameProblem('x'.repeat(33))).toMatch(/33/);
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
