import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  checkTaskOnX,
  codeChallenge,
  createXClient,
  exchangeCode,
  generateCodeVerifier,
  isXUnavailable,
  refreshAccessToken,
  scoreXAccount,
  XApiError,
  XAuthError,
  XBudgetExceeded,
  type BudgetStore,
  type XContext,
} from '../src';

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function mockFetch(handler: Handler) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    return handler(url, init);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

class MemStore implements BudgetStore {
  m = new Map<string, number>();
  ttl = new Map<string, number>();
  async incr(k: string) {
    const v = (this.m.get(k) ?? 0) + 1;
    this.m.set(k, v);
    return v;
  }
  async expire(k: string, s: number) {
    this.ttl.set(k, s);
    return 1;
  }
}

const ctx = (f: typeof fetch, extra: Partial<XContext> = {}): XContext => ({
  token: 'tok',
  fetch: f,
  sleep: async () => {},
  ...extra,
});

const rawUser = {
  id: '12345',
  username: 'NovaReyes',
  name: 'Nova Reyes',
  description: 'Onchain sleuth',
  profile_image_url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg',
  created_at: '2019-03-01T00:00:00.000Z',
  verified: false,
  verified_type: 'blue',
  public_metrics: { followers_count: 412000, following_count: 900, tweet_count: 12000 },
};

describe('PKCE', () => {
  it('matches the RFC 7636 S256 vector', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates url-safe verifiers of valid length', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateCodeVerifier()).not.toBe(v);
  });

  it('builds the authorize URL with read-only scopes', () => {
    const u = new URL(
      buildAuthorizeUrl({
        clientId: 'cid',
        redirectUri: 'http://localhost:3000/api/auth/x/callback',
        state: 's1',
        codeChallenge: 'c1',
      }),
    );
    expect(u.origin + u.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(u.searchParams.get('scope')).toBe('tweet.read users.read follows.read offline.access');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe('s1');
  });

  it('exchanges a code with Basic auth for confidential clients', async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 7200, scope: 'tweet.read' }),
    );
    const t = await exchangeCode({
      clientId: 'cid',
      clientSecret: 'sec',
      code: 'c',
      redirectUri: 'http://cb',
      codeVerifier: 'v',
      fetch,
      now: () => 1000,
    });
    expect(t).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 1000 + 7200_000,
      scope: 'tweet.read',
    });
    const init = calls[0]!.init!;
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Basic ' + Buffer.from('cid:sec').toString('base64'),
    );
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('v');
    expect(body.get('client_id')).toBe('cid');
  });

  it('refreshes tokens and surfaces token errors', async () => {
    const ok = mockFetch(() => json({ access_token: 'at2', expires_in: 60 }));
    const t = await refreshAccessToken({
      clientId: 'cid',
      refreshToken: 'rt',
      fetch: ok.fetch,
      now: () => 0,
    });
    expect(t.accessToken).toBe('at2');
    expect(new URLSearchParams(String(ok.calls[0]!.init!.body)).get('grant_type')).toBe('refresh_token');
    const bad = mockFetch(() => json({ error: 'invalid_grant' }, 400));
    await expect(
      refreshAccessToken({ clientId: 'cid', refreshToken: 'rt', fetch: bad.fetch }),
    ).rejects.toBeInstanceOf(XApiError);
  });
});

describe('reads', () => {
  it('getMe maps the profile and requests the scoring fields', async () => {
    const { fetch, calls } = mockFetch(() => json({ data: rawUser }));
    const me = await createXClient(ctx(fetch)).getMe();
    expect(me).toMatchObject({
      id: '12345',
      username: 'NovaReyes',
      followers: 412000,
      verified: true,
      verifiedType: 'blue',
    });
    expect(me.profileImageUrl).toContain('_400x400.');
    expect(calls[0]!.url.searchParams.get('user.fields')).toBe(
      'created_at,public_metrics,verified,verified_type,profile_image_url,description',
    );
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('getRecentPosts flags replies and reposts and pages', async () => {
    const page1 = {
      data: [
        {
          id: '1',
          text: 'hello #SwayDaily',
          created_at: '2026-10-18T10:00:00Z',
          public_metrics: { like_count: 10, retweet_count: 2, reply_count: 1 },
          entities: { hashtags: [{ tag: 'SwayDaily' }] },
        },
        {
          id: '2',
          text: '@x yes',
          created_at: '2026-10-17T10:00:00Z',
          referenced_tweets: [{ type: 'replied_to', id: '9' }],
        },
      ],
      meta: { next_token: 'n2' },
    };
    const page2 = {
      data: [
        {
          id: '3',
          text: 'RT',
          created_at: '2026-10-16T10:00:00Z',
          referenced_tweets: [{ type: 'retweeted', id: '77' }],
        },
      ],
    };
    const { fetch, calls } = mockFetch((u) => json(u.searchParams.get('pagination_token') ? page2 : page1));
    const posts = await createXClient(ctx(fetch)).getRecentPosts('12345', 150);
    expect(posts.map((p) => [p.id, p.isReply, p.isRepost])).toEqual([
      ['1', false, false],
      ['2', true, false],
      ['3', false, true],
    ]);
    expect(posts[0]!.hashtags).toEqual(['swaydaily']);
    expect(calls[0]!.url.pathname).toBe('/2/users/12345/tweets');
    expect(calls[0]!.url.searchParams.get('tweet.fields')).toContain('referenced_tweets');
  });

  it('scores an account through @sway/scoring', () => {
    const me = {
      id: '1',
      username: 'a',
      name: 'A',
      description: '',
      profileImageUrl: null,
      createdAt: '2020-01-01T00:00:00Z',
      followers: 1000,
      following: 1,
      postCount: 1,
      verified: true,
      verifiedType: 'blue',
    };
    const { inputs, result } = scoreXAccount(me, [], new Date('2026-01-01T00:00:00Z'));
    expect(inputs.followers).toBe(1000);
    expect(inputs.er).toBe(0);
    expect(result.score).toBeGreaterThan(0);
  });

  it('isFollowing resolves the target and pages the following list', async () => {
    const { fetch, calls } = mockFetch((u) => {
      if (u.pathname.startsWith('/2/users/by/username/'))
        return json({ data: { ...rawUser, id: '999', username: 'swaydotfamily' } });
      if (!u.searchParams.get('pagination_token'))
        return json({ data: [{ id: '1' }, { id: '2' }], meta: { next_token: 'p2' } });
      return json({ data: [{ id: '999' }] });
    });
    expect(await createXClient(ctx(fetch)).isFollowing('12345', 'swaydotfamily')).toBe(true);
    expect(calls.filter((c) => c.url.pathname.endsWith('/following'))).toHaveLength(2);
  });

  it('hasReposted, findRecentPostWithTag and getPostMetrics', async () => {
    const { fetch, calls } = mockFetch((u) => {
      if (u.pathname.startsWith('/2/tweets/'))
        return json({
          data: {
            id: '5',
            text: 'x',
            author_id: '1',
            created_at: '2026-10-18T00:00:00Z',
            public_metrics: {
              like_count: 3,
              retweet_count: 1,
              reply_count: 2,
              quote_count: 1,
              bookmark_count: 4,
              impression_count: 100,
            },
          },
        });
      if (u.searchParams.get('exclude'))
        return json({ data: [{ id: '8', text: 'gm #swaydaily', created_at: '2026-10-18T09:00:00Z' }] });
      return json({ data: [{ id: '7', text: 'RT', referenced_tweets: [{ type: 'retweeted', id: '42' }] }] });
    });
    const x = createXClient(ctx(fetch));
    expect(await x.hasReposted('1', '42')).toBe(true);
    expect(await x.hasReposted('1', '43')).toBe(false);
    const hit = await x.findRecentPostWithTag('1', 'SwayDaily', new Date('2026-10-18T00:00:00Z'));
    expect(hit?.id).toBe('8');
    const daily = calls.find((c) => c.url.searchParams.get('exclude'))!;
    expect(daily.url.searchParams.get('exclude')).toBe('replies,retweets');
    expect(daily.url.searchParams.get('start_time')).toBe('2026-10-18T00:00:00.000Z');
    expect(await x.getPostMetrics('5')).toMatchObject({
      likes: 3,
      reposts: 1,
      replies: 2,
      quotes: 1,
      bookmarks: 4,
      impressions: 100,
    });
  });

  it('checkTaskOnX maps tasks to X reads', async () => {
    const { fetch } = mockFetch((u) => {
      if (u.searchParams.get('exclude'))
        return json({ data: [{ id: '8', text: 'My Sway score is 61/100 and my reach is valued at $9K' }] });
      return json({ data: [] });
    });
    const c = ctx(fetch);
    const day = new Date('2026-10-18T00:00:00Z');
    expect(await checkTaskOnX(c, { taskId: 'card', xUserId: '1', day })).toBe('verified');
    expect(await checkTaskOnX(c, { taskId: 'daily', xUserId: '1', day })).toBe('not_found');
    expect(await checkTaskOnX(c, { taskId: 'repost', xUserId: '1', day })).toBe('unsupported');
    expect(await checkTaskOnX(c, { taskId: 'tg', xUserId: '1', day })).toBe('unsupported');
  });
});

describe('budget and backoff', () => {
  it('counts calls per endpoint and window and refuses past the limit without calling X', async () => {
    const store = new MemStore();
    const { fetch, calls } = mockFetch(() => json({ data: rawUser }));
    const x = createXClient(
      ctx(fetch, {
        budget: store,
        budgetScope: 'u:1',
        limits: { 'users/me': 2 },
        now: () => 15 * 60 * 1000 * 10 + 5,
      }),
    );
    await x.getMe();
    await x.getMe();
    const err = await x.getMe().catch((e) => e);
    expect(err).toBeInstanceOf(XBudgetExceeded);
    expect((err as XBudgetExceeded).resetAt.getTime()).toBe(15 * 60 * 1000 * 11);
    expect(calls).toHaveLength(2);
    expect([...store.m.keys()]).toEqual([`xbudget:u:1:users/me:${15 * 60 * 1000 * 10}`]);
    expect([...store.ttl.values()][0]).toBe(960);
  });

  it('retries 429 with a near reset, then succeeds', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const { fetch } = mockFetch(() =>
      n++ === 0 ? json({}, 429, { 'x-rate-limit-reset': '1001' }) : json({ data: rawUser }),
    );
    const x = createXClient(ctx(fetch, { now: () => 1_000_000, sleep: async (ms) => void sleeps.push(ms) }));
    expect((await x.getMe()).id).toBe('12345');
    expect(sleeps).toEqual([1000]);
  });

  it('turns a 429 with a far reset into XBudgetExceeded', async () => {
    const { fetch, calls } = mockFetch(() => json({}, 429, { 'x-rate-limit-reset': String(1000 + 900) }));
    const err = await createXClient(ctx(fetch, { now: () => 1_000_000 }))
      .getMe()
      .catch((e) => e);
    expect(err).toBeInstanceOf(XBudgetExceeded);
    expect(calls).toHaveLength(1);
  });

  it('tells "X won\'t answer this" (plan, token, budget) from transient failures', () => {
    expect(isXUnavailable(new XBudgetExceeded('users/following', new Date()))).toBe(true);
    expect(isXUnavailable(new XAuthError('users/following'))).toBe(true);
    expect(isXUnavailable(new XApiError('forbidden', 403, 'users/following', { reason: 'client-not-enrolled' }))).toBe(true);
    expect(isXUnavailable(new XApiError('subset', 453, 'users/tweets'))).toBe(true);
    expect(isXUnavailable(new XApiError('down', 503, 'users/tweets'))).toBe(false);
    expect(isXUnavailable(new XApiError('unreachable', 0, 'users/tweets'))).toBe(false);
    expect(isXUnavailable(new Error('other'))).toBe(false);
  });

  it('backs off exponentially on 5xx and gives up after maxRetries', async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = mockFetch(() => json({ title: 'down' }, 503));
    const err = await createXClient(
      ctx(fetch, { maxRetries: 3, backoffMs: 100, sleep: async (ms) => void sleeps.push(ms) }),
    )
      .getMe()
      .catch((e) => e);
    expect(err).toBeInstanceOf(XApiError);
    expect((err as XApiError).status).toBe(503);
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it('recovers from a transient network error', async () => {
    let n = 0;
    const { fetch } = mockFetch(() => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return json({ data: rawUser });
    });
    expect((await createXClient(ctx(fetch)).getMe()).id).toBe('12345');
  });

  it('raises XAuthError on 401', async () => {
    const { fetch } = mockFetch(() => json({ title: 'Unauthorized' }, 401));
    await expect(createXClient(ctx(fetch)).getMe()).rejects.toBeInstanceOf(XAuthError);
  });
});
