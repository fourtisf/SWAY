/**
 * Verified invites (brief §6): the invitee is ≥30 days old on X, has ≥50 followers, an X checkmark and
 * no bot flag. Inviter +500, invitee +100, at most 25 credited per inviter per UTC day. A credited invite
 * also sets the onchain referrer so the inviter earns half of the 1% referral fee on the invitee's trades.
 */
import { INVITE_POINTS, INVITEE_POINTS, INVITES_CREDITED_PER_DAY, inviteQualifies } from '@sway/scoring';
import { swayKeysAbi } from '@sway/shared/abi';
import { utcDay } from '@sway/db';
import type { Clients } from '../clients';
import { createNotification, publishNotifications } from '../notify';

const DAY_MS = 86400e3;

export async function creditReferrals(c: Clients, now = new Date()): Promise<number> {
  const { prisma } = c;
  const pending = await prisma.referral.findMany({
    where: { status: 'pending' },
    include: { invitee: { include: { wallet: true } }, inviter: { include: { wallet: true } } },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  const today = utcDay(now);
  let credited = 0;
  for (const r of pending) {
    const inv = r.invitee;
    if (!inv.joinedAt) continue;
    if (inv.botFlag) {
      await prisma.referral.update({ where: { id: r.id }, data: { status: 'rejected', reason: 'bot_flag' } });
      continue;
    }
    const ageDays = inv.xCreatedAt ? (now.getTime() - inv.xCreatedAt.getTime()) / DAY_MS : 0;
    if (!inviteQualifies({ accountAgeDays: ageDays, followers: inv.followers, verified: inv.verified, botFlag: inv.botFlag })) continue;
    const creditedToday = await prisma.referral.count({ where: { inviterId: r.inviterId, status: 'credited', creditedAt: { gte: today } } });
    if (creditedToday >= INVITES_CREDITED_PER_DAY) continue;

    const ids = await prisma.$transaction(async (tx) => {
      await tx.referral.update({ where: { id: r.id }, data: { status: 'credited', creditedAt: now } });
      await tx.pointsLedger.createMany({
        data: [
          { userId: r.inviterId, kind: 'invite', amount: INVITE_POINTS, ref: `invite:${inv.id}` },
          { userId: inv.id, kind: 'invitee', amount: INVITEE_POINTS, ref: `invitee:${inv.id}` },
        ],
        skipDuplicates: true,
      });
      return [
        await createNotification(tx, {
          userId: r.inviterId, type: 'points', fromUserId: inv.id, link: '/tasks',
          body: [{ t: 'Your invite ' }, { t: `@${inv.handle}`, b: true }, { t: ` joined Sway. +${INVITE_POINTS} points.` }],
        }),
      ];
    });
    await publishNotifications(c, ids);
    credited++;

    const keys = c.cfg.contracts.swayKeys;
    if (keys && c.operator && inv.wallet && r.inviter.wallet) {
      try {
        const hash = await c.operator.writeContract({
          address: keys, abi: swayKeysAbi, functionName: 'setReferrer',
          args: [inv.wallet.address as `0x${string}`, r.inviter.wallet.address as `0x${string}`],
        });
        await prisma.referral.update({ where: { id: r.id }, data: { onchainTx: hash } });
      } catch (e) {
        console.warn(`[referrals] setReferrer failed for ${inv.handle}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
  }
  return credited;
}
