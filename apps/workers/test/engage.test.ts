import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicKey, verify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { prisma, dec, decToBig } from '@sway/db';
import { loadConfig } from '../src/config';
import { makeClients, type Clients } from '../src/clients';
import { checkPriceAlerts } from '../src/jobs/alerts';
import { deliverPushes } from '../src/jobs/push';
import { generateVapidKeys, vapidJwt } from '../src/push/webpush';

let c: Clients;
let n = 0;
const got: Array<{ url: string; headers: IncomingMessage['headers'] }> = [];
const server = createServer((req, res) => {
  got.push({ url: req.url!, headers: req.headers });
  res.statusCode = req.url!.includes('/gone') ? 410 : 201;
  res.end();
});
let base = '';
const vapid = generateVapidKeys('mailto:test@swayfamily.com');

async function member(extra: Record<string, unknown> = {}) {
  n++;
  const handle = `eng_${n}_${Date.now() % 100000}`;
  return prisma.user.create({ data: { xId: String(8_000_000 + n + Math.floor(Math.random() * 1e6)), handle, name: handle, joinedAt: new Date(), ...extra } as never });
}

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${host}`;
  Object.assign(process.env, {
    CHAIN_ID: '31338', SWAY_KEYS_ADDRESS: '', OPERATOR_PRIVATE_KEY: '',
    VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: vapid.subject, PUSH_DEV_HOSTS: host,
  });
  c = makeClients(loadConfig(), new Redis('redis://localhost:6379/15'));
  await c.redis.del('push:cursor');
});

afterAll(async () => {
  server.close();
  await c.redis.quit();
  await prisma.$disconnect();
});

describe('watchlist price alerts', () => {
  it('alerts once per move past the threshold and respects the alerts pref', async () => {
    const creator = await member();
    const market = await prisma.keyMarket.create({ data: { subject: `0x${'e1'.repeat(19)}${n.toString(16).padStart(2, '0')}`, userId: creator.id, xId: creator.xId, opened: true, priceWei: dec(1_000_000n) } });
    const watcher = await member();
    const quiet = await member({ notifPrefs: { alerts: false } });
    for (const u of [watcher, quiet]) await prisma.watch.create({ data: { userId: u.id, subjectId: creator.id, alertPct: 10, baselineWei: dec(1_000_000n) } });

    await prisma.keyMarket.update({ where: { id: market.id }, data: { priceWei: dec(1_090_000n) } });
    await checkPriceAlerts(c);
    expect(await prisma.notification.count({ where: { userId: watcher.id } })).toBe(0);

    await prisma.keyMarket.update({ where: { id: market.id }, data: { priceWei: dec(1_150_000n) } });
    await checkPriceAlerts(c);
    await checkPriceAlerts(c);
    const notes = await prisma.notification.findMany({ where: { userId: watcher.id } });
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0]!.body)).toContain('up 15.0%');
    expect(notes[0]!.link).toBe(`/${creator.handle}`);
    expect(await prisma.notification.count({ where: { userId: quiet.id } })).toBe(0);
    const w = await prisma.watch.findUniqueOrThrow({ where: { userId_subjectId: { userId: quiet.id, subjectId: creator.id } } });
    expect(decToBig(w.baselineWei)).toBe(1_150_000n);

    await prisma.keyMarket.update({ where: { id: market.id }, data: { priceWei: dec(1_000_000n) } });
    await checkPriceAlerts(c);
    const last = await prisma.notification.findFirstOrThrow({ where: { userId: watcher.id }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(last.body)).toContain('down 13.0%');
  });
});

describe('web push', () => {
  it('signs a VAPID JWT the push service can verify', () => {
    const jwt = vapidJwt('https://fcm.googleapis.com', vapid, Date.parse('2026-10-19T00:00:00Z'));
    const [h, p, s] = jwt.split('.');
    const pub = Buffer.from(vapid.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: Date.parse('2026-10-19T12:00:00Z') / 1000, sub: 'mailto:test@swayfamily.com' });
  });

  it('pushes once per member per run, drops gone and foreign endpoints, honours prefs', async () => {
    const a = await member();
    const off = await member({ notifPrefs: { push: false } });
    const muted = await member({ notifPrefs: { trade: false } });
    await prisma.pushSubscription.createMany({
      data: [
        { userId: a.id, endpoint: `${base}/push/a1`, p256dh: 'x', auth: 'y' },
        { userId: a.id, endpoint: `${base}/gone/a2`, p256dh: 'x', auth: 'y' },
        { userId: a.id, endpoint: 'https://evil.example/push', p256dh: 'x', auth: 'y' },
        { userId: off.id, endpoint: `${base}/push/off`, p256dh: 'x', auth: 'y' },
        { userId: muted.id, endpoint: `${base}/push/muted`, p256dh: 'x', auth: 'y' },
      ],
    });
    for (const u of [a, a, off, muted]) await prisma.notification.create({ data: { userId: u.id, type: 'trade', body: [{ t: 'hi' }] } });
    got.length = 0;
    const r = await deliverPushes(c);
    expect(r).toEqual({ users: 1, sent: 1, removed: 2 });
    expect(got.map((g) => g.url).sort()).toEqual(['/gone/a2', '/push/a1']);
    const h = got.find((g) => g.url === '/push/a1')!.headers;
    expect(h.authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`));
    expect(h.ttl).toBe('86400');
    expect(h['content-length']).toBe('0');
    expect(await prisma.pushSubscription.count({ where: { userId: a.id } })).toBe(1);

    got.length = 0;
    expect((await deliverPushes(c)).sent).toBe(0);
    expect(got).toHaveLength(0);
  });
});
