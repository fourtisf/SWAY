import type { NotificationType, RichText } from '@sway/shared';
import type { Prisma } from '@sway/db';
import type { Clients } from './clients';

type Tx = Prisma.TransactionClient;

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  body: RichText;
  fromUserId?: string | null;
  link?: string | null;
}

/** Writes a notification inside the caller's transaction and returns its id for publishing after commit. */
export async function createNotification(tx: Tx, n: NotifyInput): Promise<string> {
  const row = await tx.notification.create({
    data: { userId: n.userId, type: n.type, body: n.body as Prisma.InputJsonValue, fromUserId: n.fromUserId ?? null, link: n.link ?? null },
    select: { id: true },
  });
  return row.id;
}

export async function publishNotifications(c: Clients, ids: string[]): Promise<void> {
  for (const notificationId of ids) await c.publish({ kind: 'notification', notificationId });
}

/** Writes a notification outside a transaction and publishes it. */
export async function notify(c: Clients, n: NotifyInput): Promise<void> {
  const id = await createNotification(c.prisma, n);
  await c.publish({ kind: 'notification', notificationId: id });
}
