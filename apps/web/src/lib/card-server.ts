/**
 * [B] Server-side card data for /card/:handle metadata and its OG image. Real mode asks the API (API_URL);
 * mock mode rebuilds the card from the prototype seed, since the mock world only lives in the browser.
 */
import { priceWei } from '@sway/curve';
import { scorePoints, tierOf } from '@sway/scoring';
import { normalizeHandle, type CardDTO } from '@sway/shared';
import { CREATORS_SEED, FAN_SEED, OFFICIAL, makeUser, mkCreator, mkFan } from './mock/seed';

function mockCard(handle: string): CardDTO {
  const seeded = CREATORS_SEED.find((c) => c[1] === handle);
  const fan = Object.entries(FAN_SEED).flatMap(([cat, rows]) => rows.map((r) => [cat, ...r] as const)).find((r) => r[2] === handle);
  const c = seeded ? mkCreator(...seeded) : fan ? mkFan(fan[0] as 'crypto', fan[1], fan[2], fan[3]) : null;
  if (c)
    return {
      handle,
      name: c.name,
      avatarUrl: null,
      verified: c.verified,
      claimed: c.claimed,
      score: c.score,
      reachValue: c.value,
      followers: c.followers,
      tier: tierOf(scorePoints(c.score)).name,
      memberNo: c.claimed ? c.memberNo : null,
      priceWei: priceWei(BigInt(Math.round(c.supply * 100))).toString(),
    };
  const u = makeUser(handle);
  return {
    handle: u.handle,
    name: handle === OFFICIAL.handle ? OFFICIAL.name : u.name,
    avatarUrl: null,
    verified: u.verified,
    claimed: true,
    official: handle === OFFICIAL.handle,
    score: u.score,
    reachValue: u.value,
    followers: u.followers,
    tier: tierOf(scorePoints(u.score)).name,
    memberNo: u.memberNo,
    priceWei: priceWei(100n).toString(),
  };
}

export async function fetchCard(raw: string): Promise<CardDTO | null> {
  const handle = normalizeHandle(decodeURIComponent(raw));
  if (!handle) return null;
  if (process.env.NEXT_PUBLIC_API_MOCK === '1') return mockCard(handle);
  const base = (process.env.API_URL || 'http://localhost:4000').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/api/users/${encodeURIComponent(handle)}/card`, { next: { revalidate: 300 } });
    return r.ok ? ((await r.json()) as CardDTO) : null;
  } catch {
    return null;
  }
}

/** Absolute site URL for OG tags (X needs absolute image URLs). */
export const siteUrl = () => (process.env.NEXT_PUBLIC_SITE_URL || process.env.WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
