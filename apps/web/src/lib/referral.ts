'use client';
/** Invite capture: /i/:handle or ?ref= on any page. Passed to X sign-in and dev login as `ref`. */
import { normalizeHandle } from '@sway/shared';

const KEY = 'sway.ref';

export function saveRef(handle: string) {
  const h = normalizeHandle(handle);
  if (!h) return;
  try {
    localStorage.setItem(KEY, h);
  } catch {
    /* storage blocked */
  }
  // The API also reads this first-party cookie (sent through the /api proxy).
  document.cookie = `sway_ref=${encodeURIComponent(h)}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
}

export function loadRef(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
