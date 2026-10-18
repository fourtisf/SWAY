/** Key rooms and direct messages: thread lists and unread state. */
import type { DmThread, KeyMarket, PrismaClient, User } from '@sway/db';
import { Prisma } from '@sway/db';
import type { ThreadDTO } from '@sway/shared';
import { userRef } from './dto';

export const ROOM_UNITS = 100n;

/** Markets whose room the viewer is in: their own, plus every claimed market where they hold ≥ 1 key (mirror). */
export async function roomMarkets(prisma: PrismaClient, userId: string, wallet: string | null): Promise<Array<KeyMarket & { user: User }>> {
  const held = wallet
    ? await prisma.holding.findMany({ where: { address: wallet.toLowerCase(), units: { gte: ROOM_UNITS } }, select: { marketId: true } })
    : [];
  return prisma.keyMarket.findMany({
    where: { claimed: true, OR: [{ userId }, { id: { in: held.map((h) => h.marketId) } }] },
    include: { user: true },
  });
}

export async function roomThreads(prisma: PrismaClient, userId: string, wallet: string | null): Promise<ThreadDTO[]> {
  const markets = await roomMarkets(prisma, userId, wallet);
  if (!markets.length) return [];
  const ids = markets.map((m) => m.id);
  const [lasts, reads] = await Promise.all([
    prisma.$queryRaw<Array<{ marketId: string; text: string; createdAt: Date; authorId: string }>>(Prisma.sql`
      SELECT DISTINCT ON ("marketId") "marketId", "text", "createdAt", "authorId"
      FROM "RoomMessage" WHERE "marketId" = ANY(${ids}::text[])
      ORDER BY "marketId", "createdAt" DESC`),
    prisma.roomRead.findMany({ where: { userId, marketId: { in: ids } } }),
  ]);
  const lastBy = new Map(lasts.map((l) => [l.marketId, l]));
  const readBy = new Map(reads.map((r) => [r.marketId, r.readAt]));
  return markets
    .map((m) => {
      const last = lastBy.get(m.id);
      const readAt = readBy.get(m.id);
      return {
        thread: {
          id: m.user.handle,
          kind: 'room' as const,
          with: userRef(m.user, m),
          last: last?.text ?? null,
          unread: !!last && last.authorId !== userId && (!readAt || last.createdAt > readAt),
          holders: m.holders,
        },
        at: last?.createdAt.getTime() ?? 0,
        own: m.userId === userId,
      };
    })
    .sort((a, b) => Number(b.own) - Number(a.own) || b.at - a.at)
    .map((x) => x.thread);
}

type ThreadRow = DmThread & { a: User & { market: KeyMarket | null }; b: User & { market: KeyMarket | null } };

export function dmThreadDTO(t: ThreadRow, viewerId: string, last: string | null): ThreadDTO {
  const other = t.aId === viewerId ? t.b : t.a;
  const readAt = t.aId === viewerId ? t.aReadAt : t.bReadAt;
  return {
    id: t.id,
    kind: 'dm',
    with: userRef(other, other.market),
    last,
    unread: last !== null && (!readAt || t.lastMessageAt > readAt),
  };
}

export const DM_INCLUDE = { a: { include: { market: true } }, b: { include: { market: true } } } satisfies Prisma.DmThreadInclude;

export async function dmThreads(prisma: PrismaClient, userId: string): Promise<ThreadDTO[]> {
  const threads = await prisma.dmThread.findMany({
    where: { OR: [{ aId: userId }, { bId: userId }] },
    include: { ...DM_INCLUDE, messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    orderBy: { lastMessageAt: 'desc' },
    take: 100,
  });
  return threads.map((t) => dmThreadDTO(t, userId, t.messages[0]?.text ?? null));
}

/** Unread DM threads plus unread rooms (the Messages badge). */
export async function unreadMessages(prisma: PrismaClient, userId: string, wallet: string | null): Promise<number> {
  const [dm] = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT count(*)::int AS n FROM "DmThread" t
    WHERE EXISTS (SELECT 1 FROM "DmMessage" m WHERE m."threadId" = t.id AND m."authorId" <> ${userId})
      AND ((t."aId" = ${userId} AND (t."aReadAt" IS NULL OR t."lastMessageAt" > t."aReadAt"))
        OR (t."bId" = ${userId} AND (t."bReadAt" IS NULL OR t."lastMessageAt" > t."bReadAt")))`);
  const [rooms] = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT count(*)::int AS n FROM "KeyMarket" k
    WHERE k.claimed
      AND (k."userId" = ${userId} OR EXISTS (
        SELECT 1 FROM "Holding" h WHERE h."marketId" = k.id AND h.address = ${wallet?.toLowerCase() ?? ''} AND h.units >= ${ROOM_UNITS}))
      AND EXISTS (
        SELECT 1 FROM "RoomMessage" rm WHERE rm."marketId" = k.id AND rm."authorId" <> ${userId}
          AND rm."createdAt" > COALESCE((SELECT rr."readAt" FROM "RoomRead" rr WHERE rr."userId" = ${userId} AND rr."marketId" = k.id), 'epoch'::timestamp))`);
  return (dm?.n ?? 0) + (rooms?.n ?? 0);
}

/** DmThread keys are ordered (aId < bId). */
export const orderPair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
