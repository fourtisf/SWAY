/**
 * Creator activity bond (brief §11, Phase 4): a creator who posts nothing in their room for 7 days has
 * their 6% creator fee redirected to holders (SwayKeys.creatorInactive) until they post again. Runs every
 * few minutes: flags quiet creators and clears the flag once they've posted. The indexer mirrors the
 * CreatorInactiveSet events into KeyMarket.creatorInactive.
 */
import { swayKeysAbi } from '@sway/shared/abi';
import type { Clients } from '../clients';
import { notify } from '../notify';
import { withSenderLock } from '../txlock';

export const QUIET_DAYS = 7;
const DAY_MS = 86400e3;

export async function enforceActivityBond(c: Clients, now = new Date()): Promise<{ flagged: number; cleared: number }> {
  const keys = c.cfg.contracts.swayKeys;
  const op = c.operator;
  const out = { flagged: 0, cleared: 0 };
  if (!keys || !op) return out;
  const markets = await c.prisma.keyMarket.findMany({
    where: { opened: true, claimed: true, user: { joinedAt: { not: null }, deletedAt: null } },
    select: { id: true, subject: true, userId: true, openedAt: true, creatorInactive: true, user: { select: { handle: true } } },
  });
  const cutoff = now.getTime() - QUIET_DAYS * DAY_MS;
  for (const m of markets) {
    const last = await c.prisma.roomMessage.findFirst({ where: { marketId: m.id, authorId: m.userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const lastActive = Math.max(last?.createdAt.getTime() ?? 0, m.openedAt?.getTime() ?? 0);
    const quiet = lastActive < cutoff;
    if (quiet === m.creatorInactive) continue;
    try {
      await withSenderLock(c, op, async () => {
        const hash = await op.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'setCreatorInactive', args: [m.subject as `0x${string}`, quiet] });
        await c.pub.waitForTransactionReceipt({ hash });
      });
    } catch (e) {
      console.warn(`[activity-bond] ${m.subject}: ${(e as Error).message.split('\n')[0]}`);
      continue;
    }
    if (quiet) {
      out.flagged++;
      await notify(c, {
        userId: m.userId, type: 'points', link: `/messages/room-${m.user.handle}`,
        body: [{ t: `No room post for ${QUIET_DAYS} days. ` }, { t: 'Your 6% creator fee now goes to your holders', b: true }, { t: ' until you post in your room again.' }],
      });
    } else {
      out.cleared++;
      await notify(c, { userId: m.userId, type: 'points', link: '/wallet', body: [{ t: 'Welcome back. ' }, { t: 'Your 6% creator fee is yours again.', b: true }] });
    }
  }
  return out;
}
