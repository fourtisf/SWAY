/**
 * Sign-in: X OAuth 2.0 PKCE (read-only scopes) and, in local dev only, POST /api/auth/dev. Both end in the
 * same upsertMember path and a fresh session.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  buildAuthorizeUrl,
  codeChallenge,
  exchangeCode,
  generateCodeVerifier,
  generateState,
  isXBudgetExceeded,
  scoreXAccount,
  XAuthError,
} from '@sway/x';
import { inputsFromProfile, score, type ScoreInputs } from '@sway/scoring';
import { OFFICIAL_HANDLE, normalizeHandle, type MeDTO } from '@sway/shared';
import { body, query } from './_util';
import { getViewer, requireViewer } from '../plugins/auth';
import { createSession, destroySession, referralFrom } from '../plugins/session';
import { badRequest, forbidden, unauthorized, unavailable } from '../errors';
import { buildMe } from '../services/me';
import {
  devXId,
  makeDevProfile,
  upsertMember,
  type MemberProfile,
  type MemberScore,
} from '../services/users';
import { xClient } from '../services/xauth';
import { bootstrapAdmin } from '../services/social';

const OAUTH_TTL_S = 600;
const oauthKey = (state: string) => `oauth:${state}`;

/** Only same-site relative paths: no scheme, no protocol-relative '//' and no backslashes. */
export function safeRedirect(r: unknown): string {
  if (typeof r !== 'string' || !r.startsWith('/') || r.startsWith('//') || r.includes('\\') || r.length > 300)
    return '/';
  return r;
}

const withParam = (path: string, kv: string) => path + (path.includes('?') ? '&' : '?') + kv;

export async function authRoutes(app: FastifyInstance) {
  const { config, prisma, redis } = app.deps;
  const authLimit = { rateLimit: { max: config.rateLimit.authMax, timeWindow: '1 minute' } };

  app.get('/me', async (req): Promise<MeDTO> => {
    const v = await getViewer(req);
    if (!v) throw unauthorized();
    return buildMe(prisma, v);
  });

  app.get('/auth/x/start', { config: authLimit }, async (req, reply) => {
    if (!config.x.enabled || !config.x.clientId)
      throw unavailable('x_disabled', 'Sign in with X is not configured on this server');
    const q = query(z.object({ redirect: z.string().optional(), ref: z.string().max(40).optional() }), req);
    const state = generateState();
    const verifier = generateCodeVerifier();
    await redis.set(
      oauthKey(state),
      JSON.stringify({ verifier, redirect: safeRedirect(q.redirect), ref: referralFrom(req, q.ref ?? null) }),
      'EX',
      OAUTH_TTL_S,
    );
    const url = buildAuthorizeUrl({
      clientId: config.x.clientId,
      redirectUri: config.x.callbackUrl,
      state,
      codeChallenge: codeChallenge(verifier),
    });
    return reply.redirect(url, 302);
  });

  app.get('/auth/x/callback', { config: authLimit }, async (req, reply) => {
    const q = query(
      z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }),
      req,
    );
    const fail = (code: string) =>
      reply.redirect(withParam(`${config.webUrl}/`, `auth_error=${encodeURIComponent(code)}`), 302);
    if (q.error) return fail(q.error === 'access_denied' ? 'denied' : 'x_error');
    if (!q.code || !q.state || !config.x.clientId) return fail('invalid_request');
    const raw = await redis.getdel(oauthKey(q.state));
    if (!raw) return fail('state_expired');
    const st = JSON.parse(raw) as { verifier: string; redirect: string; ref: string | null };

    try {
      const tokens = await exchangeCode({
        clientId: config.x.clientId,
        clientSecret: config.x.clientSecret ?? undefined,
        code: q.code,
        redirectUri: config.x.callbackUrl,
        codeVerifier: st.verifier,
        fetch: app.deps.xFetch,
      });
      const tokScope = 'tok:' + createHash('sha256').update(tokens.accessToken).digest('hex').slice(0, 16);
      const me = await xClient(app.deps, tokens.accessToken, tokScope).getMe();
      // When the posts can't be read (X budget spent, or an API plan without user timelines), the score still
      // follows today's profile (followers, account age, badge) with the engagement and cadence of the last read
      // that had posts (none for a new member); a refresh-score job re-scores in full once the read works.
      let scored: MemberScore | null = null;
      let refresh = false;
      try {
        const posts = await xClient(app.deps, tokens.accessToken, `x:${me.id}`).getRecentPosts(me.id, 50);
        const { inputs, result } = scoreXAccount(me, posts);
        scored = { inputs, score: result.score, value: result.value };
      } catch (e) {
        req.log.warn({ err: e, xId: me.id }, 'X posts unreadable at sign-in; scoring later');
        const known = await prisma.user.findUnique({ where: { xId: me.id }, select: { scoreInputs: true } });
        const inputs = inputsFromProfile(
          { followers: me.followers, createdAt: me.createdAt ?? new Date(), verified: me.verified },
          (known?.scoreInputs as ScoreInputs | null) ?? null,
        );
        const result = score(inputs);
        scored = { inputs, score: result.score, value: result.value };
        refresh = true;
      }
      const profile: MemberProfile = {
        xId: me.id,
        handle: me.username,
        name: me.name,
        avatarUrl: me.profileImageUrl,
        bio: me.description,
        followers: me.followers,
        verified: me.verified,
        xCreatedAt: me.createdAt ? new Date(me.createdAt) : null,
      };
      const { user } = await upsertMember(prisma, profile, scored, { ref: st.ref });
      await bootstrapAdmin(prisma, config, user.id, user.handle); // [B]
      // The X account behind OFFICIAL_HANDLE is Sway's own: pinned posts, the gold badge, points notifications.
      if (user.handle === OFFICIAL_HANDLE && !user.official) await prisma.user.update({ where: { id: user.id }, data: { official: true } });
      if (refresh) await app.deps.jobs.enqueueRefreshScore(user.id).catch(() => undefined);
      await createSession(req, reply, {
        userId: user.id,
        x: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        },
      });
      return reply.redirect(withParam(`${config.webUrl}${st.redirect}`, 'onboard=1'), 302);
    } catch (e) {
      req.log.warn({ err: e }, 'X sign-in failed');
      if (isXBudgetExceeded(e)) return fail('x_budget');
      if (e instanceof XAuthError) return fail('x_auth');
      return fail('x_error');
    }
  });

  const DevBody = z.object({
    handle: z.string().trim().min(1).max(30),
    followers: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
    ref: z.string().max(40).optional(),
  });

  app.post('/auth/dev', { config: authLimit }, async (req, reply): Promise<MeDTO> => {
    if (!config.devAuth) throw forbidden('dev_auth_disabled', 'Dev sign-in is disabled');
    const b = body(DevBody, req);
    const handle = normalizeHandle(b.handle) || 'you';
    if (!/^[a-z0-9_]{1,30}$/.test(handle))
      throw badRequest('invalid_handle', 'Handles use letters, digits and _');
    const ref = referralFrom(req, b.ref ?? null);

    const existing = await prisma.user.findUnique({ where: { handle } });
    if (existing?.deletedAt) throw badRequest('invalid_handle', 'That account was deleted'); // [B]
    let userId: string;
    if (existing && existing.xId !== devXId(handle)) {
      // A seeded or real account: sign in as it (dev only), upgrading a fan-market placeholder to a member.
      const { user } = await upsertMember(
        prisma,
        {
          xId: existing.xId,
          handle: existing.handle,
          name: existing.name,
          avatarUrl: existing.avatarUrl,
          bio: existing.bio,
          followers: existing.followers,
          verified: existing.verified,
          xCreatedAt: existing.xCreatedAt,
        },
        null,
        { ref },
      );
      userId = user.id;
    } else {
      const { profile, scored } = makeDevProfile(handle, b.followers);
      const { user } = await upsertMember(prisma, profile, scored, { ref });
      userId = user.id;
    }
    await bootstrapAdmin(prisma, config, userId, handle); // [B]
    await createSession(req, reply, { userId, dev: true });
    return buildMe(prisma, await requireViewer(req));
  });

  app.post('/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });
}
