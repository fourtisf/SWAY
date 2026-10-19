/**
 * [D] engagement: watchlist, daily streak, referral dashboard, notification prefs and creator drops.
 */
import { INVITE_POINTS, INVITES_CREDITED_PER_DAY, nextStreak, streakPoints, STREAK_CAP_DAYS, STREAK_POINTS_PER_DAY, utcDayKey } from '@sway/scoring';
import {
  buildAirdrop,
  resolveNotificationPrefs,
  type Address,
  type ClaimableDropDTO,
  type CreatorDropDTO,
  type DropPlanDTO,
  type NotificationPrefs,
  type ReferralsResponse,
  type StreakDTO,
  type WatchDTO,
} from '@sway/shared';
import { dec, decToBig, type CreatorDrop, type KeyMarket, type PrismaClient, type User, type Watch } from '@sway/db';
import type { AppDeps, Viewer } from '../deps';
import { badRequest, conflict, unavailable } from '../errors';
import { memberAddresses } from './access';
import { appendLedger } from './points';
import { membersByAddress, userRef } from './dto';

export const MAX_WATCHES = 200;
export const MAX_PUSH_SUBSCRIPTIONS = 10;
/** Smallest and largest drop the API builds a tree for. */
export const MIN_DROP_WEI = 10n ** 12n;
export const MAX_DROP_WEI = 1_000n * 10n ** 18n;
export const DROP_MIN_DAYS = 1;
export const DROP_MAX_DAYS = 365;

/* ------------------------------------------------------------------ watchlist */

export function watchDTO(w: Watch, subject: User & { market: KeyMarket | null }): WatchDTO {
  const price = subject.market ? decToBig(subject.market.priceWei) : 0n;
  const base = decToBig(w.baselineWei);
  return {
    ...userRef(subject, subject.market),
    priceWei: price.toString(),
    alertPct: w.alertPct,
    baselineWei: base.toString(),
    change: base > 0n ? Number(((price - base) * 10_000n) / base) / 100 : 0,
    createdAt: w.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ streak */

export function streakDTO(u: Pick<User, 'streakDays' | 'streakLastDay'>, today = utcDayKey()): StreakDTO {
  const n = nextStreak(u.streakLastDay, u.streakDays, today);
  // A streak that missed yesterday is already broken: show 0 until the next check-in starts a new one.
  const days = n.already || n.days > 1 ? u.streakDays : 0;
  return {
    days,
    checkedInToday: n.already,
    lastDay: u.streakLastDay,
    nowPoints: n.already ? 0 : streakPoints(n.days),
    nextPoints: streakPoints((n.already ? days : n.days) + 1),
    perDay: STREAK_POINTS_PER_DAY,
    capDays: STREAK_CAP_DAYS,
  };
}

/** One check-in per UTC day; the ledger ref `streak:<day>` makes a lost race harmless. */
export async function checkIn(prisma: PrismaClient, userId: string, today = utcDayKey()): Promise<{ streak: StreakDTO; awarded: number }> {
  let awarded = 0;
  await prisma.$transaction(async (tx) => {
    const u = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { streakDays: true, streakLastDay: true } });
    const n = nextStreak(u.streakLastDay, u.streakDays, today);
    if (n.already) return;
    const moved = await tx.user.updateMany({ where: { id: userId, streakLastDay: u.streakLastDay }, data: { streakDays: n.days, streakLastDay: today } });
    if (!moved.count) return;
    const amount = streakPoints(n.days);
    if (await appendLedger(tx, { userId, kind: 'streak', amount, ref: `streak:${today}` })) awarded = amount;
  });
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { streakDays: true, streakLastDay: true } });
  return { streak: streakDTO(u, today), awarded };
}

/* ------------------------------------------------------------------ notification prefs */

export const prefsOf = (u: Pick<User, 'notifPrefs'>): NotificationPrefs => resolveNotificationPrefs(u.notifPrefs);

/** Notification types the member hasn't muted (for the list and the unread badge). */
export function visibleTypes(prefs: NotificationPrefs): Array<'trade' | 'mention' | 'battle' | 'points'> {
  return (['trade', 'mention', 'battle', 'points'] as const).filter((t) => prefs[t]);
}

/* ------------------------------------------------------------------ creator drops */

/**
 * Splits `amount` across the creator's key holders pro rata to units (all of each holder's wallets count
 * separately, as onchain), leaving out the creator's own wallets, the fan escrow and bot-flagged members,
 * and stores the tree so holders can fetch their proofs.
 */
export async function planDrop(deps: Pick<AppDeps, 'prisma' | 'config'>, v: Viewer, amount: bigint): Promise<DropPlanDTO> {
  const { prisma, config } = deps;
  const contract = config.contracts.drops;
  if (!contract) throw unavailable('drops_unavailable', 'Creator drops are not deployed on this chain yet.');
  if (!v.market?.opened || v.market.fan) throw conflict('no_market', 'Open your key market before dropping to holders.');
  if (amount < MIN_DROP_WEI || amount > MAX_DROP_WEI) throw badRequest('bad_amount', 'Drop between 0.000001 and 1,000 ETH.');
  const own = new Set(await memberAddresses(prisma, v.user.id));
  const escrow = config.contracts.fanEscrow?.toLowerCase();
  const rows = await prisma.holding.findMany({ where: { marketId: v.market.id, units: { gt: 0n } }, select: { address: true, units: true } });
  const owners = await membersByAddress(prisma, rows.map((r) => r.address));
  const eligible = rows.filter((r) => !own.has(r.address) && r.address !== escrow && !owners.get(r.address)?.botFlag);
  if (!eligible.length) throw conflict('no_holders', 'Nobody else holds your key yet.');
  const tree = buildAirdrop(eligible, amount);
  const root = tree.root.toLowerCase();
  const units = new Map(eligible.map((r) => [r.address, r.units]));
  const entries = tree.entries.map((e) => ({ ...e, address: e.address.toLowerCase() }));
  // Claims are tracked per (root, address), so one tree funds one drop.
  if (await prisma.creatorDrop.findFirst({ where: { root }, select: { id: true } })) {
    throw conflict('already_dropped', 'You already dropped this exact amount to these holders. Change the amount to drop again.');
  }
  if (!(await prisma.dropPlan.findUnique({ where: { root } }))) {
    await prisma.dropPlan
      .create({
        data: {
          root,
          creatorId: v.user.id,
          totalWei: dec(amount),
          holders: entries.length,
          allocations: {
            create: entries.map((e) => ({ address: e.address, userId: owners.get(e.address)?.id ?? null, amountWei: dec(e.amount), proof: e.proof })),
          },
        },
      })
      .catch((e: { code?: string }) => {
        if (e.code !== 'P2002') throw e; // the same tree built twice at once
      });
  }
  const top = [...entries].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)).slice(0, 20);
  return {
    root: root as `0x${string}`,
    totalWei: amount.toString(),
    holders: entries.length,
    contract: contract as Address,
    minDays: DROP_MIN_DAYS,
    maxDays: DROP_MAX_DAYS,
    top: top.map((e) => {
      const u = owners.get(e.address);
      return { address: e.address as Address, user: u ? userRef(u, u.market) : null, amountWei: e.amount.toString(), units: (units.get(e.address) ?? 0n).toString() };
    }),
  };
}

export async function creatorDrops(prisma: PrismaClient, creator: User & { market: KeyMarket | null }, viewerId: string | null): Promise<CreatorDropDTO[]> {
  const addrs = await memberAddresses(prisma, creator.id);
  if (!addrs.length) return [];
  const drops = await prisma.creatorDrop.findMany({ where: { creator: { in: addrs } }, orderBy: { id: 'desc' }, take: 50 });
  const roots = [...new Set(drops.map((d) => d.root))];
  const [plans, claims] = await Promise.all([
    prisma.dropPlan.findMany({ where: { root: { in: roots } }, select: { root: true, holders: true } }),
    prisma.dropAllocation.groupBy({ by: ['root'], where: { root: { in: roots }, claimTx: { not: null } }, _count: { _all: true } }),
  ]);
  const holders = new Map(plans.map((p) => [p.root, p.holders]));
  const claimed = new Map(claims.map((c) => [c.root, c._count._all]));
  const now = Date.now();
  return drops.map((d) => dropDTO(d, creator, holders.get(d.root) ?? 0, claimed.get(d.root) ?? 0, viewerId === creator.id && now >= d.expiresAt.getTime()));
}

function dropDTO(d: CreatorDrop, creator: User & { market: KeyMarket | null }, holders: number, claims: number, expiredForCreator: boolean): CreatorDropDTO {
  const left = decToBig(d.totalWei) - decToBig(d.claimedWei);
  return {
    id: d.id,
    creator: userRef(creator, creator.market),
    totalWei: decToBig(d.totalWei).toString(),
    claimedWei: decToBig(d.claimedWei).toString(),
    holders,
    claims,
    expiresAt: d.expiresAt.toISOString(),
    reclaimed: d.reclaimed,
    createdAt: d.createdAt.toISOString(),
    txHash: d.txHash,
    canReclaim: expiredForCreator && !d.reclaimed && left > 0n,
  };
}

/** The viewer's unclaimed allocations in live drops, across all their wallets. */
export async function claimableDrops(deps: Pick<AppDeps, 'prisma' | 'config'>, userId: string): Promise<ClaimableDropDTO[]> {
  const { prisma, config } = deps;
  if (!config.contracts.drops) return [];
  const addrs = await memberAddresses(prisma, userId);
  if (!addrs.length) return [];
  const allocations = await prisma.dropAllocation.findMany({ where: { address: { in: addrs }, claimTx: null } });
  if (!allocations.length) return [];
  const drops = await prisma.creatorDrop.findMany({
    where: { root: { in: [...new Set(allocations.map((a) => a.root))] }, reclaimed: false, expiresAt: { gt: new Date() } },
    orderBy: { id: 'desc' },
  });
  const creators = await membersByAddress(prisma, drops.map((d) => d.creator));
  const out: ClaimableDropDTO[] = [];
  for (const d of drops) {
    const creator = creators.get(d.creator);
    if (!creator) continue;
    for (const a of allocations.filter((x) => x.root === d.root)) {
      out.push({
        id: d.id,
        creator: userRef(creator, creator.market),
        address: a.address as Address,
        amountWei: decToBig(a.amountWei).toString(),
        proof: a.proof as `0x${string}`[],
        expiresAt: d.expiresAt.toISOString(),
        contract: config.contracts.drops as Address,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ referrals */

export async function referralsOverview(deps: Pick<AppDeps, 'prisma' | 'chain' | 'config'>, v: Viewer): Promise<ReferralsResponse> {
  const { prisma, chain, config } = deps;
  const refs = await prisma.referral.findMany({
    where: { inviterId: v.user.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { invitee: { include: { market: true, wallet: true, linkedWallets: true } } },
  });
  const inviteeAddrs = new Map<string, string>(); // address -> invitee id
  for (const r of refs) for (const a of [r.invitee.wallet?.address, ...r.invitee.linkedWallets.map((l) => l.address)]) if (a) inviteeAddrs.set(a, r.inviteeId);
  const dayStart = new Date(`${utcDayKey()}T00:00:00Z`);
  const live = refs.filter((r) => r.status === 'credited' && r.onchainTx && r.creditedAt);
  const since = live.length ? new Date(Math.min(...live.map((r) => r.creditedAt!.getTime()))) : new Date();
  const [volume, points, creditedToday, mine, traderFees, creatorFees] = await Promise.all([
    inviteeAddrs.size
      ? prisma.trade.groupBy({ by: ['trader'], where: { trader: { in: [...inviteeAddrs.keys()] } }, _sum: { baseWei: true } })
      : Promise.resolve([]),
    prisma.pointsLedger.aggregate({ where: { userId: v.user.id, kind: 'invite' }, _sum: { amount: true } }),
    prisma.referral.count({ where: { inviterId: v.user.id, status: 'credited', creditedAt: { gte: dayStart } } }),
    memberAddresses(prisma, v.user.id),
    // Trader half: the referrer is set onchain when the invite is credited, so only trades after that count.
    live.length
      ? prisma.trade.findMany({
          where: { trader: { in: [...inviteeAddrs.keys()].filter((a) => live.some((r) => r.inviteeId === inviteeAddrs.get(a))) }, ts: { gte: since } },
          select: { trader: true, ts: true, referralFeeWei: true },
        })
      : Promise.resolve([]),
    live.length
      ? prisma.trade.findMany({
          where: { market: { userId: { in: live.map((r) => r.inviteeId) } }, ts: { gte: since } },
          select: { ts: true, referralFeeWei: true, market: { select: { userId: true } } },
        })
      : Promise.resolve([]),
  ]);
  const creditedAt = new Map(live.map((r) => [r.inviteeId, r.creditedAt!.getTime()]));
  let earned = 0n;
  for (const t of traderFees) if (t.ts.getTime() >= (creditedAt.get(inviteeAddrs.get(t.trader)!) ?? Infinity)) earned += decToBig(t.referralFeeWei) / 2n;
  for (const t of creatorFees) {
    if (t.ts.getTime() < (creditedAt.get(t.market.userId) ?? Infinity)) continue;
    const fee = decToBig(t.referralFeeWei);
    earned += fee - fee / 2n;
  }
  const pending = (await Promise.all(mine.map((a) => chain.claimable(a as Address, []).then((c) => c.referral).catch(() => 0n)))).reduce((s, x) => s + x, 0n);
  const vol = new Map<string, bigint>();
  for (const g of volume) {
    const id = inviteeAddrs.get(g.trader)!;
    vol.set(id, (vol.get(id) ?? 0n) + decToBig(g._sum.baseWei ?? dec(0)));
  }
  return {
    link: `${config.webUrl}/i/${v.user.handle}`,
    invited: refs.length,
    credited: refs.filter((r) => r.status === 'credited').length,
    pending: refs.filter((r) => r.status === 'pending').length,
    points: points._sum.amount ?? 0,
    dailyCap: INVITES_CREDITED_PER_DAY,
    creditedToday,
    pointsPerInvite: INVITE_POINTS,
    referralPendingWei: pending.toString(),
    referralEarnedWei: earned.toString(),
    rows: refs.map((r) => ({
      ...userRef(r.invitee, r.invitee.market),
      status: r.status,
      reason: r.reason,
      joinedAt: r.invitee.joinedAt?.toISOString() ?? null,
      creditedAt: r.creditedAt?.toISOString() ?? null,
      volumeWei: (vol.get(r.inviteeId) ?? 0n).toString(),
    })),
  };
}
