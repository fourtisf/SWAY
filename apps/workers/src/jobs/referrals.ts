/**
 * Verified invites (brief §6): the invitee is ≥30 days old on X, has ≥50 followers, an X checkmark and
 * no bot flag. Inviter +500, invitee +100, at most 25 credited per inviter per UTC day. A credited invite
 * also sets the onchain referrer on each of the invitee's wallets so the inviter earns half of the 1% referral
 * fee on their trades: by default the invitee's next buy carries it as a signed permit (apps/api permits), and
 * with SPONSOR_ONBOARDING=1 the operator sends it here.
 */
import { INVITE_POINTS, INVITEE_POINTS, INVITES_CREDITED_PER_DAY, inviteQualifies } from '@sway/scoring';
import { swayKeysAbi } from '@sway/shared/abi';
import { utcDay } from '@sway/db';
import type { Clients } from '../clients';
import { createNotification, publishNotifications } from '../notify';
import { withSenderLock } from '../txlock';

const DAY_MS = 86400e3;

export async function creditReferrals(c: Clients, now = new Date()): Promise<number> {
  const { prisma } = c;
  const pending = await prisma.referral.findMany({
    where: { status: 'pending' },
    include: { invitee: true },
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

  }
  await syncReferrers(c);
  return credited;
}

const KNOWN = 'referrer:set';

/**
 * Sets the onchain referrer on every wallet of each credited invitee (account and linked, including wallets
 * linked after the credit), so trades from any of them pay the inviter's half. Addresses already set onchain
 * are remembered in Redis; a wallet that someone else referred first is left alone (the contract sets once).
 */
export async function syncReferrers(c: Clients, limit = 50): Promise<number> {
  const keys = c.cfg.contracts.swayKeys;
  const op = c.operator;
  if (!keys || !op || !c.cfg.sponsorOnboarding) return 0;
  const refs = await c.prisma.referral.findMany({
    where: { status: 'credited', inviter: { wallet: { isNot: null } } },
    include: { inviter: { include: { wallet: true } }, invitee: { include: { wallet: true, linkedWallets: true } } },
  });
  let sent = 0;
  for (const r of refs) {
    const referrer = r.inviter.wallet!.address as `0x${string}`;
    const wallets = [r.invitee.wallet?.address, ...r.invitee.linkedWallets.map((l) => l.address)].filter(Boolean) as `0x${string}`[];
    for (const user of wallets) {
      if (sent >= limit) return sent;
      if (user === referrer || (await c.redis.sismember(KNOWN, user))) continue;
      const current = (await c.pub.readContract({ address: keys, abi: swayKeysAbi, functionName: 'referrerOf', args: [user] })) as string;
      if (!/^0x0{40}$/i.test(current)) {
        await c.redis.sadd(KNOWN, user);
        continue;
      }
      try {
        const hash = await withSenderLock(c, op, async () => {
          const h = await op.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'setReferrer', args: [user, referrer] });
          await c.pub.waitForTransactionReceipt({ hash: h });
          return h;
        });
        await c.redis.sadd(KNOWN, user);
        if (user === r.invitee.wallet?.address && !r.onchainTx) await c.prisma.referral.update({ where: { id: r.id }, data: { onchainTx: hash } });
        sent++;
      } catch (e) {
        console.warn(`[referrals] setReferrer failed for ${r.invitee.handle} (${user}): ${(e as Error).message.split('\n')[0]}`);
      }
    }
  }
  return sent;
}
