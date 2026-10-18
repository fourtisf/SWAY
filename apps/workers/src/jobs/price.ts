import type { Clients } from '../clients';
import { PRICE_KEY } from '../clients';

/** Reads ETH/USD from ETH_USD_FEED_URL into Redis (refreshed every ≤60s; brief §3). */
export async function refreshPrice(c: Clients): Promise<number | null> {
  const url = c.cfg.ethUsdFeedUrl;
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const v = parsePrice(await res.json());
    if (!v) throw new Error('unrecognised price payload');
    await c.redis.set(PRICE_KEY, String(v), 'EX', 600);
    await c.publish({ kind: 'price', ethUsd: v });
    return v;
  } catch (e) {
    console.warn(`[price] ${url}: ${(e as Error).message}; keeping the last price`);
    return null;
  }
}

/** Accepts Coinbase spot ({data:{amount}}), {price}, {usd}, CoinGecko ({ethereum:{usd}}) and {USD}. */
export function parsePrice(j: unknown): number | null {
  const o = j as Record<string, any>;
  const v = Number(o?.data?.amount ?? o?.price ?? o?.usd ?? o?.ethereum?.usd ?? o?.USD);
  return Number.isFinite(v) && v > 0 ? v : null;
}
