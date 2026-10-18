/**
 * OAuth 2.0 Authorization Code with PKCE for X (read-only scopes). Tokens are returned to the caller and
 * must live only in the session store, never in the database (brief §12).
 */
import { createHash, randomBytes } from 'node:crypto';
import { XApiError } from './errors';

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const X_SCOPES = ['tweet.read', 'users.read', 'follows.read', 'offline.access'] as const;

const b64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 43-char code verifier (32 random bytes, base64url), within RFC 7636's 43..128 range. */
export const generateCodeVerifier = (): string => b64url(randomBytes(32));

/** S256 code challenge for a verifier. */
export const codeChallenge = (verifier: string): string => b64url(createHash('sha256').update(verifier).digest());

/** Opaque CSRF state. */
export const generateState = (): string => b64url(randomBytes(24));

export interface AuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
  authorizeUrl?: string;
}

export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const u = new URL(p.authorizeUrl ?? X_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', (p.scopes ?? X_SCOPES).join(' '));
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export interface XTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope?: string;
}

export interface TokenClientOptions {
  clientId: string;
  /** Confidential clients authenticate with HTTP Basic; public clients send client_id in the body. */
  clientSecret?: string;
  fetch?: typeof fetch;
  tokenUrl?: string;
  now?: () => number;
}

async function tokenRequest(opts: TokenClientOptions, body: Record<string, string>): Promise<XTokens> {
  const f = opts.fetch ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (opts.clientSecret) {
    headers.authorization = 'Basic ' + Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
  }
  const res = await f(opts.tokenUrl ?? X_TOKEN_URL, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ ...body, client_id: opts.clientId }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== 'string') {
    throw new XApiError(`X token endpoint failed (${res.status})`, res.status, 'oauth2/token', json);
  }
  const now = (opts.now ?? Date.now)();
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 7200;
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresAt: now + expiresIn * 1000,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
}

export function exchangeCode(
  opts: TokenClientOptions & { code: string; redirectUri: string; codeVerifier: string },
): Promise<XTokens> {
  return tokenRequest(opts, {
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
}

export function refreshAccessToken(opts: TokenClientOptions & { refreshToken: string }): Promise<XTokens> {
  return tokenRequest(opts, { grant_type: 'refresh_token', refresh_token: opts.refreshToken });
}
