import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { quoteWei, weiToEth } from '@sway/curve';
import { heldPoints } from '@sway/scoring';
import { prisma, dec, decToBig, ONE_OFF_DAY, type User } from '@sway/db';
import { loadConfig } from '../src/config';
import { makeClients, type Clients } from '../src/clients';
import { recountPoints } from '../src/jobs/points';
import { simulatedBattleReader, tickBattles } from '../src/jobs/battles';
import { creditReferrals } from '../src/jobs/referrals';
import { completeTask, reopenStalePending, runVerifyTask } from '../src/jobs/xjobs';
import { takeSnapshot } from '../src/jobs/genesis';

let c: Clients;
let n = 0;
const DAY = 86400e3;

async function member(extra: Partial<User> = {}, wallet = true) {
  n++;
  const handle = `jobs_${n}_${Date.now() % 100000}`;
  return prisma.user.create({
    data: {
      xId: String(7_000_000 + n + Math.floor(Math.random() * 1e6)), handle, name: handle, joinedAt: new Date(), memberNo: 50_000 + n,
      followers: 1000, verified: true, score: 50, xCreatedAt: new Date(Date.now() - 400 * DAY),
      ...extra,
      wallet: wallet ? { create: { address: `0x${(0xabc000 + n).toString(16).padStart(40, '0')}`, kind: 'embedded' } } : undefined,
    } as never,
    include: { wallet: true },
  });
}

const sumLedger = async (userId: string) => (await prisma.pointsLedger.aggregate({ where: { userId }, _sum: { amount: true } }))._sum.amount ?? 0;

beforeAll(() => {
  Object.assign(process.env, { CHAIN_ID: '31338', SWAY_KEYS_ADDRESS: '', OPERATOR_PRIVATE_KEY: '', X_BEARER_TOKEN: '', DEV_AUTH: '1' });
  c = makeClients(loadConfig(), new Redis('redis://localhost:6379/15'));
});

afterAll(async () => {
  await c.redis.quit();
  await prisma.$disconnect();
});

describe('points engine', () => {
  it('counts held keys at sell value, excludes your own market, updates the tier', async () => {
    const creator = await member();
    const holder = await member();
    const market = await prisma.keyMarket.create({
      data: { subject: creator.wallet!.address, userId: creator.id, xId: creator.xId, opened: true, supplyUnits: 1_000n },
    });
    await prisma.holding.createMany({
      data: [
        { marketId: market.id, address: creator.wallet!.address, units: 100n },
        { marketId: market.id, address: holder.wallet!.address, units: 900n },
      ],
    });
    await prisma.pointsLedger.create({ data: { userId: holder.id, kind: 'task', amount: 60_000, ref: 'test:jobs' } });
    await recountPoints(c);
    const h = await prisma.user.findUniqueOrThrow({ where: { id: holder.id } });
    expect(h.heldPoints).toBe(heldPoints(weiToEth(quoteWei(1_000n, 'sell', 900n).total)));
    expect(h.ledgerPoints).toBe(60_000);
    expect(h.tier).toBe('Voice');
    const cr = await prisma.user.findUniqueOrThrow({ where: { id: creator.id } });
    expect(cr.heldPoints).toBe(0);
  });
});

describe('battles', () => {
  it('settles a read battle: winner takes both stakes minus 5%, backers split the losing pool', async () => {
    const a = await member({ followers: 10_000 });
    const b = await member({ followers: 10_000 });
    const backA = await member();
    const backB = await member();
    const endsAt = new Date(Date.now() - 7 * 3600e3);
    const battle = await prisma.battle.create({
      data: { aId: a.id, bId: b.id, theme: 'test', stake: 1000, status: 'live', acceptedAt: new Date(endsAt.getTime() - DAY), endsAt, expiresAt: endsAt, erA: 0.05, erB: 0.01 },
    });
    await prisma.battleBacking.createMany({ data: [{ battleId: battle.id, userId: backA.id, side: 'a', amount: 300 }, { battleId: battle.id, userId: backB.id, side: 'b', amount: 1000 }] });
    const r1 = await tickBattles(c, simulatedBattleReader);
    expect(r1.closed).toBeGreaterThanOrEqual(1);
    expect(r1.settled).toBeGreaterThanOrEqual(1);
    const s = await prisma.battle.findUniqueOrThrow({ where: { id: battle.id } });
    expect(s.status).toBe('settled');
    expect(s.winner).toBe('a');
    expect(await sumLedger(a.id)).toBe(1900);
    expect(await sumLedger(b.id)).toBe(0);
    expect(await sumLedger(backA.id)).toBe(300 + 950);
    expect(await prisma.notification.count({ where: { userId: a.id, type: 'battle' } })).toBe(1);
    // idempotent
    await tickBattles(c, simulatedBattleReader);
    expect(await sumLedger(a.id)).toBe(1900);
  });

  it('expires unanswered challenges and refunds the stake', async () => {
    const a = await member();
    const battle = await prisma.battle.create({ data: { aId: a.id, theme: 'open', stake: 500, status: 'pending', expiresAt: new Date(Date.now() - 1000) } });
    await prisma.pointsLedger.create({ data: { userId: a.id, kind: 'battle_stake', amount: -500, ref: `battle:${battle.id}:stake` } });
    await tickBattles(c, simulatedBattleReader);
    expect((await prisma.battle.findUniqueOrThrow({ where: { id: battle.id } })).status).toBe('expired');
    expect(await sumLedger(a.id)).toBe(0);
  });
});

describe('referrals', () => {
  it('credits a verified invite once (+500 / +100) and skips unqualified ones', async () => {
    const inviter = await member();
    const good = await member({ followers: 120 });
    const young = await member({ xCreatedAt: new Date(Date.now() - 5 * DAY) });
    await prisma.referral.createMany({ data: [{ inviterId: inviter.id, inviteeId: good.id }, { inviterId: inviter.id, inviteeId: young.id }] });
    await creditReferrals(c);
    await creditReferrals(c);
    expect(await sumLedger(inviter.id)).toBe(500);
    expect(await sumLedger(good.id)).toBe(100);
    expect((await prisma.referral.findUniqueOrThrow({ where: { inviteeId: young.id } })).status).toBe('pending');
  });
});

describe('tasks', () => {
  it('completes a task once, with one ledger row and one notification', async () => {
    const u = await member();
    await completeTask(c, { userId: u.id, taskId: 'follow', day: '1970-01-01' }, 'verified');
    await completeTask(c, { userId: u.id, taskId: 'follow', day: '1970-01-01' }, 'verified');
    expect(await sumLedger(u.id)).toBe(1000);
    const tc = await prisma.taskCompletion.findUniqueOrThrow({ where: { userId_taskId_day: { userId: u.id, taskId: 'follow', day: ONE_OFF_DAY } } });
    expect(tc.status).toBe('verified');
    expect(await prisma.notification.count({ where: { userId: u.id, type: 'points' } })).toBe(1);
  });

  it('never leaves a task pending when X can\'t be read: trusts small ones, hands the rest back', async () => {
    // Production without an app token: no dev shortcut and no X read.
    const prod = { ...c, cfg: { ...c.cfg, devAuth: false, xBearer: '' } } as Clients;
    const u = await member();
    for (const taskId of ['follow', 'card'] as const)
      await prisma.taskCompletion.create({ data: { userId: u.id, taskId, day: ONE_OFF_DAY, status: 'pending', attempts: 1 } });
    expect(await runVerifyTask(prod, { userId: u.id, taskId: 'follow', day: '1970-01-01' })).toBe('trusted');
    expect(await runVerifyTask(prod, { userId: u.id, taskId: 'card', day: '1970-01-01' })).toBe('unsupported');
    const rows = await prisma.taskCompletion.findMany({ where: { userId: u.id }, select: { taskId: true, status: true } });
    // 'card' is open again (no row), so the member sees Verify instead of a spinner.
    expect(rows).toEqual([{ taskId: 'follow', status: 'trusted' }]);
    expect(await sumLedger(u.id)).toBe(1000);
    const notes = await prisma.notification.findMany({ where: { userId: u.id }, select: { body: true } });
    expect(JSON.stringify(notes)).toContain('Press Verify again later');
  });

  it('hands back tasks stuck in pending from before (no job left to finish them)', async () => {
    const u = await member();
    const old = new Date(Date.now() - 2 * 3600e3);
    await prisma.taskCompletion.create({ data: { userId: u.id, taskId: 'follow', day: ONE_OFF_DAY, status: 'pending', attempts: 1, checkedAt: old } });
    await prisma.taskCompletion.create({ data: { userId: u.id, taskId: 'repost', day: ONE_OFF_DAY, status: 'pending', attempts: 1, checkedAt: new Date() } });
    expect(await reopenStalePending(c)).toBeGreaterThanOrEqual(1);
    const rows = await prisma.taskCompletion.findMany({ where: { userId: u.id }, select: { taskId: true } });
    expect(rows).toEqual([{ taskId: 'repost' }]); // the fresh one is still being checked
  });
});

describe('genesis snapshot', () => {
  it('ranks eligible members and splits the whole pool', async () => {
    const takenAt = new Date('2026-10-27T15:00:00Z');
    const r = await takeSnapshot(c, takenAt);
    expect(r).not.toBeNull();
    const snap = await prisma.genesisSnapshot.findUniqueOrThrow({ where: { takenAt }, include: { entries: { orderBy: { rank: 'asc' } } } });
    expect(snap.entries.length).toBeGreaterThan(0);
    const total = snap.entries.reduce((s, e) => s + decToBig(e.units), 0n);
    expect(total).toBe(decToBig(snap.poolUnits));
    for (let i = 1; i < snap.entries.length; i++) expect(snap.entries[i]!.points).toBeLessThanOrEqual(snap.entries[i - 1]!.points);
    expect(await takeSnapshot(c, takenAt)).toBeNull();
    expect(dec(1).toString()).toBe('1');
  });
});
