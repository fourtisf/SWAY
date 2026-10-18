/**
 * Battle lifecycle (brief §7), run every minute:
 * - unanswered challenges expire after 48h (stake refunded);
 * - live battles move to 'reading' when the 24h window closes;
 * - 6h later each side's post is read once from the X API and the battle settles: the winner takes both
 *   stakes minus 5%, winning backers split the losing pool pro rata minus 5%, no post = forfeit, both
 *   missing or a tie = draw (refunds);
 * - weekly (Mon 00:00 UTC) half of the treasury goes to the week's top three fighters (50/30/20).
 * All point movements are new PointsLedger rows with unique refs, so re-running is safe.
 */
import {
  BATTLE_READ_DELAY_HOURS,
  battleOutcome,
  battleScore,
  settleBackings,
  settleStakes,
  weeklyPrizes,
  type BattleMetrics,
  type BattleOutcome,
} from '@sway/scoring';
import { findRecentPostWithTag, getPostMetrics, isXBudgetExceeded } from '@sway/x';
import { hash, makeFormat, type RichText } from '@sway/shared';
import { utcDay, type Battle, type Prisma, type User } from '@sway/db';
import { rng } from '@sway/db/demo';
import type { Clients } from '../clients';
import { createNotification, publishNotifications } from '../notify';
import { appXContext } from '../xctx';

type Tx = Prisma.TransactionClient;
const H = 3600e3;

export interface SideRead {
  posted: boolean;
  postId: string | null;
  metrics: BattleMetrics;
  followers: number;
}

export interface BattleReader {
  readonly kind: 'x' | 'simulated';
  read(b: Battle, user: User, side: 'a' | 'b'): Promise<SideRead>;
}

const NONE: BattleMetrics = { likes: 0, reposts: 0, replies: 0, quotes: 0, bookmarks: 0 };

/** Reads the battle post (tagged, posted inside the window) once from the X API. */
export function xBattleReader(c: Clients): BattleReader | null {
  const ctx = appXContext(c);
  if (!ctx) return null;
  return {
    kind: 'x',
    async read(b, user) {
      const tag = b.tag.replace(/^#/, '');
      const since = b.acceptedAt ?? b.createdAt;
      const post = await findRecentPostWithTag(ctx, user.xId, tag, since);
      if (!post || (b.endsAt && new Date(post.createdAt) > b.endsAt)) return { posted: false, postId: null, metrics: NONE, followers: user.followers };
      const m = await getPostMetrics(ctx, post.id);
      return { posted: true, postId: post.id, metrics: m ?? NONE, followers: user.followers };
    },
  };
}

/**
 * Local development without X credentials: deterministic engagement near the battle's live estimate.
 * Never used when X_BEARER_TOKEN is set.
 */
export const simulatedBattleReader: BattleReader = {
  kind: 'simulated',
  async read(b, user, side) {
    const r = rng(hash(`${b.id}:${side}`));
    const er = (side === 'a' ? b.erA : b.erB) || 0.01 + r() * 0.03;
    const followers = Math.max(1, user.followers);
    const target = er * (0.85 + r() * 0.3) * followers;
    const likes = Math.round(target * 0.5);
    const reposts = Math.round((target * 0.15) / 2);
    const replies = Math.round((target * 0.2) / 3);
    const quotes = Math.round((target * 0.05) / 3);
    const bookmarks = Math.round((target * 0.1) / 2);
    return { posted: true, postId: null, metrics: { likes, reposts, replies, quotes, bookmarks }, followers };
  },
};

async function ledger(tx: Tx, userId: string, kind: 'battle_payout' | 'battle_back_payout' | 'weekly_prize', amount: number, ref: string) {
  if (amount === 0) return;
  await tx.pointsLedger.upsert({
    where: { userId_kind_ref: { userId, kind, ref } },
    update: {},
    create: { userId, kind, amount, ref },
  });
}

async function treasury(tx: Tx, amount: number, kind: string, ref: string) {
  if (amount === 0) return;
  await tx.treasuryEntry.upsert({ where: { ref }, update: {}, create: { amount, kind, ref } });
}

/** Refunds every backing (and the given stakes) of a battle that won't be played. */
async function refundAll(tx: Tx, b: Battle & { backings: Array<{ userId: string; amount: number }> }, stakers: string[]) {
  for (const uid of stakers) if (b.stake > 0) await ledger(tx, uid, 'battle_payout', b.stake, `battle:${b.id}:refund:${uid}`);
  for (const k of b.backings) await ledger(tx, k.userId, 'battle_back_payout', k.amount, `battle:${b.id}:back-refund:${k.userId}`);
}

export async function tickBattles(c: Clients, reader: BattleReader, now = new Date()): Promise<{ expired: number; closed: number; settled: number }> {
  const { prisma } = c;
  const out = { expired: 0, closed: 0, settled: 0 };
  const notes: string[] = [];

  const expiring = await prisma.battle.findMany({ where: { status: 'pending', expiresAt: { lt: now } }, include: { backings: true } });
  for (const b of expiring) {
    await prisma.$transaction(async (tx) => {
      await tx.battle.update({ where: { id: b.id }, data: { status: 'expired' } });
      await refundAll(tx, b, [b.aId]);
      notes.push(await createNotification(tx, { userId: b.aId, type: 'battle', link: '/battles', body: [{ t: 'Your challenge ' }, { t: `“${b.theme}”`, b: true }, { t: ' expired unanswered. Your stake is back.' }] }));
    });
    out.expired++;
  }

  const closing = await prisma.battle.updateMany({ where: { status: 'live', endsAt: { lt: now } }, data: { status: 'reading' } });
  out.closed = closing.count;

  const due = await prisma.battle.findMany({
    where: { status: 'reading', endsAt: { lt: new Date(now.getTime() - BATTLE_READ_DELAY_HOURS * H) } },
    include: { a: true, b: true, backings: true },
  });
  const F = makeFormat(await c.ethUsd());
  for (const b of due) {
    if (!b.b || !b.bId) continue;
    let ra: SideRead, rb: SideRead;
    try {
      ra = await reader.read(b, b.a, 'a');
      rb = await reader.read(b, b.b, 'b');
    } catch (e) {
      if (isXBudgetExceeded(e)) {
        console.warn('[battles] X budget exhausted; settlement retries next tick');
        break;
      }
      throw e;
    }
    const scoreA = ra.posted ? battleScore(ra.metrics, ra.followers) : 0;
    const scoreB = rb.posted ? battleScore(rb.metrics, rb.followers) : 0;
    const outcome: BattleOutcome = battleOutcome({ posted: ra.posted, score: scoreA }, { posted: rb.posted, score: scoreB });
    const stakes = settleStakes(outcome, b.stake, b.stake);
    const backs = settleBackings(outcome, b.backings.map((k) => ({ userId: k.userId, side: k.side, amount: k.amount })));
    await prisma.$transaction(async (tx) => {
      await ledger(tx, b.aId, 'battle_payout', stakes.payoutA, `battle:${b.id}:payout:a`);
      await ledger(tx, b.bId!, 'battle_payout', stakes.payoutB, `battle:${b.id}:payout:b`);
      for (const p of backs.payouts) {
        await ledger(tx, p.userId, 'battle_back_payout', p.payout, `battle:${b.id}:back:${p.userId}`);
        await tx.battleBacking.updateMany({ where: { battleId: b.id, userId: p.userId }, data: { payout: p.payout } });
      }
      await treasury(tx, stakes.treasury, 'battle_stakes', `battle:${b.id}:stakes`);
      await treasury(tx, backs.treasury, 'battle_backings', `battle:${b.id}:backings`);
      await tx.battle.update({
        where: { id: b.id },
        data: { status: 'settled', settledAt: now, winner: outcome, scoreA, scoreB, erA: scoreA, erB: scoreB, postAId: ra.postId, postBId: rb.postId, treasury: stakes.treasury + backs.treasury },
      });
      const result = (me: 'a' | 'b'): RichText =>
        outcome === 'draw'
          ? [{ t: 'Battle ' }, { t: `“${b.theme}”`, b: true }, { t: ' ended in a draw. Stakes and backings are refunded.' }]
          : outcome === me
            ? [{ t: 'You won ' }, { t: `“${b.theme}”`, b: true }, { t: ` with ${(Math.max(scoreA, scoreB) * 100).toFixed(2)}% engagement. ` }, { t: `+${F.int(me === 'a' ? stakes.payoutA : stakes.payoutB)} pts`, b: true }]
            : [{ t: 'You lost ' }, { t: `“${b.theme}”`, b: true }, { t: `. ${(Math.min(scoreA, scoreB) * 100).toFixed(2)}% vs ${(Math.max(scoreA, scoreB) * 100).toFixed(2)}%.` }];
      notes.push(await createNotification(tx, { userId: b.aId, type: 'battle', fromUserId: b.bId, link: '/battles', body: result('a') }));
      notes.push(await createNotification(tx, { userId: b.bId!, type: 'battle', fromUserId: b.aId, link: '/battles', body: result('b') }));
    });
    out.settled++;
  }
  await publishNotifications(c, notes);
  return out;
}

/** Monday 00:00 UTC: half the treasury to the week's top three fighters by points won (50/30/20). */
export async function payWeeklyPrizes(c: Clients, now = new Date()): Promise<number> {
  const { prisma } = c;
  const weekEnd = utcDay(now);
  const weekStart = new Date(weekEnd.getTime() - 7 * 24 * H);
  const key = weekEnd.toISOString().slice(0, 10);
  if (await prisma.treasuryEntry.findUnique({ where: { ref: `weekly:${key}` } })) return 0;

  const settled = await prisma.battle.findMany({ where: { status: 'settled', settledAt: { gte: weekStart, lt: weekEnd }, winner: { in: ['a', 'b'] } } });
  // Rank by points won (both stakes minus 5%, minus your own stake), then by wins for friendly battles.
  const won = new Map<string, { pts: number; wins: number }>();
  for (const b of settled) {
    const winnerId = b.winner === 'a' ? b.aId : b.bId!;
    const w = won.get(winnerId) ?? { pts: 0, wins: 0 };
    w.pts += settleStakes(b.winner as 'a' | 'b', b.stake, b.stake)[b.winner === 'a' ? 'payoutA' : 'payoutB'] - b.stake;
    w.wins += 1;
    won.set(winnerId, w);
  }
  const top = [...won.entries()].sort((x, y) => y[1].pts - x[1].pts || y[1].wins - x[1].wins).map(([id]) => id).slice(0, 3);
  const balance = (await prisma.treasuryEntry.aggregate({ _sum: { amount: true } }))._sum.amount ?? 0;
  const prizes = weeklyPrizes(balance, top).filter((p) => p.prize > 0);
  const notes: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (const [i, p] of prizes.entries()) {
      await ledger(tx, p.userId, 'weekly_prize', p.prize, `weekly:${key}`);
      notes.push(await createNotification(tx, { userId: p.userId, type: 'battle', link: '/leaderboard', body: [{ t: `Top fighter #${i + 1} this week. ` }, { t: `+${p.prize.toLocaleString('en-US')} pts`, b: true }, { t: ' from the battle treasury.' }] }));
    }
    await treasury(tx, -prizes.reduce((s, p) => s + p.prize, 0), 'weekly_prizes', `weekly:${key}`);
  });
  await publishNotifications(c, notes);
  return prizes.length;
}
