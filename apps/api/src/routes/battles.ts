/**
 * Battles (brief §7). The API validates and debits stakes/backings in the ledger; settlement (X reads 6h after
 * the window, payouts, treasury) is done by the workers.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  Prisma,
  type Battle,
  type BattleBacking,
  type KeyMarket,
  type PrismaClient,
  type User,
} from '@sway/db';
import {
  BACKING_MIN,
  BATTLE_EXPIRE_HOURS,
  BATTLE_MAX_ACTIVE,
  BATTLE_REMATCH_DAYS,
  BATTLE_TAG,
  BATTLE_TREASURY_BPS,
  BATTLE_WINDOW_HOURS,
} from '@sway/scoring';
import { normalizeHandle, type BattleDTO, type BattlesResponse, type RichText } from '@sway/shared';
import { IdParams, body, params } from './_util';
import { getViewer, requireViewer } from '../plugins/auth';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { marketStats, marketDtoForUser } from '../services/markets';
import { appendLedger, earnedPoints } from '../services/points';
import { notify } from '../services/notify';

const HOUR = 3600 * 1000;
const ACTIVE = ['pending', 'live', 'reading'] as const;

type BattleRow = Battle & {
  a: User & { market: KeyMarket | null };
  b: (User & { market: KeyMarket | null }) | null;
  backings: BattleBacking[];
};
const BATTLE_INCLUDE = {
  a: { include: { market: true } },
  b: { include: { market: true } },
  backings: true,
} satisfies Prisma.BattleInclude;

type Tx = Prisma.TransactionClient;

async function lockUsers(tx: Tx, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'pts:' + id}))`;
}

async function activeCount(
  tx: Tx | PrismaClient,
  userId: string,
  now: Date,
  exceptId?: string,
): Promise<number> {
  return tx.battle.count({
    where: {
      OR: [{ aId: userId }, { bId: userId }],
      ...(exceptId ? { id: { not: exceptId } } : {}),
      AND: [{ OR: [{ status: { in: ['live', 'reading'] } }, { status: 'pending', expiresAt: { gt: now } }] }],
    },
  });
}

async function recentRematch(tx: Tx, x: string, y: string, now: Date, exceptId?: string): Promise<boolean> {
  const n = await tx.battle.count({
    where: {
      OR: [
        { aId: x, bId: y },
        { aId: y, bId: x },
      ],
      createdAt: { gt: new Date(now.getTime() - BATTLE_REMATCH_DAYS * 24 * HOUR) },
      status: { notIn: ['declined', 'expired'] },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  });
  return n > 0;
}

async function battleDTOs(
  prisma: PrismaClient,
  battles: BattleRow[],
  viewerId: string | null,
  now = new Date(),
): Promise<BattleDTO[]> {
  const users = new Map<string, User & { market: KeyMarket | null }>();
  for (const b of battles) {
    users.set(b.a.id, b.a);
    if (b.b) users.set(b.b.id, b.b);
  }
  const stats = await marketStats(
    prisma,
    [...users.values()].flatMap((u) => (u.market ? [u.market] : [])),
  );
  const dto = (u: User & { market: KeyMarket | null }) =>
    marketDtoForUser(u, u.market ? stats.get(u.market.id) : undefined);
  return battles.map((b) => {
    const mine = viewerId ? b.backings.find((k) => k.userId === viewerId) : undefined;
    const pending = b.status === 'pending' && b.expiresAt > now;
    return {
      id: b.id,
      a: dto(b.a),
      b: b.b ? dto(b.b) : null,
      theme: b.theme,
      tag: b.tag,
      stake: b.stake,
      status: b.status === 'pending' && b.expiresAt <= now ? 'expired' : b.status,
      endsAt: b.endsAt?.toISOString() ?? null,
      erA: b.erA,
      erB: b.erB,
      poolA: b.backings.filter((k) => k.side === 'a').reduce((s, k) => s + k.amount, 0),
      poolB: b.backings.filter((k) => k.side === 'b').reduce((s, k) => s + k.amount, 0),
      winner: b.winner,
      myBacking: mine ? { side: mine.side, amount: mine.amount } : null,
      canRespond: !!viewerId && pending && (b.bId === viewerId || (b.bId === null && b.aId !== viewerId)),
    };
  });
}

const CreateBody = z.object({
  opponent: z.string().trim().max(40).optional(),
  theme: z.string().trim().min(3).max(120),
  stake: z.coerce.number().int().min(0).max(100_000_000).default(0),
});
const RespondBody = z.object({ accept: z.boolean() });
const BackBody = z.object({
  side: z.enum(['a', 'b']),
  amount: z.coerce.number().int().min(BACKING_MIN).max(100_000_000),
});

export async function battleRoutes(app: FastifyInstance) {
  const { prisma, redis } = app.deps;
  const load = async (id: string) => {
    const b = await prisma.battle.findUnique({ where: { id }, include: BATTLE_INCLUDE });
    if (!b) throw notFound('Battle not found', 'battle_not_found');
    return b;
  };
  const one = async (id: string, viewerId: string | null) =>
    (await battleDTOs(prisma, [await load(id)], viewerId))[0]!;

  app.get('/battles', async (req): Promise<BattlesResponse> => {
    const v = await getViewer(req);
    const now = new Date();
    const battles = await prisma.battle.findMany({
      where: {
        OR: [
          { status: { in: ['live', 'reading'] } },
          { status: 'pending', expiresAt: { gt: now } },
          { status: 'settled', settledAt: { gt: new Date(now.getTime() - 7 * 24 * HOUR) } },
        ],
      },
      include: BATTLE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 60,
    });
    const order = { live: 0, reading: 1, pending: 2, settled: 3, declined: 4, expired: 5 } as const;
    battles.sort(
      (x, y) => order[x.status] - order[y.status] || y.createdAt.getTime() - x.createdAt.getTime(),
    );
    const treasury = await prisma.treasuryEntry.aggregate({ _sum: { amount: true } });
    return {
      weeklyPool: Math.max(0, Math.floor((treasury._sum.amount ?? 0) / 2)),
      treasuryFeePct: BATTLE_TREASURY_BPS / 100,
      battles: await battleDTOs(prisma, battles, v?.user.id ?? null, now),
    };
  });

  app.post(
    '/battles',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req): Promise<BattleDTO> => {
      const v = await requireViewer(req);
      const b = body(CreateBody, req);
      const me = v.user;
      const oppHandle = b.opponent ? normalizeHandle(b.opponent) : '';
      let opp: User | null = null;
      if (oppHandle) {
        opp = await prisma.user.findUnique({ where: { handle: oppHandle } });
        if (!opp || !opp.joinedAt || opp.official)
          throw notFound(`@${oppHandle} isn’t a Sway member`, 'user_not_found');
        if (opp.id === me.id) throw badRequest('self', 'You can’t challenge yourself');
      }
      const now = new Date();
      const created = await prisma.$transaction(async (tx) => {
        await lockUsers(tx, [me.id, ...(opp ? [opp.id] : [])]);
        if ((await activeCount(tx, me.id, now)) >= BATTLE_MAX_ACTIVE)
          throw conflict('battle_limit', `You can have ${BATTLE_MAX_ACTIVE} active battles at most`);
        if (opp) {
          if ((await activeCount(tx, opp.id, now)) >= BATTLE_MAX_ACTIVE)
            throw conflict(
              'opponent_battle_limit',
              `@${opp.handle} already has ${BATTLE_MAX_ACTIVE} active battles`,
            );
          if (await recentRematch(tx, me.id, opp.id, now))
            throw conflict(
              'rematch_cooldown',
              `No rematch against @${opp.handle} within ${BATTLE_REMATCH_DAYS} days`,
            );
        }
        if (b.stake > 0) {
          const mine = await earnedPoints(tx, me.id);
          const max = opp ? Math.min(mine, await earnedPoints(tx, opp.id)) : mine;
          if (b.stake > max)
            throw badRequest(
              'stake_too_high',
              `The stake can be at most ${Math.max(0, max).toLocaleString('en-US')} earned points`,
            );
        }
        const battle = await tx.battle.create({
          data: {
            aId: me.id,
            bId: opp?.id ?? null,
            theme: b.theme,
            tag: BATTLE_TAG,
            stake: b.stake,
            status: 'pending',
            expiresAt: new Date(now.getTime() + BATTLE_EXPIRE_HOURS * HOUR),
          },
        });
        if (b.stake > 0)
          await appendLedger(tx, {
            userId: me.id,
            kind: 'battle_stake',
            amount: -b.stake,
            ref: `battle:${battle.id}:a`,
          });
        return battle;
      });
      if (opp) {
        const text: RichText = b.stake
          ? [
              { t: me.name, b: true },
              { t: ` challenged you to a battle for ${b.stake.toLocaleString('en-US')} pts: “${b.theme}”` },
            ]
          : [{ t: me.name, b: true }, { t: ` wants a friendly battle: “${b.theme}”` }];
        await notify(prisma, redis, {
          userId: opp.id,
          type: 'battle',
          fromUserId: me.id,
          body: text,
          link: '/battles',
        });
      }
      return one(created.id, me.id);
    },
  );

  app.post('/battles/:id/respond', async (req): Promise<BattleDTO> => {
    const v = await requireViewer(req);
    const { id } = params(IdParams, req);
    const { accept } = body(RespondBody, req);
    const me = v.user;
    const battle = await load(id);
    const now = new Date();
    if (battle.status !== 'pending') throw conflict('not_pending', 'This challenge was already answered');
    if (battle.expiresAt <= now) throw conflict('expired', 'This challenge expired');
    const isA = battle.aId === me.id;
    const isB = battle.bId === me.id;
    const open = battle.bId === null;

    if (accept) {
      if (isA) throw badRequest('self', 'You can’t accept your own challenge');
      if (!isB && !open) throw forbidden('not_yours', 'This challenge is for someone else');
      await prisma.$transaction(async (tx) => {
        await lockUsers(tx, [me.id, battle.aId]);
        if ((await activeCount(tx, me.id, now, battle.id)) >= BATTLE_MAX_ACTIVE)
          throw conflict('battle_limit', `You can have ${BATTLE_MAX_ACTIVE} active battles at most`);
        if (open && (await recentRematch(tx, me.id, battle.aId, now, battle.id))) {
          throw conflict('rematch_cooldown', `No rematch within ${BATTLE_REMATCH_DAYS} days`);
        }
        if (battle.stake > 0 && (await earnedPoints(tx, me.id)) < battle.stake) {
          throw badRequest(
            'not_enough_points',
            `You need ${battle.stake.toLocaleString('en-US')} earned points to accept`,
          );
        }
        const r = await tx.battle.updateMany({
          where: { id: battle.id, status: 'pending', ...(open ? { bId: null } : { bId: me.id }) },
          data: {
            status: 'live',
            bId: me.id,
            acceptedAt: now,
            endsAt: new Date(now.getTime() + BATTLE_WINDOW_HOURS * HOUR),
          },
        });
        if (r.count !== 1) throw conflict('not_pending', 'This challenge was already answered');
        if (battle.stake > 0)
          await appendLedger(tx, {
            userId: me.id,
            kind: 'battle_stake',
            amount: -battle.stake,
            ref: `battle:${battle.id}:b`,
          });
      });
      await notify(prisma, redis, {
        userId: battle.aId,
        type: 'battle',
        fromUserId: me.id,
        body: [
          { t: me.name, b: true },
          { t: ` accepted your battle: “${battle.theme}”. ${BATTLE_WINDOW_HOURS}h on the clock.` },
        ],
        link: '/battles',
      });
    } else {
      if (!isA && !isB) throw forbidden('not_yours', 'Only the challenged account can decline');
      await prisma.$transaction(async (tx) => {
        const r = await tx.battle.updateMany({
          where: { id: battle.id, status: 'pending' },
          data: { status: 'declined' },
        });
        if (r.count !== 1) throw conflict('not_pending', 'This challenge was already answered');
        if (battle.stake > 0)
          await appendLedger(tx, {
            userId: battle.aId,
            kind: 'battle_stake',
            amount: battle.stake,
            ref: `battle:${battle.id}:a:refund`,
          });
      });
      const other = isB ? battle.aId : battle.bId;
      if (other) {
        await notify(prisma, redis, {
          userId: other,
          type: 'battle',
          fromUserId: me.id,
          body: [
            { t: me.name, b: true },
            {
              t: isB
                ? ` declined your battle: “${battle.theme}”.`
                : ` withdrew the challenge: “${battle.theme}”.`,
            },
            ...(battle.stake && isB ? [{ t: ' Your stake is back.' }] : []),
          ],
          link: '/battles',
        });
      }
    }
    return one(battle.id, me.id);
  });

  app.post('/battles/:id/back', async (req): Promise<BattleDTO> => {
    const v = await requireViewer(req);
    const { id } = params(IdParams, req);
    const b = body(BackBody, req);
    const me = v.user;
    const battle = await load(id);
    const now = new Date();
    if (battle.aId === me.id || battle.bId === me.id)
      throw forbidden('fighter', 'Fighters can’t back a side');
    const open =
      battle.status === 'pending'
        ? battle.expiresAt > now
        : battle.status === 'live' && !!battle.endsAt && battle.endsAt > now;
    if (!open) throw conflict('window_closed', 'Backing is closed for this battle');
    if (b.side === 'b' && !battle.bId)
      throw badRequest('no_opponent', 'Nobody has accepted this challenge yet');
    await prisma.$transaction(async (tx) => {
      await lockUsers(tx, [me.id]);
      if ((await earnedPoints(tx, me.id)) < b.amount)
        throw badRequest('not_enough_points', 'Not enough earned points');
      const r = await tx.battleBacking.createMany({
        data: [{ battleId: battle.id, userId: me.id, side: b.side, amount: b.amount }],
        skipDuplicates: true,
      });
      if (r.count !== 1) throw conflict('already_backed', 'You already backed this battle');
      await appendLedger(tx, {
        userId: me.id,
        kind: 'battle_back',
        amount: -b.amount,
        ref: `back:${battle.id}`,
      });
    });
    return one(battle.id, me.id);
  });
}
