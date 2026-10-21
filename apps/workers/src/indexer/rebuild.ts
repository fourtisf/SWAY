/**
 * Rebuilds a market's mirrored state (supply, price, volume, fees, holdings) from its Trade rows. Used
 * after a reorg rollback, and handy as a consistency repair tool.
 */
import { LOCKED_UNITS, priceWei } from '@sway/curve';
import { addr, dec, decToBig, type Prisma } from '@sway/db';
import { recentChange } from './apply';

type Tx = Prisma.TransactionClient;

export async function rebuildMarket(tx: Tx, marketId: string, fanEscrow: string | null): Promise<void> {
  const market = await tx.keyMarket.findUniqueOrThrow({ where: { id: marketId }, include: { user: { include: { wallet: true } } } });
  const trades = await tx.trade.findMany({ where: { marketId }, orderBy: [{ blockNumber: 'asc' }, { logIndex: 'asc' }] });

  // A fan market's first key and fees sit in FanEscrow until its claim is onchain (claimBlock).
  const escrowed = market.fan && market.claimBlock === null;
  const lockHolder = escrowed ? fanEscrow : market.fan ? market.user.wallet?.address ?? null : market.subject;
  const book = new Map<string, { units: bigint; basis: bigint; realized: bigint }>();
  const get = (a: string) => book.get(a) ?? { units: 0n, basis: 0n, realized: 0n };
  if (market.opened && lockHolder) book.set(addr(lockHolder), { units: LOCKED_UNITS, basis: 0n, realized: 0n });

  let volume = 0n;
  let creatorFees = 0n;
  for (const t of trades) {
    volume += decToBig(t.baseWei);
    creatorFees += decToBig(t.creatorFeeWei);
    const h = get(t.trader);
    const total = decToBig(t.totalWei);
    if (t.isBuy) book.set(t.trader, { units: h.units + t.units, basis: h.basis + total, realized: h.realized });
    else {
      const sold = h.units > 0n ? (h.basis * t.units) / h.units : 0n;
      book.set(t.trader, { units: h.units - t.units, basis: h.basis - sold, realized: h.realized + total - sold });
    }
  }
  const supply = trades.length ? trades[trades.length - 1]!.supplyAfter : LOCKED_UNITS;

  await tx.holding.deleteMany({ where: { marketId } });
  const rows = [...book.entries()].map(([address, h]) => ({
    marketId, address, units: h.units < 0n ? 0n : h.units, costBasisWei: dec(h.basis), realizedPnlWei: dec(h.realized),
  }));
  if (rows.length) await tx.holding.createMany({ data: rows });
  await tx.keyMarket.update({
    where: { id: marketId },
    data: {
      supplyUnits: supply,
      priceWei: dec(priceWei(supply)),
      volumeWei: dec(volume),
      escrowWei: dec(escrowed ? creatorFees : 0n),
      creatorFeesWei: dec(escrowed ? 0n : creatorFees),
      holders: rows.filter((r) => r.units > 0n).length,
      lastTradeAt: trades.length ? trades[trades.length - 1]!.ts : null,
      change: await recentChange(tx, marketId, supply),
    },
  });
}
