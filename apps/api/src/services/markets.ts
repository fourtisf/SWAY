/**
 * MarketDTO / ProfileDTO building. Prices come from @sway/curve (exact to the contract) at the mirrored
 * supply; change and spark come from the last 24 / 40 Trade rows.
 */
import type { KeyMarket, PrismaClient, User } from '@sway/db';
import { decToStr, Prisma } from '@sway/db';
import { priceWei, quoteWei, weiToEth } from '@sway/curve';
import type { Address, MarketCategory, MarketDTO } from '@sway/shared';
import { userRef, ZERO_ADDRESS } from './dto';

export const SPARK_POINTS = 40;
export const CHANGE_TRADES = 24;

export interface MarketStats {
  change: number;
  spark: number[];
}

interface TradePoint {
  marketId: string;
  isBuy: boolean;
  units: bigint;
  supplyAfter: bigint;
}

/** Supply before a trade, from its direction and size. */
const supplyBefore = (t: Pick<TradePoint, 'isBuy' | 'units' | 'supplyAfter'>) =>
  t.isBuy ? t.supplyAfter - t.units : t.supplyAfter + t.units;

export function statsFromTrades(
  supply: bigint,
  tradesOldestFirst: Array<Pick<TradePoint, 'isBuy' | 'units' | 'supplyAfter'>>,
): MarketStats {
  const current = weiToEth(priceWei(supply));
  if (!tradesOldestFirst.length) return { change: 0, spark: Array(SPARK_POINTS).fill(current) };
  const prices = [
    weiToEth(priceWei(supplyBefore(tradesOldestFirst[0]!))),
    ...tradesOldestFirst.map((t) => weiToEth(priceWei(t.supplyAfter))),
  ];
  const base = prices.length > CHANGE_TRADES ? prices[prices.length - 1 - CHANGE_TRADES]! : prices[0]!;
  const change = base > 0 ? (current / base - 1) * 100 : 0;
  return { change: Math.round(change * 100) / 100, spark: prices.slice(-SPARK_POINTS) };
}

/** Change and spark for many markets in one query (last 40 trades each). */
export async function marketStats(
  prisma: PrismaClient,
  markets: Array<Pick<KeyMarket, 'id' | 'supplyUnits'>>,
): Promise<Map<string, MarketStats>> {
  const out = new Map<string, MarketStats>();
  if (!markets.length) return out;
  const ids = markets.map((m) => m.id);
  const rows = await prisma.$queryRaw<TradePoint[]>(Prisma.sql`
    SELECT "marketId", "isBuy", "units", "supplyAfter" FROM (
      SELECT "marketId", "isBuy", "units", "supplyAfter", "ts", "blockNumber", "logIndex",
             row_number() OVER (PARTITION BY "marketId" ORDER BY "ts" DESC, "blockNumber" DESC, "logIndex" DESC) AS rn
      FROM "Trade" WHERE "marketId" = ANY(${ids}::text[])
    ) t WHERE rn <= ${SPARK_POINTS}
    ORDER BY "marketId", "ts" ASC, "blockNumber" ASC, "logIndex" ASC`);
  const byMarket = new Map<string, TradePoint[]>();
  for (const r of rows) {
    const list = byMarket.get(r.marketId) ?? [];
    list.push(r);
    byMarket.set(r.marketId, list);
  }
  for (const m of markets) out.set(m.id, statsFromTrades(m.supplyUnits, byMarket.get(m.id) ?? []));
  return out;
}

export type MarketWithUser = KeyMarket & { user: User };

export function marketDTO(m: MarketWithUser, stats?: MarketStats): MarketDTO {
  const s = stats ?? statsFromTrades(m.supplyUnits, []);
  return {
    ...userRef(m.user, m),
    subject: m.subject as Address,
    category: m.category as MarketCategory,
    claimed: m.claimed,
    followers: m.user.followers,
    score: m.user.score,
    reachValue: m.user.reachValue,
    supplyUnits: m.supplyUnits.toString(),
    priceWei: priceWei(m.supplyUnits).toString(),
    holders: m.holders,
    volumeWei: decToStr(m.volumeWei),
    escrowWei: decToStr(m.escrowWei),
    change: s.change,
    spark: s.spark,
    memberNo: m.user.memberNo,
    joinedAt: m.user.joinedAt?.toISOString() ?? null,
  };
}

/** MarketDTO for any user; members without a market yet get a zero subject and zero supply. */
export function marketDtoForUser(u: User & { market: KeyMarket | null }, stats?: MarketStats): MarketDTO {
  if (u.market) return marketDTO({ ...u.market, user: u }, stats);
  return {
    ...userRef(u, null),
    subject: ZERO_ADDRESS,
    category: 'creators',
    claimed: true,
    followers: u.followers,
    score: u.score,
    reachValue: u.reachValue,
    supplyUnits: '0',
    priceWei: '0',
    holders: 0,
    volumeWei: '0',
    escrowWei: '0',
    change: 0,
    spark: [],
    memberNo: u.memberNo,
    joinedAt: u.joinedAt?.toISOString() ?? null,
  };
}

export async function marketDTOs(prisma: PrismaClient, markets: MarketWithUser[]): Promise<MarketDTO[]> {
  const stats = await marketStats(prisma, markets);
  return markets.map((m) => marketDTO(m, stats.get(m.id)));
}

export async function marketDtosForUsers(
  prisma: PrismaClient,
  users: Array<User & { market: KeyMarket | null }>,
): Promise<MarketDTO[]> {
  const stats = await marketStats(
    prisma,
    users.flatMap((u) => (u.market ? [u.market] : [])),
  );
  return users.map((u) => marketDtoForUser(u, u.market ? stats.get(u.market.id) : undefined));
}

/** Total cost of one key (100 units) right now, fees included. */
export const oneKeyTotalWei = (supplyUnits: bigint): bigint =>
  supplyUnits >= 100n ? quoteWei(supplyUnits, 'buy', 100n).total : 0n;

/** Price history for the profile chart, oldest first. */
export async function priceHistory(
  prisma: PrismaClient,
  m: KeyMarket,
  limit = 500,
): Promise<Array<{ t: string; priceWei: string }>> {
  const trades = await prisma.trade.findMany({
    where: { marketId: m.id },
    orderBy: [{ ts: 'desc' }, { blockNumber: 'desc' }, { logIndex: 'desc' }],
    take: limit,
    select: { isBuy: true, units: true, supplyAfter: true, ts: true },
  });
  trades.reverse();
  const start = m.openedAt ?? m.createdAt;
  if (!trades.length) {
    const p = priceWei(m.supplyUnits).toString();
    return [
      { t: start.toISOString(), priceWei: p },
      { t: new Date().toISOString(), priceWei: p },
    ];
  }
  const first = trades[0]!;
  return [
    {
      t: (start < first.ts ? start : first.ts).toISOString(),
      priceWei: priceWei(supplyBefore(first)).toString(),
    },
    ...trades.map((t) => ({ t: t.ts.toISOString(), priceWei: priceWei(t.supplyAfter).toString() })),
  ];
}
