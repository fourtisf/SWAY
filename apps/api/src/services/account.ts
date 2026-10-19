/**
 * [B] Account export and deletion.
 *
 * Deletion removes personal and social data and anonymizes the User row, but keeps what other people and the
 * chain depend on: onchain mirror rows (market, holdings, trades, claims, stakes), the append-only points
 * ledger, wallet links (the market's subject is the account wallet) and the wallet activity log. The market
 * stays live under "Deleted account". joinedAt is cleared so workers (scoring sweeps, points, Genesis) and
 * member lists skip the row; signing in with X again starts a fresh profile on the same X id.
 */
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { decToStr, Prisma, type PrismaClient, type User } from '@sway/db';
import type { AccountExport, Address, RichText } from '@sway/shared';
import type { AppDeps } from '../deps';
import { revokeUserSessions } from '../plugins/session';
import { memberAddresses } from './access';

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

export async function exportAccount(prisma: PrismaClient, user: User): Promise<AccountExport> {
  const userId = user.id;
  const addresses = await memberAddresses(prisma, userId);
  const [posts, dms, notifications, ledger, wallet, linked, trades] = await Promise.all([
    prisma.post.findMany({ where: { authorId: userId }, orderBy: { createdAt: 'asc' } }),
    prisma.dmMessage.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: 'asc' },
      include: { thread: { include: { a: { select: { id: true, handle: true } }, b: { select: { id: true, handle: true } } } } },
    }),
    prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.pointsLedger.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    prisma.wallet.findUnique({ where: { userId } }),
    prisma.linkedWallet.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    addresses.length
      ? prisma.trade.findMany({
          where: { trader: { in: addresses } },
          orderBy: [{ ts: 'asc' }, { logIndex: 'asc' }],
          include: { market: { include: { user: { select: { handle: true } } } } },
        })
      : [],
  ]);
  return {
    exportedAt: new Date().toISOString(),
    profile: {
      xId: user.xId,
      handle: user.handle,
      name: user.name,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      followers: user.followers,
      verified: user.verified,
      score: user.score,
      reachValue: user.reachValue,
      scoreInputs: user.scoreInputs,
      memberNo: user.memberNo,
      joinedAt: iso(user.joinedAt),
      tier: user.tier,
    },
    posts: posts.map((p) => ({
      id: p.id,
      text: p.text,
      visibility: p.visibility,
      media: p.media,
      parentId: p.parentId,
      createdAt: p.createdAt.toISOString(),
      deletedAt: iso(p.deletedAt),
      hiddenAt: iso(p.hiddenAt),
      boostedUntil: iso(p.boostedUntil),
    })),
    dmsSent: dms.map((m) => ({
      id: m.id,
      to: (m.thread.aId === userId ? m.thread.b : m.thread.a).handle,
      text: m.text,
      createdAt: m.createdAt.toISOString(),
    })),
    notifications: notifications.map((n) => ({
      id: n.id,
      type: n.type,
      body: (Array.isArray(n.body) ? n.body : []) as unknown as RichText,
      link: n.link,
      createdAt: n.createdAt.toISOString(),
      read: n.readAt !== null,
    })),
    pointsLedger: ledger.map((l) => ({ kind: l.kind, amount: l.amount, ref: l.ref, createdAt: l.createdAt.toISOString() })),
    wallets: [
      ...(wallet
        ? [{ address: wallet.address as Address, kind: wallet.kind, linked: false, createdAt: wallet.createdAt.toISOString() }]
        : []),
      ...linked.map((l) => ({ address: l.address as Address, kind: l.kind, linked: true, createdAt: l.createdAt.toISOString() })),
    ],
    trades: trades.map((t) => ({
      txHash: t.txHash,
      logIndex: t.logIndex,
      market: t.market.user.handle,
      subject: t.market.subject as Address,
      trader: t.trader as Address,
      isBuy: t.isBuy,
      units: t.units.toString(),
      baseWei: decToStr(t.baseWei),
      totalWei: decToStr(t.totalWei),
      supplyAfter: t.supplyAfter.toString(),
      ts: t.ts.toISOString(),
    })),
  };
}

export const deletedHandle = (userId: string) => `deleted_${userId.slice(-8)}`;

export async function deleteAccount(deps: Pick<AppDeps, 'prisma' | 'redis' | 'config'>, userId: string): Promise<void> {
  const { prisma, redis, config } = deps;
  const now = new Date();
  const uploads = await prisma.upload.findMany({ where: { userId }, select: { name: true } });

  await prisma.$transaction(
    async (tx) => {
      // Counters on other people's posts first, while the rows that explain them still exist.
      await tx.$executeRaw`
        UPDATE "Post" p SET "likeCount" = GREATEST(0, p."likeCount" - 1)
        FROM "Like" l WHERE l."postId" = p.id AND l."userId" = ${userId}`;
      await tx.$executeRaw`
        UPDATE "Post" p SET "repostCount" = GREATEST(0, p."repostCount" - 1)
        FROM "Repost" r WHERE r."postId" = p.id AND r."userId" = ${userId}`;
      await tx.$executeRaw`
        UPDATE "Post" p SET "replyCount" = GREATEST(0, p."replyCount" - c.n)
        FROM (SELECT "parentId", count(*)::int AS n FROM "Post"
              WHERE "authorId" = ${userId} AND "deletedAt" IS NULL AND "parentId" IS NOT NULL
              GROUP BY "parentId") c
        WHERE p.id = c."parentId"`;
      await tx.like.deleteMany({ where: { userId } });
      await tx.repost.deleteMany({ where: { userId } });

      // Posts: soft-deleted, text and images cleared (replies by others keep their place in threads).
      await tx.postTag.deleteMany({ where: { post: { authorId: userId } } });
      await tx.post.updateMany({ where: { authorId: userId, deletedAt: null }, data: { deletedAt: now } });
      await tx.post.updateMany({ where: { authorId: userId }, data: { text: '', media: [], pinned: false } });

      await tx.dmThread.deleteMany({ where: { OR: [{ aId: userId }, { bId: userId }] } });
      await tx.roomMessage.deleteMany({ where: { authorId: userId } });
      await tx.roomRead.deleteMany({ where: { userId } });
      await tx.follow.deleteMany({ where: { OR: [{ followerId: userId }, { followeeId: userId }] } });
      await tx.subscription.deleteMany({ where: { OR: [{ subscriberId: userId }, { creatorId: userId }] } });
      await tx.block.deleteMany({ where: { OR: [{ blockerId: userId }, { blockedId: userId }] } });
      await tx.report.deleteMany({ where: { reporterId: userId } });
      await tx.claimRequest.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { OR: [{ userId }, { fromUserId: userId }] } });
      await tx.upload.deleteMany({ where: { userId } });

      await tx.user.update({
        where: { id: userId },
        data: {
          handle: deletedHandle(userId),
          name: 'Deleted account',
          avatarUrl: null,
          bio: '',
          followers: 0,
          verified: false,
          xCreatedAt: null,
          score: 1,
          reachValue: 0,
          scoreInputs: Prisma.DbNull,
          scoredAt: null,
          joinedAt: null,
          memberNo: null,
          isAdmin: false,
          deletedAt: now,
        },
      });
    },
    { timeout: 30_000 },
  );

  await Promise.all(uploads.map((u) => unlink(path.join(config.uploadDir, u.name)).catch(() => undefined)));
  await revokeUserSessions(redis, userId);
}
