import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { score, type ScoreInputs } from '@sway/scoring';
import { codeChallenge } from '@sway/x';
import type { MeDTO } from '@sway/shared';
import { devXId, makeDevProfile } from '../src/services/users';
import { cookieOf, fanMarket, login, makeApp, prisma, resetState, type TestCtx } from './helpers';

/** Pulls named functions out of the prototype HTML so parity is checked against the real source. */
function prototypeFns(): { makeUser: (h: string, f?: number) => any } {
  const html = readFileSync(
    fileURLToPath(new URL('../../../docs/sway-prototype.html', import.meta.url)),
    'utf8',
  );
  const grab = (sig: string) => {
    const i = html.indexOf(sig);
    if (i < 0) throw new Error(`missing ${sig}`);
    let depth = 0;
    for (let j = html.indexOf('{', html.indexOf(')', i)); j < html.length; j++) {
      if (html[j] === '{') depth++;
      else if (html[j] === '}' && --depth === 0) return html.slice(i, j + 1);
    }
    throw new Error(`unterminated ${sig}`);
  };
  const src = ['function hash(', 'function rng(', 'function scoreModel(', 'function makeUser(']
    .map(grab)
    .join('\n');
  return { makeUser: new Function(`${src}; return makeUser;`)() };
}

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
beforeEach(() => resetState(ctx.redis));
afterAll(() => ctx.close());

describe('dev sign-in', () => {
  it('reproduces the prototype makeUser() for the same handle', () => {
    const { makeUser } = prototypeFns();
    for (const h of ['alice', 'Bob_99', '@kenjionchain', 'zz']) {
      const proto = makeUser(h);
      const ours = makeDevProfile(h);
      expect(ours.profile.handle).toBe(proto.handle);
      expect(ours.profile.name).toBe(proto.name);
      expect(ours.profile.followers).toBe(proto.followers);
      expect(ours.scored.inputs).toEqual(proto.inputs);
      expect(ours.scored.score).toBe(proto.score);
      expect(ours.scored.value).toBeCloseTo(proto.value, 9);
      expect(ours.profile.verified).toBe(proto.verified);
    }
    const p = makeUser('carol', 12345);
    expect(makeDevProfile('carol', 12345).scored.score).toBe(p.score);
    expect(makeDevProfile('carol', 12345).profile.followers).toBe(12345);
  });

  it('derives a deterministic uint64 X id: 9e18 + hash(handle)', () => {
    const id = BigInt(devXId('alice'));
    expect(id > 9_000_000_000_000_000_000n && id < 2n ** 64n).toBe(true);
    expect(devXId('alice')).toBe(devXId('alice'));
  });

  it('POST /api/auth/dev signs in, sets the session cookie and returns MeDTO', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/dev', payload: { handle: 'Alice' } });
    expect(res.statusCode).toBe(200);
    const sid = res.cookies.find((c) => c.name === 'sway_sid')!;
    expect(sid.httpOnly).toBe(true);
    expect(sid.sameSite).toBe('Lax');
    expect(sid.secure).toBeFalsy();
    const me = res.json<MeDTO>();
    const expected = makeDevProfile('alice');
    expect(me.user).toMatchObject({
      handle: 'alice',
      name: 'Alice',
      memberNo: 1,
      followers: expected.profile.followers,
      score: expected.scored.score,
      verified: expected.profile.verified,
    });
    expect(me.wallet).toBeNull();
    expect(me.market).toBeNull();
    expect(me.points.score).toBe(Math.min(10000, expected.scored.score * 100));
    expect(me.points.total).toBe(me.points.score);
    expect(me.points.rank).toBe(1);
    expect(me).toMatchObject({ stakingLevel: 0, unreadNotifications: 0, unreadMessages: 0 });

    const again = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieOf(res) } });
    expect(again.json<MeDTO>().user.id).toBe(me.user.id);

    // Session lives in Redis only, with a 30-day TTL.
    const ttl = await ctx.redis.ttl(`sess:${sid.value.split('.')[0]}`);
    expect(ttl).toBeGreaterThan(29 * 24 * 3600);
  });

  it('assigns member numbers sequentially and keeps them on re-login', async () => {
    const a = await login(ctx, 'first');
    const b = await login(ctx, 'second');
    const a2 = await login(ctx, 'first');
    expect([a.user.memberNo, b.user.memberNo, a2.user.memberNo]).toEqual([1, 2, 1]);
  });

  it('logout deletes the session', async () => {
    const { cookie } = await login(ctx, 'leaver');
    const out = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('creates the Referral row on first sign-in only (ref in body or sway_ref cookie)', async () => {
    const inviter = await login(ctx, 'inviter');
    await login(ctx, 'invitee', undefined, 'inviter');
    const r = await prisma.referral.findMany({ include: { invitee: true } });
    expect(r).toHaveLength(1);
    expect(r[0]!.inviterId).toBe(inviter.user.id);
    expect(r[0]!.status).toBe('pending');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/dev',
      payload: { handle: 'cookied' },
      headers: { cookie: 'sway_ref=inviter' },
    });
    expect(await prisma.referral.count({ where: { inviterId: inviter.user.id } })).toBe(2);
    // Re-login with another ref does nothing; self-referral is ignored.
    await login(ctx, 'invitee', undefined, 'cookied');
    await login(ctx, 'selfref', undefined, 'selfref');
    expect(await prisma.referral.count()).toBe(2);
  });

  it('upgrades a fan-market placeholder in place when that account signs in', async () => {
    const { user, market } = await fanMarket('orbitlabs', '777000111');
    expect(user.memberNo).toBeNull();
    const { me } = await login(ctx, 'orbitlabs');
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.joinedAt).not.toBeNull();
    expect(after.memberNo).toBe(1);
    expect((me as unknown as MeDTO).user.id).toBe(user.id);
    expect((me as unknown as MeDTO).market).toEqual({ subject: market.subject, opened: true });
    expect(await prisma.user.count()).toBe(1);
  });

  it('rejects dev sign-in when DEV_AUTH is off', async () => {
    const off = await makeApp({ env: { DEV_AUTH: '0' } });
    const res = await off.app.inject({ method: 'POST', url: '/api/auth/dev', payload: { handle: 'x' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('dev_auth_disabled');
    await off.close();
  });
});

describe('X OAuth 2.0 PKCE', () => {
  it('runs start → callback with read-only scopes, scores the account and keeps tokens out of Postgres', async () => {
    const calls: string[] = [];
    const xFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      const ok = (b: unknown) =>
        new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/2/oauth2/token') {
        const body = new URLSearchParams(String(init!.body));
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code')).toBe('the-code');
        expect(codeChallenge(body.get('code_verifier')!)).toBe(challenge);
        return ok({ access_token: 'AT-secret', refresh_token: 'RT-secret', expires_in: 7200 });
      }
      if (url.pathname === '/2/users/me') {
        return ok({
          data: {
            id: '1449999',
            username: 'RealPerson',
            name: 'Real Person',
            description: 'bio here',
            profile_image_url: 'https://pbs.twimg.com/a_normal.png',
            created_at: '2015-01-01T00:00:00Z',
            verified: true,
            verified_type: 'blue',
            public_metrics: { followers_count: 25000, following_count: 10, tweet_count: 900 },
          },
        });
      }
      if (url.pathname === '/2/users/1449999/tweets') {
        const now = Date.now();
        return ok({
          data: [
            {
              id: 't1',
              text: 'hello',
              created_at: new Date(now - 3600e3).toISOString(),
              public_metrics: { like_count: 100, retweet_count: 10, reply_count: 5 },
            },
            {
              id: 't2',
              text: '@a reply',
              created_at: new Date(now - 7200e3).toISOString(),
              referenced_tweets: [{ type: 'replied_to', id: 'p' }],
              public_metrics: { like_count: 4, retweet_count: 0, reply_count: 0 },
            },
            {
              id: 't3',
              text: 'RT',
              created_at: new Date(now - 9000e3).toISOString(),
              referenced_tweets: [{ type: 'retweeted', id: 'q' }],
              public_metrics: { like_count: 0, retweet_count: 50, reply_count: 0 },
            },
          ],
        });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    let challenge = '';
    const x = await makeApp({ env: { X_CLIENT_ID: 'cid', X_CLIENT_SECRET: 'csec' }, xFetch });
    try {
      // A fan market already exists for this X id: the sign-in upgrades it in place.
      const { user: placeholder } = await fanMarket('realperson', '1449999');
      const start = await x.app.inject({ url: '/api/auth/x/start?redirect=/wallet&ref=nobody' });
      expect(start.statusCode).toBe(302);
      const auth = new URL(start.headers.location as string);
      expect(auth.origin).toBe('https://x.com');
      expect(auth.searchParams.get('scope')).toBe('tweet.read users.read follows.read offline.access');
      expect(auth.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/x/callback');
      challenge = auth.searchParams.get('code_challenge')!;
      const state = auth.searchParams.get('state')!;

      const cb = await x.app.inject({ url: `/api/auth/x/callback?code=the-code&state=${state}` });
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toBe('http://localhost:3000/wallet?onboard=1');
      expect(calls).toEqual(['/2/oauth2/token', '/2/users/me', '/2/users/1449999/tweets']);

      const u = await prisma.user.findUniqueOrThrow({ where: { xId: '1449999' } });
      expect(u.id).toBe(placeholder.id);
      expect(u).toMatchObject({
        handle: 'realperson',
        name: 'Real Person',
        followers: 25000,
        verified: true,
        bio: 'bio here',
        memberNo: 1,
      });
      expect(u.avatarUrl).toContain('_400x400');
      expect(u.score).toBeGreaterThan(1);
      expect(u.scoreInputs).toMatchObject({ followers: 25000, verified: true });
      // X tokens never reach Postgres.
      const dump = JSON.stringify(await prisma.user.findMany());
      expect(dump).not.toContain('AT-secret');
      expect(dump).not.toContain('RT-secret');
      const me = await x.app.inject({ url: '/api/me', headers: { cookie: cookieOf(cb) } });
      expect(me.json<MeDTO>().user.handle).toBe('realperson');

      // State is single-use.
      const replay = await x.app.inject({ url: `/api/auth/x/callback?code=the-code&state=${state}` });
      expect(replay.headers.location).toBe('http://localhost:3000/?auth_error=state_expired');
      // Open redirects are refused.
      const evil = await x.app.inject({ url: '/api/auth/x/start?redirect=//evil.example' });
      const st2 = new URL(evil.headers.location as string).searchParams.get('state')!;
      expect(JSON.parse((await x.redis.get(`oauth:${st2}`))!).redirect).toBe('/');
    } finally {
      await x.close();
    }
  });

  it('when posts can\'t be read at sign-in: the score follows the profile with the last engagement, and a rescore is queued', async () => {
    const xFetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const res = (b: unknown, status = 200, h: Record<string, string> = {}) =>
        new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...h } });
      if (url.pathname === '/2/oauth2/token') return res({ access_token: 'AT', expires_in: 7200 });
      if (url.pathname === '/2/users/me')
        return res({
          data: {
            id: url.searchParams.has('user.fields') ? '5150' : '0',
            username: 'budgeted',
            name: 'B',
            public_metrics: { followers_count: 10 },
          },
        });
      return res({}, 429, { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900) });
    }) as typeof fetch;
    const x = await makeApp({ env: { X_CLIENT_ID: 'cid' }, xFetch });
    try {
      const signIn = async () => {
        const start = await x.app.inject({ url: '/api/auth/x/start' });
        const state = new URL(start.headers.location as string).searchParams.get('state')!;
        return x.app.inject({ url: `/api/auth/x/callback?code=c&state=${state}` });
      };
      const first = await signIn();
      expect(first.headers.location).toBe('http://localhost:3000/?onboard=1');
      const created = await prisma.user.findUniqueOrThrow({ where: { xId: '5150' } });
      expect(created.scoredAt).not.toBeNull();
      expect(created.joinedAt).not.toBeNull();
      expect(x.jobs.refreshes).toEqual([created.id]);

      // A returning member: today's followers and badge, with the engagement and cadence of the last full read
      // (not a stale score, nor a profile-only one that drops their engagement).
      const last = { followers: 3, er: 0.05, ppw: 4, age: 2, verified: false };
      await prisma.user.update({ where: { id: created.id }, data: { score: 42, scoreInputs: last } });
      const again = await signIn();
      expect(again.headers.location).toBe('http://localhost:3000/?onboard=1');
      const u = await prisma.user.findUniqueOrThrow({ where: { xId: '5150' } });
      expect(u.scoreInputs).toMatchObject({ followers: 10, er: 0.05, ppw: 4, verified: false });
      expect(u.score).toBe(score(u.scoreInputs as unknown as ScoreInputs).score);
      expect(u.score).not.toBe(42);
      expect(u.reachValue).toBeGreaterThan(0);
      expect(x.jobs.refreshes).toEqual([u.id, u.id]);
    } finally {
      await x.close();
    }
  });

  it('marks the official X account as official when it signs in', async () => {
    const xFetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const res = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/2/oauth2/token') return res({ access_token: 'AT', expires_in: 7200 });
      if (url.pathname === '/2/users/me') return res({ data: { id: '7777', username: 'SwayDotFamily', name: 'Sway', public_metrics: { followers_count: 10 } } });
      return res({ data: [] });
    }) as typeof fetch;
    const x = await makeApp({ env: { X_CLIENT_ID: 'cid' }, xFetch });
    try {
      const start = await x.app.inject({ url: '/api/auth/x/start' });
      const state = new URL(start.headers.location as string).searchParams.get('state')!;
      const done = await x.app.inject({ url: `/api/auth/x/callback?code=c&state=${state}` });
      expect(done.headers.location).toBe('http://localhost:3000/?onboard=1');
      expect(await prisma.user.findUniqueOrThrow({ where: { xId: '7777' } })).toMatchObject({ handle: 'swaydotfamily', official: true });
    } finally {
      await x.close();
    }
  });

  it('answers 503 x_disabled when X is not configured', async () => {
    const res = await ctx.app.inject('/api/auth/x/start');
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('x_disabled');
  });
});
