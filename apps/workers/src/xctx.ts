import type { XContext } from '@sway/x';
import type { Clients } from './clients';

/** App-only X context (bearer token) with the shared Redis budget. Null when X isn't configured. */
export function appXContext(c: Clients): XContext | null {
  if (!c.cfg.xBearer) return null;
  return { token: c.cfg.xBearer, budget: c.redis, budgetScope: 'app' };
}
