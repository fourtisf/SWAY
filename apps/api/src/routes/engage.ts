import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_NOTIFICATION_PREFS,
  pushEndpointAllowed,
  type ClaimableDropDTO,
  type CreatorDropDTO,
  type DropPlanDTO,
  type NotificationPrefs,
  type PushConfigDTO,
  type ReferralsResponse,
  type StreakDTO,
  type WatchDTO,
  type WatchlistResponse,
} from '@sway/shared';
import { HandleParams, body, params, userByHandle } from './_util';
import { getViewer, requireViewer } from '../plugins/auth';
import { badRequest, conflict } from '../errors';
import { notify, officialUserId } from '../services/notify';
import {
  MAX_PUSH_SUBSCRIPTIONS,
  MAX_WATCHES,
  checkIn,
  claimableDrops,
  creatorDrops,
  planDrop,
  prefsOf,
  referralsOverview,
  streakDTO,
  watchDTO,
} from '../services/engage';

const WatchBody = z.object({
  alertPct: z.number().int().refine((n) => n === 0 || (n >= 5 && n <= 100), 'must be 0 or 5..100').default(10),
});
const PrefsBody = z
  .object(Object.fromEntries(Object.keys(DEFAULT_NOTIFICATION_PREFS).map((k) => [k, z.boolean().optional()])) as Record<keyof NotificationPrefs, z.ZodOptional<z.ZodBoolean>>)
  .strict();
const b64u = (min: number, max: number) => z.string().regex(/^[A-Za-z0-9_-]+=*$/).min(min).max(max);
const PushBody = z.object({ endpoint: z.string().url().max(1024), keys: z.object({ p256dh: b64u(40, 200), auth: b64u(8, 64) }) });
const EndpointBody = z.object({ endpoint: z.string().max(1024) });
const DropPlanBody = z.object({ amountWei: z.string().regex(/^\d{1,40}$/, 'must be a decimal wei string') });

export async function engageRoutes(app: FastifyInstance) {
  const { prisma, redis, config } = app.deps;

  /* ---------------------------------------------------------------- watchlist */

  app.get('/watchlist', async (req): Promise<WatchlistResponse> => {
    const v = await requireViewer(req);
    const rows = await prisma.watch.findMany({ where: { userId: v.user.id }, orderBy: { createdAt: 'desc' }, include: { subject: { include: { market: true } } } });
    return { items: rows.map((w) => watchDTO(w, w.subject)) };
  });

  app.put('/users/:handle/watch', async (req): Promise<WatchDTO> => {
    const v = await requireViewer(req);
    const { handle } = params(HandleParams, req);
    const { alertPct } = body(WatchBody, req);
    const subject = await userByHandle(req, handle, { market: true });
    if (subject.id === v.user.id) throw badRequest('self', 'You can’t watch your own key.');
    if (!subject.market || !(subject.market.opened || subject.market.claimed))
      throw conflict('no_market', `@${handle} has no key market yet.`);
    const key = { userId_subjectId: { userId: v.user.id, subjectId: subject.id } };
    if (!(await prisma.watch.findUnique({ where: key })) && (await prisma.watch.count({ where: { userId: v.user.id } })) >= MAX_WATCHES) {
      throw conflict('watchlist_full', `Your watchlist holds ${MAX_WATCHES} keys. Remove one first.`);
    }
    // Setting or changing the alert starts it from the current price.
    const w = await prisma.watch.upsert({
      where: key,
      update: { alertPct, baselineWei: subject.market.priceWei },
      create: { userId: v.user.id, subjectId: subject.id, alertPct, baselineWei: subject.market.priceWei },
    });
    return watchDTO(w, subject);
  });

  app.delete('/users/:handle/watch', async (req) => {
    const v = await requireViewer(req);
    const { handle } = params(HandleParams, req);
    const subject = await userByHandle(req, handle, {});
    await prisma.watch.deleteMany({ where: { userId: v.user.id, subjectId: subject.id } });
    return { watching: false as const };
  });

  /* ---------------------------------------------------------------- streak */

  app.get('/streak', async (req): Promise<StreakDTO> => streakDTO((await requireViewer(req)).user));

  app.post('/streak/check-in', async (req): Promise<StreakDTO & { awarded: number }> => {
    const v = await requireViewer(req);
    const { streak, awarded } = await checkIn(prisma, v.user.id);
    return { ...streak, awarded };
  });

  /* ---------------------------------------------------------------- referrals */

  app.get('/referrals', async (req): Promise<ReferralsResponse> => referralsOverview(app.deps, await requireViewer(req)));

  /* ---------------------------------------------------------------- notification prefs */

  app.get('/me/notification-prefs', async (req): Promise<NotificationPrefs> => prefsOf((await requireViewer(req)).user));

  app.put('/me/notification-prefs', async (req): Promise<NotificationPrefs> => {
    const v = await requireViewer(req);
    const next = { ...prefsOf(v.user), ...body(PrefsBody, req) };
    await prisma.user.update({ where: { id: v.user.id }, data: { notifPrefs: next } });
    return next;
  });

  /* ---------------------------------------------------------------- web push */

  app.get('/push', async (req): Promise<PushConfigDTO> => {
    const v = await getViewer(req);
    return {
      enabled: !!config.push.publicKey,
      publicKey: config.push.publicKey,
      subscriptions: v ? await prisma.pushSubscription.count({ where: { userId: v.user.id } }) : 0,
    };
  });

  app.post('/push/subscribe', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const v = await requireViewer(req);
    const b = body(PushBody, req);
    if (!config.push.publicKey) throw conflict('push_unavailable', 'Push notifications are not set up on this server.');
    if (!pushEndpointAllowed(b.endpoint, config.push.devHosts)) throw badRequest('bad_endpoint', 'That push service isn’t supported.');
    // A browser keeps its endpoint across sign-ins, so the newest member on it owns the subscription.
    await prisma.pushSubscription.upsert({
      where: { endpoint: b.endpoint },
      update: { userId: v.user.id, p256dh: b.keys.p256dh, auth: b.keys.auth, failures: 0 },
      create: { userId: v.user.id, endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth },
    });
    const extra = await prisma.pushSubscription.findMany({ where: { userId: v.user.id }, orderBy: { createdAt: 'desc' }, skip: MAX_PUSH_SUBSCRIPTIONS, select: { id: true } });
    if (extra.length) await prisma.pushSubscription.deleteMany({ where: { id: { in: extra.map((x) => x.id) } } });
    return { ok: true as const };
  });

  app.post('/push/unsubscribe', async (req) => {
    const v = await requireViewer(req);
    const { endpoint } = body(EndpointBody, req);
    await prisma.pushSubscription.deleteMany({ where: { userId: v.user.id, endpoint } });
    return { ok: true as const };
  });

  app.post('/push/test', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    const v = await requireViewer(req);
    await notify(prisma, redis, {
      userId: v.user.id,
      type: 'points',
      fromUserId: await officialUserId(prisma),
      link: '/settings',
      body: [{ t: 'Push notifications are on.', b: true }, { t: ' You’ll hear about trades, mentions, battles and price alerts here.' }],
    });
    return { ok: true as const };
  });

  /* ---------------------------------------------------------------- creator drops */

  app.post('/drops/plan', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<DropPlanDTO> => {
    const v = await requireViewer(req);
    const { amountWei } = body(DropPlanBody, req);
    return planDrop(app.deps, v, BigInt(amountWei));
  });

  app.get('/users/:handle/drops', async (req): Promise<CreatorDropDTO[]> => {
    const { handle } = params(HandleParams, req);
    const creator = await userByHandle(req, handle, { market: true });
    const v = await getViewer(req);
    return creatorDrops(prisma, creator, v?.user.id ?? null);
  });

  app.get('/drops/claimable', async (req): Promise<ClaimableDropDTO[]> => claimableDrops(app.deps, (await requireViewer(req)).user.id));
}
