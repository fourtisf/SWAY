/**
 * Points engine (brief §6). Every minute:
 * - recounts keys-held points: 400K per ETH of current sell value, own key excluded (User.heldPoints);
 * - refreshes the cached ledger sum (User.ledgerPoints) from the append-only PointsLedger;
 * - updates the tier.
 * Nothing here writes ledger rows; held points are a live value, not an event.
 */
import { weiToEth } from '@sway/curve';
import { heldPoints, scorePoints, tierOf } from '@sway/scoring';
import type { Clients } from '../clients';
import { sellValueWei } from '../indexer/apply';

export async function recountPoints(c: Clients): Promise<{ members: number; changed: number }> {
  const { prisma } = c;
  const [holdings, wallets, sums, members] = await Promise.all([
    prisma.holding.findMany({ where: { units: { gt: 0n } }, include: { market: { select: { userId: true, supplyUnits: true } } } }),
    prisma.wallet.findMany({ select: { address: true, userId: true } }),
    prisma.pointsLedger.groupBy({ by: ['userId'], _sum: { amount: true } }),
    prisma.user.findMany({ where: { joinedAt: { not: null } }, select: { id: true, score: true, heldPoints: true, ledgerPoints: true, tier: true } }),
  ]);
  const owner = new Map(wallets.map((w) => [w.address, w.userId]));
  const heldEth = new Map<string, number>();
  for (const h of holdings) {
    const userId = owner.get(h.address);
    if (!userId || userId === h.market.userId) continue;
    heldEth.set(userId, (heldEth.get(userId) ?? 0) + weiToEth(sellValueWei(h.market.supplyUnits, h.units, false)));
  }
  const ledger = new Map(sums.map((s) => [s.userId, s._sum.amount ?? 0]));

  let changed = 0;
  const updates = [];
  for (const m of members) {
    const held = heldPoints(heldEth.get(m.id) ?? 0);
    const led = ledger.get(m.id) ?? 0;
    const tier = tierOf(scorePoints(m.score) + led + held).name;
    if (held !== m.heldPoints || led !== m.ledgerPoints || tier !== m.tier) {
      changed++;
      updates.push(prisma.user.update({ where: { id: m.id }, data: { heldPoints: held, ledgerPoints: led, tier } }));
    }
  }
  for (let i = 0; i < updates.length; i += 200) await prisma.$transaction(updates.slice(i, i + 200));
  return { members: members.length, changed };
}
