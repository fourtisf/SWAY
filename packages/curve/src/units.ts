import { UNITS_PER_KEY, WEI_PER_ETH } from './constants';

/** Keys (as typed in the trade sheet, 2 decimals) to integer units. */
export function keysToUnits(keys: number | string): bigint {
  const v = typeof keys === 'string' ? parseFloat(keys.replace(',', '.')) : keys;
  if (!Number.isFinite(v) || v <= 0) return 0n;
  return BigInt(Math.round(v * Number(UNITS_PER_KEY)));
}

export function unitsToKeys(units: bigint | number | string): number {
  return Number(BigInt(units)) / Number(UNITS_PER_KEY);
}

/** Wei to ETH as a float, for display only. */
export function weiToEth(wei: bigint | string | number): number {
  const w = BigInt(wei);
  const whole = w / WEI_PER_ETH;
  const frac = w % WEI_PER_ETH;
  return Number(whole) + Number(frac) / 1e18;
}

/** ETH (decimal string or number) to wei, truncating beyond 18 decimals. */
export function ethToWei(eth: string | number): bigint {
  const s = typeof eth === 'number' ? eth.toFixed(18) : eth.trim();
  const neg = s.startsWith('-');
  const [w = '0', f = ''] = s.replace(/^-/, '').split('.');
  const wei = BigInt(w || '0') * WEI_PER_ETH + BigInt((f + '0'.repeat(18)).slice(0, 18) || '0');
  return neg ? -wei : wei;
}

export function weiToUsd(wei: bigint | string, ethUsd: number): number {
  return weiToEth(wei) * ethUsd;
}

export function usdToWei(usd: number, ethUsd: number): bigint {
  if (ethUsd <= 0) return 0n;
  return ethToWei((usd / ethUsd).toFixed(18));
}
