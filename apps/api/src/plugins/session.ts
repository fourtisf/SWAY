/**
 * Sessions: an opaque random id in the signed httpOnly cookie `sway_sid`, stored in Redis as
 * `sess:<id>` → SessionData with a 30-day TTL. X tokens live only here (brief §12). Logout deletes it.
 */
import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionData } from '../deps';

export const SESSION_COOKIE = 'sway_sid';
export const REF_COOKIE = 'sway_ref';
export const SESSION_TTL_S = 30 * 24 * 3600;
const sessKey = (sid: string) => `sess:${sid}`;
/** [B] Every session id of a user, so account deletion can revoke them all. */
export const userSessionsKey = (userId: string) => `usess:${userId}`;

/** Registers cookie parsing and the session loader on the root instance (not encapsulated). */
export async function setupSession(app: FastifyInstance): Promise<void> {
  const { config, redis } = app.deps;
  await app.register(cookie, { secret: config.sessionSecret, hook: 'onRequest' });
  app.decorateRequest('sid', null);
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const un = req.unsignCookie(raw);
    if (!un.valid || !un.value) return;
    const data = await redis.get(sessKey(un.value));
    if (!data) return;
    try {
      req.session = JSON.parse(data) as SessionData;
      req.sid = un.value;
    } catch {
      /* corrupt session: treat as guest */
    }
  });
}

export function cookieOptions(secure: boolean) {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure, signed: true, maxAge: SESSION_TTL_S };
}

export async function createSession(
  req: FastifyRequest,
  reply: FastifyReply,
  data: Omit<SessionData, 'createdAt'>,
): Promise<string> {
  const { redis, config } = req.server.deps;
  if (req.sid) {
    await redis.del(sessKey(req.sid));
    if (req.session?.userId) await redis.srem(userSessionsKey(req.session.userId), req.sid);
  }
  const sid = randomBytes(32).toString('base64url');
  const session: SessionData = { ...data, createdAt: Date.now() };
  await redis
    .multi()
    .set(sessKey(sid), JSON.stringify(session), 'EX', SESSION_TTL_S)
    .sadd(userSessionsKey(data.userId), sid)
    .expire(userSessionsKey(data.userId), SESSION_TTL_S)
    .exec();
  reply.setCookie(SESSION_COOKIE, sid, cookieOptions(config.secureCookies));
  req.sid = sid;
  req.session = session;
  return sid;
}

/** Persists changes to req.session (e.g. a refreshed X token), keeping the remaining TTL. */
export async function saveSession(req: FastifyRequest): Promise<void> {
  if (!req.sid || !req.session) return;
  await req.server.deps.redis.set(sessKey(req.sid), JSON.stringify(req.session), 'KEEPTTL');
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.sid) {
    await req.server.deps.redis.del(sessKey(req.sid));
    if (req.session?.userId) await req.server.deps.redis.srem(userSessionsKey(req.session.userId), req.sid);
  }
  req.sid = null;
  req.session = null;
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Reads and clears nothing: the referral handle captured before sign-in (query, body or the `sway_ref` cookie). */
export function referralFrom(req: FastifyRequest, explicit?: string | null): string | null {
  const raw = explicit || req.cookies[REF_COOKIE] || null;
  if (!raw) return null;
  const un = req.unsignCookie(raw);
  const v = un.valid && un.value ? un.value : raw;
  const h = v
    .replace(/^@/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  return h || null;
}

/** [B] Deletes every session of a user (account deletion). Returns how many were live. */
export async function revokeUserSessions(
  redis: FastifyInstance['deps']['redis'],
  userId: string,
): Promise<number> {
  const sids = await redis.smembers(userSessionsKey(userId));
  const n = sids.length ? await redis.del(...sids.map(sessKey)) : 0;
  await redis.del(userSessionsKey(userId));
  return n;
}
