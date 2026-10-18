/**
 * Points (brief §6): total = scorePoints(score) + Σ PointsLedger + user.heldPoints (live, kept by the workers).
 * The ledger is append-only; every write carries an idempotency ref under @@unique([userId, kind, ref]).
 */
import type { PointsKind, Prisma, PrismaClient, User } from '@sway/db';
import { Prisma as P } from '@sway/db';
import { scorePoints, tierProgress } from '@sway/scoring';
import type { PointsDTO } from '@sway/shared';

type Tx = Prisma.TransactionClient | PrismaClient;

export interface LedgerEntry {
  userId: string;
  kind: PointsKind;
  amount: number;
  ref: string;
}

/** Appends a ledger row unless its ref exists. Returns true when written. Keeps User.ledgerPoints in step. */
export async function appendLedger(tx: Tx, e: LedgerEntry): Promise<boolean> {
  const { count } = await tx.pointsLedger.createMany({ data: [e], skipDuplicates: true });
  if (count === 1 && e.amount !== 0) {
    await tx.user.update({ where: { id: e.userId }, data: { ledgerPoints: { increment: e.amount } } });
  }
  return count === 1;
}

export async function ledgerSum(tx: Tx, userId: string): Promise<number> {
  const r = await tx.pointsLedger.aggregate({ where: { userId }, _sum: { amount: true } });
  return r._sum.amount ?? 0;
}

/** SQL for every member's live points: rows (id, points). */
export const memberPointsSql = P.sql`
  SELECT u.id,
         GREATEST(0, LEAST(10000, u.score * 100) + u."heldPoints" + COALESCE(l.s, 0))::bigint AS points
  FROM "User" u
  LEFT JOIN (SELECT "userId", SUM(amount)::bigint AS s FROM "PointsLedger" GROUP BY "userId") l ON l."userId" = u.id
  WHERE u."joinedAt" IS NOT NULL AND u.official = false`;

export async function rankForPoints(prisma: PrismaClient, total: number): Promise<number> {
  const r = await prisma.$queryRaw<Array<{ n: number }>>(
    P.sql`SELECT count(*)::int AS n FROM (${memberPointsSql}) m WHERE m.points > ${total}`,
  );
  return 1 + (r[0]?.n ?? 0);
}

export interface PointsParts {
  total: number;
  score: number;
  ledger: number;
  held: number;
  earned: number;
}

export async function pointsParts(
  tx: Tx,
  user: Pick<User, 'id' | 'score' | 'heldPoints'>,
): Promise<PointsParts> {
  const ledger = await ledgerSum(tx, user.id);
  const score = scorePoints(user.score);
  const held = user.heldPoints;
  const total = Math.max(0, Math.round(score + ledger + held));
  return { total, score, ledger, held, earned: total - score };
}

export function pointsDtoFrom(parts: PointsParts, rank: number): PointsDTO {
  const tp = tierProgress(parts.total);
  return {
    total: parts.total,
    score: parts.score,
    ledger: parts.ledger,
    held: parts.held,
    tier: tp.tier.name,
    tierIndex: tp.index,
    nextTier: tp.next?.name ?? null,
    toNext: tp.toNext,
    progress: tp.progress,
    rank,
    earned: parts.earned,
  };
}

export async function pointsDTO(
  prisma: PrismaClient,
  user: Pick<User, 'id' | 'score' | 'heldPoints' | 'joinedAt'>,
): Promise<PointsDTO> {
  const parts = await pointsParts(prisma, user);
  const rank = await rankForPoints(prisma, parts.total);
  return pointsDtoFrom(parts, rank);
}

/** Points that can be staked or spent on backings (everything except score points). */
export async function earnedPoints(tx: Tx, userId: string): Promise<number> {
  const u = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, score: true, heldPoints: true },
  });
  if (!u) return 0;
  return (await pointsParts(tx, u)).earned;
}

export const EMPTY_POINTS: PointsDTO = pointsDtoFrom(
  { total: 0, score: 0, ledger: 0, held: 0, earned: 0 },
  0,
);
