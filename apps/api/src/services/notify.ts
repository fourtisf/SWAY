/**
 * The one way to create a notification: writes the row and publishes BusEvent { kind: 'notification' } so the
 * WebSocket hub pushes it to the recipient.
 */
import type { Redis } from 'ioredis';
import type { PrismaClient, NotificationType } from '@sway/db';
import { OFFICIAL_HANDLE, type RichText } from '@sway/shared';
import { publish } from './bus';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  fromUserId?: string | null;
  body: RichText;
  link?: string | null;
}

export async function notify(prisma: PrismaClient, redis: Redis, n: NotifyInput): Promise<string | null> {
  if (n.fromUserId && n.fromUserId === n.userId) return null;
  const row = await prisma.notification.create({
    data: { userId: n.userId, type: n.type, fromUserId: n.fromUserId ?? null, body: n.body as object[], link: n.link ?? null },
  });
  await publish(redis, { kind: 'notification', notificationId: row.id }).catch(() => undefined);
  return row.id;
}

let officialId: { id: string | null; at: number } | null = null;

/** Id of the official @swaydotfam account (sender of points notifications), cached for a minute. */
export async function officialUserId(prisma: PrismaClient): Promise<string | null> {
  if (officialId && Date.now() - officialId.at < 60_000) return officialId.id;
  const u = await prisma.user.findFirst({ where: { handle: OFFICIAL_HANDLE }, select: { id: true } });
  officialId = { id: u?.id ?? null, at: Date.now() };
  return officialId.id;
}

export const resetOfficialCache = () => {
  officialId = null;
};

/** Short quote for notification bodies. */
export const snippet = (text: string, max = 80): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
