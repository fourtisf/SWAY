/** Small helpers shared by components (ported from the prototype's utils). */
import { hash } from '@sway/shared';

/** mulberry32, the prototype's rng(). */
export function rng(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const AV_BG = ['c0aede', 'b6e3f4', 'd1d4f9', 'ffd5dc', 'c7f0e4', 'e7dcff'];

export function initials(name: string, handle: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9 ]/g, '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || (handle || '?')[0]!.toUpperCase()
  );
}

export function dicebear(handle: string, claimed?: boolean): string {
  const style = claimed === false ? 'shapes' : 'notionists';
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(handle)}&backgroundColor=${AV_BG[hash(handle) % AV_BG.length]}`;
}

/** Top-level app routes; any other single segment is a profile handle. */
export const ROUTE_NAMES = ['explore', 'markets', 'notifications', 'messages', 'tasks', 'wallet', 'leaderboard', 'battles', 'launchpad', 'genesis', 'model'] as const;

export function routeOf(pathname: string): { view: string; arg: string | null } {
  const seg = pathname.split('/').filter(Boolean);
  if (!seg.length) return { view: 'home', arg: null };
  const first = decodeURIComponent(seg[0]!);
  if ((ROUTE_NAMES as readonly string[]).includes(first)) return { view: first, arg: seg[1] ? decodeURIComponent(seg[1]) : null };
  return { view: 'profile', arg: first.toLowerCase() };
}

export const shareCardUrl = (score: number, valueUsd: string) =>
  'https://x.com/intent/post?text=' +
  encodeURIComponent(`My Sway score is ${score}/100 and my reach is valued at ${valueUsd}. Buy my key and join my room.`);

export const plainText = (rich: Array<{ t: string }>) => rich.map((s) => s.t).join('');
