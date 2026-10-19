/**
 * Watchlist price alerts: when a watched key's price moved alertPct percent from the watch's baseline, notify
 * the watcher (a `trade` notification, unless they turned alerts off) and move the baseline to the new price,
 * so each move alerts once.
 */
import { weiToEth } from '@sway/curve';
import { makeFormat, resolveNotificationPrefs } from '@sway/shared';
import { dec, decToBig } from '@sway/db';
import type { Clients } from '../clients';
import { notify } from '../notify';

export async function checkPriceAlerts(c: Clients): Promise<number> {
  const watches = await c.prisma.watch.findMany({
    where: { alertPct: { gt: 0 }, subject: { market: { opened: true } }, user: { deletedAt: null } },
    include: { subject: { select: { handle: true, market: { select: { priceWei: true } } } }, user: { select: { notifPrefs: true } } },
  });
  const f = makeFormat(await c.ethUsd());
  let sent = 0;
  for (const w of watches) {
    const price = decToBig(w.subject.market!.priceWei);
    const base = decToBig(w.baselineWei);
    if (base === 0n) {
      await c.prisma.watch.update({ where: { userId_subjectId: { userId: w.userId, subjectId: w.subjectId } }, data: { baselineWei: dec(price) } });
      continue;
    }
    const diff = price > base ? price - base : base - price;
    if (diff * 100n < base * BigInt(w.alertPct)) continue;
    // Guard on the old baseline so two runs never alert twice for one move.
    const moved = await c.prisma.watch.updateMany({
      where: { userId: w.userId, subjectId: w.subjectId, baselineWei: w.baselineWei },
      data: { baselineWei: dec(price) },
    });
    if (!moved.count || !resolveNotificationPrefs(w.user.notifPrefs).alerts) continue;
    const pct = Number((diff * 10_000n) / base) / 100;
    await notify(c, {
      userId: w.userId,
      type: 'trade',
      fromUserId: w.subjectId,
      link: `/${w.subject.handle}`,
      body: [
        { t: `@${w.subject.handle}`, b: true },
        { t: ` key is ${price > base ? 'up' : 'down'} ${pct.toFixed(1)}% to ${f.eth(weiToEth(price))} ETH since your alert was set.` },
      ],
    });
    sent++;
  }
  return sent;
}
