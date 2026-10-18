/**
 * Display formatters, ported from the prototype's `F` object. `$` takes an ETH amount and converts it
 * with the live ETH/USD price, so build one with makeFormat(ethUsd) wherever prices are shown.
 */

export interface Format {
  eth(v: number): string;
  /** ETH amount shown in dollars. */
  $(eth: number): string;
  n(v: number): string;
  /** Dollar amount (already in USD), compact. */
  usd(v: number): string;
  int(v: number): string;
  pct(v: number): string;
  keys(v: number): string;
  /** Minutes ago → "now" / "5m" / "3h" / "2d". */
  ago(minutes: number): string;
}

export function makeFormat(ethUsd: number): Format {
  return {
    eth(v) {
      if (!v) return '0';
      const a = Math.abs(v);
      return a >= 10 ? v.toFixed(2) : a >= 1 ? v.toFixed(3) : a >= 0.01 ? v.toFixed(4) : a >= 0.0001 ? v.toFixed(5) : v.toFixed(7);
    },
    $(eth) {
      const v = eth * ethUsd;
      const a = Math.abs(v);
      if (a === 0) return '$0';
      if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
      if (a >= 1e4) return '$' + (v / 1e3).toFixed(1) + 'K';
      if (a >= 1000) return '$' + Math.round(v).toLocaleString('en-US');
      if (a >= 0.01) return '$' + v.toFixed(2);
      return '$' + v.toFixed(3);
    },
    n(v) {
      v = +v;
      const a = Math.abs(v);
      if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
      if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
      return String(Math.round(v));
    },
    usd(v) {
      return '$' + (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : Math.round(v));
    },
    int(v) {
      return Math.round(v).toLocaleString('en-US');
    },
    pct(v) {
      return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
    },
    keys(v) {
      return (Math.round(v * 100) / 100).toString();
    },
    ago(m) {
      if (m < 1) return 'now';
      if (m < 60) return Math.round(m) + 'm';
      if (m < 1440) return Math.round(m / 60) + 'h';
      return Math.round(m / 1440) + 'd';
    },
  };
}

export const minutesSince = (iso: string | number | Date, now = Date.now()): number =>
  (now - new Date(iso).getTime()) / 60000;

/** Deterministic string hash (FNV-1a), the prototype's hash(); used for avatar colours and seeds. */
export function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const hueOf = (handle: string): number => (hash(handle) % 110) + 210;

export const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Normalises an X handle: strips @, lowercases, keeps [a-z0-9_]. */
export const normalizeHandle = (h: string): string =>
  h.replace(/^@/, '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
