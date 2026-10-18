/**
 * Budget-aware request core for the X API v2.
 *
 * - Before every call a Redis counter `xbudget:<scope>:<endpoint>:<window>` is incremented for the current
 *   15-minute window. Past the endpoint's limit the call is refused with XBudgetExceeded (no request is sent).
 * - 429 and 5xx answers are retried with exponential backoff. A 429 whose reset is further away than
 *   `maxWaitMs` becomes XBudgetExceeded straight away, so callers can queue the work instead of blocking.
 */
import { XApiError, XAuthError, XBudgetExceeded } from './errors';

export const X_API_BASE = 'https://api.x.com';
export const BUDGET_WINDOW_MS = 15 * 60 * 1000;

/** Endpoint keys used for budgeting. */
export type XEndpoint =
  'users/me' | 'users/by/username' | 'users/lookup' | 'users/tweets' | 'users/following' | 'tweets/lookup';

/**
 * Default per-window limits, kept below X's published per-15-minute caps so one noisy job can never trip
 * the real limiter. Override per deployment through XContext.limits.
 */
export const DEFAULT_LIMITS: Record<XEndpoint, number> = {
  'users/me': 70,
  'users/by/username': 280,
  'users/lookup': 280,
  'users/tweets': 850,
  'users/following': 14,
  'tweets/lookup': 280,
};

/** Minimal counter store. An ioredis client satisfies it. */
export interface BudgetStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface XContext {
  /** Bearer token: a user's OAuth access token, or the app bearer token for public reads. */
  token: string | (() => Promise<string>);
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Omit to disable local budgeting (tests, one-off scripts). */
  budget?: BudgetStore | null;
  /** Budget namespace: 'app' for the bearer token, 'u:<id>' for a user token. */
  budgetScope?: string;
  limits?: Partial<Record<XEndpoint, number>>;
  /** Retries after the first attempt for 429/5xx/network errors. */
  maxRetries?: number;
  /** First backoff delay; doubles each retry. */
  backoffMs?: number;
  /** Longest a 429 may be waited out before giving up with XBudgetExceeded. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const windowStart = (now: number): number => Math.floor(now / BUDGET_WINDOW_MS) * BUDGET_WINDOW_MS;

async function spendBudget(ctx: XContext, endpoint: XEndpoint): Promise<void> {
  if (!ctx.budget) return;
  const now = (ctx.now ?? Date.now)();
  const start = windowStart(now);
  const key = `xbudget:${ctx.budgetScope ?? 'app'}:${endpoint}:${start}`;
  const used = await ctx.budget.incr(key);
  if (used === 1) await ctx.budget.expire(key, Math.ceil(BUDGET_WINDOW_MS / 1000) + 60);
  const limit = ctx.limits?.[endpoint] ?? DEFAULT_LIMITS[endpoint];
  if (used > limit) throw new XBudgetExceeded(endpoint, new Date(start + BUDGET_WINDOW_MS));
}

export type Query = Record<string, string | number | undefined>;

/** GET an X API v2 path and return its JSON body. */
export async function xGet<T>(
  ctx: XContext,
  endpoint: XEndpoint,
  path: string,
  query: Query = {},
): Promise<T> {
  await spendBudget(ctx, endpoint);
  const url = new URL(path, ctx.baseUrl ?? X_API_BASE);
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const token = typeof ctx.token === 'function' ? await ctx.token() : ctx.token;
  const f = ctx.fetch ?? fetch;
  const sleep = ctx.sleep ?? defaultSleep;
  const now = ctx.now ?? Date.now;
  const maxRetries = ctx.maxRetries ?? 3;
  const backoff = ctx.backoffMs ?? 500;
  const maxWait = ctx.maxWaitMs ?? 5_000;

  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    let networkError: unknown = null;
    try {
      res = await f(url.toString(), {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
    } catch (e) {
      networkError = e;
    }

    if (res && res.ok) return (await res.json()) as T;

    const delay = backoff * 2 ** attempt;
    if (res && res.status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset'));
      const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : now() + delay;
      const wait = Math.max(0, resetAt - now());
      if (wait > maxWait || attempt >= maxRetries)
        throw new XBudgetExceeded(endpoint, new Date(Math.max(resetAt, now())));
      await sleep(Math.max(wait, delay));
      continue;
    }
    if (networkError || (res && res.status >= 500)) {
      if (attempt >= maxRetries) {
        if (res)
          throw new XApiError(
            `X API ${endpoint} failed (${res.status})`,
            res.status,
            endpoint,
            await safeJson(res),
          );
        throw new XApiError(`X API ${endpoint} unreachable: ${String(networkError)}`, 0, endpoint);
      }
      await sleep(delay);
      continue;
    }
    const body = await safeJson(res!);
    if (res!.status === 401) throw new XAuthError(endpoint, body);
    throw new XApiError(`X API ${endpoint} failed (${res!.status})`, res!.status, endpoint, body);
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
