/** Errors thrown by the X client. Callers map them to HTTP responses or job retries. */

export class XApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'XApiError';
  }
}

/** The access token is missing, expired or revoked (HTTP 401). Refresh it or ask the user to sign in again. */
export class XAuthError extends XApiError {
  constructor(endpoint: string, body?: unknown) {
    super('X rejected the access token', 401, endpoint, body);
    this.name = 'XAuthError';
  }
}

/**
 * The local budget for this endpoint is spent for the current 15-minute window, or X itself answered 429
 * with a reset too far away to wait for. Routes turn this into 503 `x_budget`; jobs retry after `resetAt`.
 */
export class XBudgetExceeded extends Error {
  constructor(
    readonly endpoint: string,
    readonly resetAt: Date,
  ) {
    super(`X API budget exhausted for ${endpoint} until ${resetAt.toISOString()}`);
    this.name = 'XBudgetExceeded';
  }
}

export const isXBudgetExceeded = (e: unknown): e is XBudgetExceeded =>
  e instanceof XBudgetExceeded || (e as { name?: string } | null)?.name === 'XBudgetExceeded';
