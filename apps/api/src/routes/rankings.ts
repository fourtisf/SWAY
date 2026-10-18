/** Leaderboard, Genesis pass ranking and Launchpad preview. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma, decToBig } from '@sway/db';
import { genesisSharePercent, GENESIS_MAX, tierOf } from '@sway/scoring';
import type {
  GenesisResponse,
  GenesisRow,
  LaunchpadResponse,
  LeaderboardResponse,
  LeaderboardRow,
  Address,
} from '@sway/shared';
import { query } from './_util';
import { getViewer } from '../plugins/auth';
import { userRef } from '../services/dto';
import { pointsDTO } from '../services/points';

interface Row {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  verified: boolean;
  official: boolean;
  memberNo: number | null;
  points: bigint;
  won: bigint;
  fees: Prisma.Decimal;
  staked: Prisma.Decimal;
}

const LB_BASE = Prisma.sql`
  WITH l AS (SELECT "userId", SUM(amount)::bigint AS s FROM "PointsLedger" GROUP BY "userId"),
  w AS (
    SELECT x.uid AS "userId", GREATEST(0, SUM(x.v))::bigint AS won FROM (
      SELECT "userId" AS uid, amount::bigint AS v FROM "PointsLedger" WHERE kind IN ('battle_payout', 'battle_back_payout')
      UNION ALL SELECT b."aId", -b.stake::bigint FROM "Battle" b WHERE b.status = 'settled'
      UNION ALL SELECT b."bId", -b.stake::bigint FROM "Battle" b WHERE b.status = 'settled' AND b."bId" IS NOT NULL
      UNION ALL SELECT bb."userId", -bb.amount::bigint FROM "BattleBacking" bb JOIN "Battle" b ON b.id = bb."battleId" WHERE b.status = 'settled'
    ) x GROUP BY x.uid
  ),
  m AS (
    SELECT u.id, u.handle, u.name, u."avatarUrl", u.verified, u.official, u."memberNo",
           GREATEST(0, LEAST(10000, u.score * 100) + u."heldPoints" + COALESCE(l.s, 0))::bigint AS points,
           COALESCE(w.won, 0)::bigint AS won,
           COALESCE(k."creatorFeesWei", 0) AS fees,
           COALESCE(st."amountWei", 0) AS staked
    FROM "User" u
    LEFT JOIN l ON l."userId" = u.id
    LEFT JOIN w ON w."userId" = u.id
    LEFT JOIN "KeyMarket" k ON k."userId" = u.id
    LEFT JOIN "Stake" st ON st."userId" = u.id
    WHERE u."joinedAt" IS NOT NULL AND u.official = false
  )`;

const METRIC = { points: 'points', creators: 'fees', stakers: 'staked', fighters: 'won' } as const;
const WEI = 10n ** 18n;

function toRow(r: Row, rank: number, meId: string | null): LeaderboardRow {
  const points = Number(r.points);
  return {
    rank,
    user: userRef(r),
    points,
    won: Number(r.won),
    feesWei: decToBig(r.fees).toString(),
    staked: Number(decToBig(r.staked) / WEI),
    tier: tierOf(points).name,
    me: r.id === meId,
  };
}

const GENESIS_SPLIT_RANKS = [1, 10, 50, 100, 250, 500];

export async function rankingRoutes(app: FastifyInstance) {
  const { prisma, config } = app.deps;

  app.get('/leaderboard', async (req): Promise<LeaderboardResponse> => {
    const { tab } = query(
      z.object({ tab: z.enum(['points', 'creators', 'stakers', 'fighters']).default('points') }),
      req,
    );
    const col = Prisma.raw(`m."${METRIC[tab]}"`);
    const col2 = Prisma.raw(`m2."${METRIC[tab]}"`);
    const v = await getViewer(req);
    const meId = v?.user.id ?? null;
    const rows = await prisma.$queryRaw<Row[]>(
      Prisma.sql`${LB_BASE} SELECT * FROM m ORDER BY ${col} DESC, m."memberNo" ASC NULLS LAST LIMIT 50`,
    );
    let me: LeaderboardRow | null = null;
    if (meId) {
      const idx = rows.findIndex((r) => r.id === meId);
      if (idx >= 0) me = toRow(rows[idx]!, idx + 1, meId);
      else {
        const mine = await prisma.$queryRaw<Array<Row & { ahead: number }>>(Prisma.sql`${LB_BASE}
          SELECT m.*, (SELECT count(*)::int FROM m m2
                       WHERE ${col2} > ${col}
                          OR (${col2} = ${col} AND COALESCE(m2."memberNo", 2147483647) < COALESCE(m."memberNo", 2147483647))) AS ahead
          FROM m WHERE m.id = ${meId}`);
        if (mine[0]) me = toRow(mine[0], mine[0].ahead + 1, meId);
      }
    }
    return { rows: rows.map((r, i) => toRow(r, i + 1, meId)), me };
  });

  app.get('/genesis', async (req): Promise<GenesisResponse> => {
    const v = await getViewer(req);
    const now = new Date();
    const split = GENESIS_SPLIT_RANKS.map((rank) => ({ rank, sharePct: genesisSharePercent(rank) }));
    const snapshot = await prisma.genesisSnapshot.findFirst({
      where: { takenAt: { lte: now } },
      orderBy: { takenAt: 'desc' },
    });
    const frozen = !!snapshot || now >= config.snapshotAt;

    if (snapshot) {
      const entries = await prisma.genesisEntry.findMany({
        where: { snapshotId: snapshot.id },
        orderBy: { rank: 'asc' },
        take: 30,
        include: { user: { include: { market: true } } },
      });
      const mine = v
        ? await prisma.genesisEntry.findUnique({
            where: { snapshotId_userId: { snapshotId: snapshot.id, userId: v.user.id } },
          })
        : null;
      return {
        snapshotAt: snapshot.takenAt.toISOString(),
        frozen: true,
        me: v
          ? mine
            ? {
                rank: mine.rank,
                points: mine.points,
                inCut: true,
                sharePct: genesisSharePercent(mine.rank),
                toCut: 0,
              }
            : { rank: 0, points: 0, inCut: false, sharePct: 0, toCut: 0 }
          : null,
        split,
        top: entries.map((e) => ({
          rank: e.rank,
          user: userRef(e.user, e.user.market),
          points: e.points,
          sharePct: genesisSharePercent(e.rank),
        })),
      };
    }

    // Live ranking among eligible members (brief §8): wallet, ≥1 task verified on X, no bot flag, score ≥ minimum.
    const eligibleBase = Prisma.sql`
      WITH l AS (SELECT "userId", SUM(amount)::bigint AS s FROM "PointsLedger" GROUP BY "userId"),
      m AS (
        SELECT u.id, u."memberNo",
               GREATEST(0, LEAST(10000, u.score * 100) + u."heldPoints" + COALESCE(l.s, 0))::bigint AS points
        FROM "User" u LEFT JOIN l ON l."userId" = u.id
        WHERE u."joinedAt" IS NOT NULL AND u.official = false AND u."botFlag" = false AND u.score >= ${config.genesisMinScore}
          AND EXISTS (SELECT 1 FROM "Wallet" wl WHERE wl."userId" = u.id)
          AND EXISTS (SELECT 1 FROM "TaskCompletion" tc WHERE tc."userId" = u.id AND tc.status = 'verified')
      )`;
    const ranked = await prisma.$queryRaw<Array<{ id: string; points: bigint }>>(
      Prisma.sql`${eligibleBase} SELECT id, points FROM m ORDER BY points DESC, "memberNo" ASC NULLS LAST LIMIT ${GENESIS_MAX}`,
    );
    const topIds = ranked.slice(0, 30);
    const users = await prisma.user.findMany({
      where: { id: { in: topIds.map((r) => r.id) } },
      include: { market: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const top: GenesisRow[] = topIds.flatMap((r, i) => {
      const u = byId.get(r.id);
      return u
        ? [
            {
              rank: i + 1,
              user: userRef(u, u.market),
              points: Number(r.points),
              sharePct: genesisSharePercent(i + 1),
            },
          ]
        : [];
    });

    let me: GenesisResponse['me'] = null;
    if (v) {
      const idx = ranked.findIndex((r) => r.id === v.user.id);
      const pts = idx >= 0 ? Number(ranked[idx]!.points) : (await pointsDTO(prisma, v.user)).total;
      let rank = idx + 1;
      if (idx < 0) {
        const [r] = await prisma.$queryRaw<Array<{ n: number }>>(
          Prisma.sql`${eligibleBase} SELECT count(*)::int AS n FROM m WHERE points > ${pts}`,
        );
        rank = (r?.n ?? 0) + 1;
      }
      const inCut = idx >= 0;
      const cutPoints = ranked.length >= GENESIS_MAX ? Number(ranked[GENESIS_MAX - 1]!.points) : 0;
      me = {
        rank,
        points: pts,
        inCut,
        sharePct: inCut ? genesisSharePercent(rank) : 0,
        toCut: inCut ? 0 : Math.max(0, cutPoints - pts + 1),
      };
    }
    return { snapshotAt: config.snapshotAt.toISOString(), frozen, me, split, top };
  });

  app.get('/launchpad', async (req): Promise<LaunchpadResponse> => {
    const v = await getViewer(req);
    if (!v) return { symbol: '$YOU', score: null, startCapUsd: null, launched: false, tokenAddress: null };
    const lt = await prisma.launchToken.findUnique({ where: { userId: v.user.id } });
    return {
      symbol:
        lt?.symbol ??
        '$' +
          v.user.handle
            .replace(/[^a-z0-9]/gi, '')
            .slice(0, 6)
            .toUpperCase(),
      score: v.user.score,
      startCapUsd: 2000 + v.user.score * 60,
      launched: !!lt?.launchedAt,
      tokenAddress: (lt?.tokenAddress as Address | null) ?? null,
    };
  });
}
