/** X clients and the session's OAuth token (refreshed transparently with the refresh token). */
import type { FastifyRequest } from 'fastify';
import { createXClient, refreshAccessToken, type XClient } from '@sway/x';
import type { AppDeps } from '../deps';
import { saveSession } from '../plugins/session';

export function xClient(deps: AppDeps, token: string, budgetScope: string): XClient {
  return createXClient({ token, fetch: deps.xFetch, budget: deps.redis, budgetScope });
}

/** A valid user access token from the session, or null (no token, expired and not refreshable). */
export async function sessionXToken(req: FastifyRequest): Promise<string | null> {
  const x = req.session?.x;
  if (!x) return null;
  if (x.expiresAt > Date.now() + 60_000) return x.accessToken;
  const { config, xFetch } = req.server.deps;
  if (!x.refreshToken || !config.x.clientId) return null;
  try {
    const t = await refreshAccessToken({
      clientId: config.x.clientId,
      clientSecret: config.x.clientSecret ?? undefined,
      refreshToken: x.refreshToken,
      fetch: xFetch,
    });
    req.session!.x = {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken ?? x.refreshToken,
      expiresAt: t.expiresAt,
    };
    await saveSession(req);
    return t.accessToken;
  } catch (e) {
    req.log.warn({ err: e }, 'X token refresh failed');
    return null;
  }
}
