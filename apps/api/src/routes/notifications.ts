import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NotificationType } from '@sway/db';
import type { NotificationDTO } from '@sway/shared';
import { IdParams, params, query } from './_util';
import { getViewer, requireViewer } from '../plugins/auth';
import { notFound } from '../errors';
import { notificationDTO } from '../services/dto';
import { prefsOf, visibleTypes } from '../services/engage';

const TAB_TYPES: Record<'all' | 'trades' | 'mentions', NotificationType[] | null> = {
  all: null,
  trades: ['trade'],
  mentions: ['mention', 'battle'],
};

export async function notificationRoutes(app: FastifyInstance) {
  const { prisma } = app.deps;
  // [D] Muted types (User.notifPrefs) stay out of the list and the badge.
  const unread = async (userId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { notifPrefs: true } });
    return prisma.notification.count({ where: { userId, readAt: null, type: { in: visibleTypes(prefsOf(u)) } } });
  };

  app.get('/notifications', async (req): Promise<NotificationDTO[]> => {
    const { tab } = query(z.object({ tab: z.enum(['all', 'trades', 'mentions']).default('all') }), req);
    const v = await getViewer(req);
    if (!v) return [];
    const shown = visibleTypes(prefsOf(v.user));
    const types = (TAB_TYPES[tab] ?? shown).filter((t) => shown.includes(t));
    const rows = await prisma.notification.findMany({
      where: { userId: v.user.id, type: { in: types } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { from: { include: { market: true } } },
    });
    return rows.map(notificationDTO);
  });

  app.post('/notifications/read-all', async (req) => {
    const v = await requireViewer(req);
    await prisma.notification.updateMany({
      where: { userId: v.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true as const, unread: 0 };
  });

  app.post('/notifications/:id/read', async (req) => {
    const v = await requireViewer(req);
    const { id } = params(IdParams, req);
    const r = await prisma.notification.updateMany({
      where: { id, userId: v.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    if (
      r.count === 0 &&
      !(await prisma.notification.findFirst({ where: { id, userId: v.user.id }, select: { id: true } }))
    ) {
      throw notFound('Notification not found');
    }
    return { ok: true as const, unread: await unread(v.user.id) };
  });
}
