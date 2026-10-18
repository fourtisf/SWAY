import type { PrismaClient } from '@sway/db';
import type { Address, MeDTO } from '@sway/shared';
import type { Viewer } from '../deps';
import { userRef } from './dto';
import { unreadMessages } from './messages';
import { pointsDTO } from './points';

export async function buildMe(prisma: PrismaClient, v: Viewer): Promise<MeDTO> {
  const { user, wallet, market } = v;
  const [points, unreadNotifications, unreadMsgs, stake] = await Promise.all([
    pointsDTO(prisma, user),
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    unreadMessages(prisma, user.id, wallet?.address ?? null),
    prisma.stake.findUnique({ where: { userId: user.id }, select: { level: true } }),
  ]);
  return {
    user: {
      ...userRef(user, market),
      id: user.id,
      memberNo: user.memberNo ?? 0,
      score: user.score,
      reachValue: user.reachValue,
      followers: user.followers,
    },
    wallet: wallet ? { address: wallet.address as Address, kind: wallet.kind } : null,
    market: market ? { subject: market.subject as Address, opened: market.opened } : null,
    points,
    stakingLevel: Math.max(user.stakingLevel, stake?.level ?? 0),
    unreadNotifications,
    unreadMessages: unreadMsgs,
  };
}

/** Staking level used for perks (2,000-character posts at level ≥ 1). */
export async function stakingLevelOf(prisma: PrismaClient, userId: string, cached: number): Promise<number> {
  const s = await prisma.stake.findUnique({ where: { userId }, select: { level: true } });
  return Math.max(cached, s?.level ?? 0);
}
