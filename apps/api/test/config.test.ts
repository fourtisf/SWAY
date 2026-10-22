import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OFFICIAL_HANDLE, ROUTES, type ConfigDTO, type LaunchTokenResponse } from '@sway/shared';
import { ConfigError, loadConfig } from '../src/config';
import { jsonReplacer } from '../src/app';
import { resetSwayTokenCache } from '../src/routes/system';
import { resetOfficialCache } from '../src/services/notify';
import { PRICE_KEY, resetPriceMemo } from '../src/services/price';
import { makeApp, prisma, resetState, TEST_ENV, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
  await resetState(ctx.redis);
});
afterAll(() => ctx.close());

describe('config', () => {
  it('GET /api/config returns the ConfigDTO', async () => {
    const res = await ctx.app.inject('/api/config');
    expect(res.statusCode).toBe(200);
    const c = res.json<ConfigDTO>();
    expect(c).toMatchObject({
      chainId: 31337,
      chainName: 'Sway Local',
      ethUsd: 3420,
      snapshotAt: '2026-10-27T15:00:00.000Z',
      auth: { x: false, dev: true },
      wallets: { embedded: 'burner', walletConnectProjectId: null },
      mainnet: false,
    });
    expect(c.contracts.swayKeys).toBe('0x5fbdb2315678afecb367f032d93f642f64180aa3');
    expect(c.contracts.swayStaking).toBeNull();
    expect(Object.keys(c).sort()).toEqual([
      'auth',
      'chainId',
      'chainName',
      'contracts',
      'ethUsd',
      'explorerUrl',
      'faucetUrl',
      'mainnet',
      'rpcUrl',
      'snapshotAt',
      'swayToken',
      'wallets',
    ]);
    expect(c.swayToken).toBeNull();
  });

  it('shows the token @swaydotfamily launched as swayToken once SWAY_TOKEN_PUBLIC=1', async () => {
    const u = await prisma.user.create({ data: { xId: '9100', handle: OFFICIAL_HANDLE, name: 'Sway', official: true } });
    const token = '0x00000000000000000000000000000000005a1a7e';
    await prisma.launchToken.create({ data: { userId: u.id, symbol: 'SWAY', name: 'Sway', tokenAddress: token } });
    resetOfficialCache();
    resetSwayTokenCache();
    // Not announced yet: no CA on the site and no public token page.
    expect((await ctx.app.inject('/api/config')).json<ConfigDTO>().swayToken).toBeNull();
    const page = (await ctx.app.inject(`/api/launchpad/tokens/${OFFICIAL_HANDLE}`)).json<LaunchTokenResponse>();
    expect(page).toMatchObject({ launched: false, token: null });

    ctx.app.deps.config.swayTokenPublic = true;
    try {
      expect((await ctx.app.inject('/api/config')).json<ConfigDTO>().swayToken).toBe(token);
      expect((await ctx.app.inject(`/api/launchpad/tokens/${OFFICIAL_HANDLE}`)).json<LaunchTokenResponse>().launched).toBe(true);
    } finally {
      ctx.app.deps.config.swayTokenPublic = false;
      await prisma.user.delete({ where: { id: u.id } });
      resetOfficialCache();
      resetSwayTokenCache();
    }
  });

  it('GET /api/price falls back, then reads the workers’ Redis price', async () => {
    resetPriceMemo();
    expect((await ctx.app.inject('/api/price')).json()).toEqual({ ethUsd: 3420, source: 'fallback' });
    await ctx.redis.set(PRICE_KEY, JSON.stringify({ ethUsd: 2999.5, at: Date.now() }));
    resetPriceMemo();
    expect((await ctx.app.inject('/api/price')).json()).toEqual({ ethUsd: 2999.5, source: 'live' });
    await ctx.redis.set(PRICE_KEY, '3100');
    resetPriceMemo();
    expect((await ctx.app.inject('/api/price')).json()).toEqual({ ethUsd: 3100, source: 'live' });
    await ctx.redis.del(PRICE_KEY);
    resetPriceMemo();
  });

  it('refuses mainnet unless SWAY_ENABLE_MAINNET=1', () => {
    expect(() => loadConfig({ ...TEST_ENV, CHAIN_ID: '4663' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...TEST_ENV, CHAIN_ID: '4663' })).toThrow(/unaudited/);
    const c = loadConfig({ ...TEST_ENV, CHAIN_ID: '4663', SWAY_ENABLE_MAINNET: '1' });
    expect(c.chain.isMainnet).toBe(true);
    expect(c.chain.explorerUrl).toBe('https://robinhoodchain.blockscout.com');
  });

  it('turns the in-browser Sway wallet off on mainnet', () => {
    const main = loadConfig({ ...TEST_ENV, CHAIN_ID: '4663', SWAY_ENABLE_MAINNET: '1' });
    expect(main.wallets.embedded).toBe('off');
    expect(loadConfig({ ...TEST_ENV, CHAIN_ID: '4663', SWAY_ENABLE_MAINNET: '1', EMBEDDED_WALLET_PROVIDER: 'privy' }).wallets.embedded).toBe('privy');
    expect(loadConfig({ ...TEST_ENV, CHAIN_ID: '46630' }).wallets.embedded).toBe('burner');
  });

  it('never enables dev auth in production and requires a strong secret there', () => {
    expect(() =>
      loadConfig({
        ...TEST_ENV,
        NODE_ENV: 'production',
        SESSION_SECRET: 'change-me-to-a-long-random-string',
      }),
    ).toThrow(/SESSION_SECRET/);
    const c = loadConfig({ ...TEST_ENV, NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40) });
    expect(c.devAuth).toBe(false);
  });

  it('validates addresses', () => {
    expect(() => loadConfig({ ...TEST_ENV, SWAY_KEYS_ADDRESS: '0x123' })).toThrow(/SWAY_KEYS_ADDRESS/);
    expect(loadConfig({ ...TEST_ENV, SWAY_KEYS_ADDRESS: '' }).contracts.swayKeys).toBeNull();
  });
});

describe('errors and plumbing', () => {
  it('uses the ApiError shape for 404 and 401', async () => {
    const nf = await ctx.app.inject('/api/nope');
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toEqual({ error: 'not_found', message: 'No route for GET /api/nope' });
    const me = await ctx.app.inject('/api/me');
    expect(me.statusCode).toBe(401);
    expect(me.json()).toEqual({ error: 'auth_required', message: 'Sign in with X first' });
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/api/posts',
      payload: { text: 'hi', visibility: 'public' },
    });
    expect(post.statusCode).toBe(401);
  });

  it('validates input with zod (400 invalid_input)', async () => {
    const res = await ctx.app.inject('/api/feed?tab=everything');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_input');
  });

  it('restricts CORS to WEB_URL with credentials', async () => {
    const ok = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/feed',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/feed',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rate-limits auth routes more strictly (429 rate_limited)', async () => {
    const tight = await makeApp({ env: { RATE_LIMIT_AUTH_MAX: '2' } });
    try {
      const hit = () =>
        tight.app.inject({
          method: 'POST',
          url: '/api/auth/dev',
          payload: { handle: 'spammer' },
          remoteAddress: '10.9.8.7',
        });
      expect((await hit()).statusCode).toBe(200);
      expect((await hit()).statusCode).toBe(200);
      const third = await hit();
      expect(third.statusCode).toBe(429);
      expect(third.json().error).toBe('rate_limited');
      expect((await tight.app.inject({ url: '/api/config', remoteAddress: '10.9.8.7' })).statusCode).toBe(
        200,
      );
    } finally {
      await tight.redis.flushdb();
      await tight.close();
    }
  });

  it('serializes BigInt safely', () => {
    expect(JSON.stringify({ a: 10n ** 30n }, jsonReplacer)).toBe('{"a":"1000000000000000000000000000000"}');
  });

  it('serves every GET route in ROUTES to guests without a 5xx', async () => {
    const gets = Object.values(ROUTES).filter((r) => r.startsWith('GET '));
    for (const r of gets) {
      const path = r.slice(4).replace(':handle', 'nobody').replace(':id', 'nothing');
      if (path.includes('/auth/x/')) continue;
      const res = await ctx.app.inject(path);
      expect(res.statusCode, `${r} → ${res.statusCode} ${res.body}`).toBeLessThan(500);
    }
  });

  it('has a handler for every route in ROUTES', () => {
    const missing = Object.entries(ROUTES).filter(([, r]) => {
      const [method, url] = r.split(' ') as ['GET' | 'POST', string];
      return !ctx.app.hasRoute({ method, url });
    });
    expect(missing).toEqual([]);
  });
});
