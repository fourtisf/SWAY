/**
 * ETH/USD. The workers write Redis `price:ethusd` (refreshed ≤ 60s); the API only reads it and falls back to
 * ETH_USD_FALLBACK. Accepts a bare number or JSON ({ ethUsd | usd | price | amount, at? }).
 */
import type { Redis } from 'ioredis';

export const PRICE_KEY = 'price:ethusd';
const STALE_MS = 10 * 60 * 1000;

let memo: { at: number; value: { ethUsd: number; source: 'live' | 'fallback' } } | null = null;

export function parsePrice(raw: string | null): { ethUsd: number; at: number | null } | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return { ethUsd: n, at: null };
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const v = Number(j.ethUsd ?? j.usd ?? j.price ?? j.amount ?? (j.data as Record<string, unknown> | undefined)?.amount);
    if (!Number.isFinite(v) || v <= 0) return null;
    const atRaw = j.at ?? j.ts ?? j.updatedAt;
    const at = typeof atRaw === 'number' ? atRaw : typeof atRaw === 'string' ? Date.parse(atRaw) : null;
    return { ethUsd: v, at: at && Number.isFinite(at) ? at : null };
  } catch {
    return null;
  }
}

export async function getEthUsd(redis: Redis, fallback: number): Promise<{ ethUsd: number; source: 'live' | 'fallback' }> {
  const now = Date.now();
  if (memo && now - memo.at < 5_000) return memo.value;
  let value: { ethUsd: number; source: 'live' | 'fallback' } = { ethUsd: fallback, source: 'fallback' };
  try {
    const p = parsePrice(await redis.get(PRICE_KEY));
    if (p && (p.at === null || now - p.at < STALE_MS)) value = { ethUsd: p.ethUsd, source: 'live' };
  } catch {
    /* Redis hiccup: use the fallback */
  }
  memo = { at: now, value };
  return value;
}

/** Test hook. */
export const resetPriceMemo = () => {
  memo = null;
};
