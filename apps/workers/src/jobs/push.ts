/**
 * Delivers web pushes for new notifications: one payload-less push per member per run to each browser they
 * subscribed, when their prefs allow push and at least one new notification is of an unmuted type.
 * Gone subscriptions (404/410) are removed; one that keeps failing is dropped after MAX_FAILURES.
 */
import { pushEndpointAllowed, resolveNotificationPrefs } from '@sway/shared';
import type { Clients } from '../clients';
import { sendPush } from '../push/webpush';

const CURSOR = 'push:cursor';
const MAX_FAILURES = 5;

export async function deliverPushes(c: Clients, send = sendPush): Promise<{ users: number; sent: number; removed: number }> {
  const out = { users: 0, sent: 0, removed: 0 };
  const vapid = c.cfg.push;
  if (!vapid) return out;
  const raw = await c.redis.get(CURSOR);
  const since = raw ? new Date(raw) : new Date(Date.now() - 60_000);
  const rows = await c.prisma.notification.findMany({
    where: { createdAt: { gt: since }, readAt: null, user: { pushSubs: { some: {} }, deletedAt: null } },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: { userId: true, type: true, createdAt: true },
  });
  if (!rows.length) {
    if (!raw) await c.redis.set(CURSOR, since.toISOString());
    return out;
  }
  const byUser = new Map<string, Set<string>>();
  for (const r of rows) (byUser.get(r.userId) ?? byUser.set(r.userId, new Set()).get(r.userId)!).add(r.type);
  const users = await c.prisma.user.findMany({ where: { id: { in: [...byUser.keys()] } }, select: { id: true, notifPrefs: true, pushSubs: true } });
  for (const u of users) {
    const prefs = resolveNotificationPrefs(u.notifPrefs);
    if (!prefs.push || ![...byUser.get(u.id)!].some((t) => prefs[t as keyof typeof prefs] !== false)) continue;
    out.users++;
    for (const s of u.pushSubs) {
      if (!pushEndpointAllowed(s.endpoint, c.cfg.pushDevHosts)) {
        await c.prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
        out.removed++;
        continue;
      }
      const status = await send(s.endpoint, vapid).catch(() => 0);
      if (status >= 200 && status < 300) {
        out.sent++;
        await c.prisma.pushSubscription.update({ where: { id: s.id }, data: { failures: 0, lastOkAt: new Date() } });
      } else if (status === 404 || status === 410 || s.failures + 1 >= MAX_FAILURES) {
        await c.prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
        out.removed++;
      } else {
        await c.prisma.pushSubscription.update({ where: { id: s.id }, data: { failures: { increment: 1 } } });
      }
    }
  }
  await c.redis.set(CURSOR, rows[rows.length - 1]!.createdAt.toISOString());
  return out;
}
