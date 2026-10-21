import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  BattleDTO,
  BattlesResponse,
  GenesisResponse,
  LaunchpadResponse,
  LeaderboardResponse,
} from '@sway/shared';
import { genesisSharePercent } from '@sway/scoring';
import { appendLedger } from '../src/services/points';
import { login, makeApp, member, openMarketRow, prisma, resetState, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
beforeEach(() => resetState(ctx.redis));
afterAll(() => ctx.close());

const postJ = (url: string, cookie: string, payload?: unknown) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as Record<string, unknown> });
const grant = (userId: string, amount: number, ref = `test:${Math.random()}`) =>
  appendLedger(prisma, { userId, kind: 'task', amount, ref });
const challenge = (
  cookie: string,
  opponent: string | undefined,
  stake = 0,
  theme = 'One chart that explains this cycle',
) => postJ('/api/battles', cookie, { opponent, theme, stake });
const ledgerSum = async (userId: string) =>
  (await prisma.pointsLedger.aggregate({ where: { userId }, _sum: { amount: true } }))._sum.amount ?? 0;

describe('battles', () => {
  it('stakes only earned points, up to what both sides have earned, debited through the ledger', async () => {
    const a = await login(ctx, 'makotrades');
    const b = await login(ctx, 'vexcapital');
    await grant(a.user.id, 5000);
    await grant(b.user.id, 2000);
    const tooHigh = await challenge(a.cookie, 'vexcapital', 2100);
    expect(tooHigh.statusCode).toBe(400);
    expect(tooHigh.json().error).toBe('stake_too_high');
    const ok = await challenge(a.cookie, '@VexCapital', 2000);
    expect(ok.statusCode).toBe(200);
    const battle = ok.json<BattleDTO>();
    expect(battle).toMatchObject({
      status: 'pending',
      stake: 2000,
      tag: '#SwayBattle',
      a: { handle: 'makotrades' },
      b: { handle: 'vexcapital' },
      canRespond: false,
    });
    expect(await ledgerSum(a.user.id)).toBe(3000);
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: b.user.id, type: 'battle' } });
    expect(JSON.stringify(n.body)).toContain('challenged you to a battle for 2,000 pts');
    // The challenged side sees canRespond.
    const list = (
      await ctx.app.inject({ url: '/api/battles', headers: { cookie: b.cookie } })
    ).json<BattlesResponse>();
    expect(list.treasuryFeePct).toBe(5);
    expect(list.battles.find((x) => x.id === battle.id)!.canRespond).toBe(true);
  });

  it('rejects self, non-members, a fourth active battle and rematches within 7 days', async () => {
    const a = await login(ctx, 'fighter');
    expect((await challenge(a.cookie, 'fighter')).json().error).toBe('self');
    expect((await challenge(a.cookie, 'nobody')).statusCode).toBe(404);
    for (const h of ['opp1', 'opp2', 'opp3']) await login(ctx, h);
    await login(ctx, 'opp4');
    expect((await challenge(a.cookie, 'opp1')).statusCode).toBe(200);
    expect((await challenge(a.cookie, 'opp1')).json().error).toBe('rematch_cooldown');
    expect((await challenge(a.cookie, 'opp2')).statusCode).toBe(200);
    expect((await challenge(a.cookie, 'opp3')).statusCode).toBe(200);
    expect((await challenge(a.cookie, 'opp4')).json().error).toBe('battle_limit');
    // Theme is validated.
    const b = await login(ctx, 'freshfighter');
    expect((await postJ('/api/battles', b.cookie, { theme: 'x', stake: 0 })).statusCode).toBe(400);
    // Expired challenges free a slot.
    await prisma.battle.updateMany({
      where: { aId: a.user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await challenge(a.cookie, 'opp4')).statusCode).toBe(200);
  });

  it('accept starts the 24h window and debits the other stake; decline refunds', async () => {
    const a = await login(ctx, 'challenger');
    const b = await login(ctx, 'challenged');
    const c = await login(ctx, 'outsider');
    await grant(a.user.id, 1000);
    await grant(b.user.id, 500);
    const one = (await challenge(a.cookie, 'challenged', 400)).json<BattleDTO>();
    expect((await postJ(`/api/battles/${one.id}/respond`, c.cookie, { accept: true })).json().error).toBe(
      'not_yours',
    );
    expect((await postJ(`/api/battles/${one.id}/respond`, a.cookie, { accept: true })).json().error).toBe(
      'self',
    );
    const acc = await postJ(`/api/battles/${one.id}/respond`, b.cookie, { accept: true });
    expect(acc.statusCode).toBe(200);
    const live = acc.json<BattleDTO>();
    expect(live.status).toBe('live');
    expect(new Date(live.endsAt!).getTime() - Date.now()).toBeGreaterThan(23.9 * 3600e3);
    expect(await ledgerSum(b.user.id)).toBe(100);
    expect((await postJ(`/api/battles/${one.id}/respond`, b.cookie, { accept: false })).json().error).toBe(
      'not_pending',
    );

    // Decline refunds the challenger's stake through a new ledger row.
    await grant(c.user.id, 1000);
    const a2 = await login(ctx, 'challenger2');
    await grant(a2.user.id, 800);
    const two = (await challenge(a2.cookie, 'outsider', 300)).json<BattleDTO>();
    expect(await ledgerSum(a2.user.id)).toBe(500);
    const dec = await postJ(`/api/battles/${two.id}/respond`, c.cookie, { accept: false });
    expect(dec.json<BattleDTO>().status).toBe('declined');
    expect(await ledgerSum(a2.user.id)).toBe(800);
    expect(
      (await prisma.pointsLedger.findMany({ where: { userId: a2.user.id, kind: 'battle_stake' } }))
        .map((l) => l.amount)
        .sort(),
    ).toEqual([-300, 300]);
  });

  it('open challenges can be accepted by anyone with enough earned points', async () => {
    const a = await login(ctx, 'opener');
    const b = await login(ctx, 'taker');
    await grant(a.user.id, 600);
    const open = (await challenge(a.cookie, undefined, 500)).json<BattleDTO>();
    expect(open.b).toBeNull();
    expect((await postJ(`/api/battles/${open.id}/respond`, b.cookie, { accept: true })).json().error).toBe(
      'not_enough_points',
    );
    await grant(b.user.id, 500);
    const r = (await postJ(`/api/battles/${open.id}/respond`, b.cookie, { accept: true })).json<BattleDTO>();
    expect(r).toMatchObject({ status: 'live', b: { handle: 'taker' } });
  });

  it('backing: ≥ 100 points, once per battle, never by fighters, not after the window', async () => {
    const a = await login(ctx, 'sidea');
    const b = await login(ctx, 'sideb');
    const fan = await login(ctx, 'spectator');
    await grant(fan.user.id, 1000);
    const bt = (await challenge(a.cookie, 'sideb')).json<BattleDTO>();
    await postJ(`/api/battles/${bt.id}/respond`, b.cookie, { accept: true });
    expect(
      (await postJ(`/api/battles/${bt.id}/back`, fan.cookie, { side: 'a', amount: 99 })).statusCode,
    ).toBe(400);
    expect(
      (await postJ(`/api/battles/${bt.id}/back`, a.cookie, { side: 'a', amount: 100 })).json().error,
    ).toBe('fighter');
    expect(
      (await postJ(`/api/battles/${bt.id}/back`, fan.cookie, { side: 'b', amount: 5000 })).json().error,
    ).toBe('not_enough_points');
    const ok = await postJ(`/api/battles/${bt.id}/back`, fan.cookie, { side: 'b', amount: 500 });
    expect(ok.json<BattleDTO>()).toMatchObject({ poolB: 500, myBacking: { side: 'b', amount: 500 } });
    expect(await ledgerSum(fan.user.id)).toBe(500);
    expect(
      (await postJ(`/api/battles/${bt.id}/back`, fan.cookie, { side: 'a', amount: 100 })).json().error,
    ).toBe('already_backed');
    const late = await login(ctx, 'latecomer');
    await grant(late.user.id, 1000);
    await prisma.battle.update({ where: { id: bt.id }, data: { endsAt: new Date(Date.now() - 1000) } });
    expect(
      (await postJ(`/api/battles/${bt.id}/back`, late.cookie, { side: 'a', amount: 100 })).json().error,
    ).toBe('window_closed');
  });
});

describe('leaderboard, genesis, launchpad', () => {
  it('ranks members by points (score + ledger + held) and includes the viewer’s row', async () => {
    const users = [];
    for (const [h, extra] of [
      ['lb1', 9000],
      ['lb2', 50000],
      ['lb3', 0],
      ['lb4', 120000],
    ] as const) {
      const { user, cookie } = await login(ctx, h, 1000);
      await prisma.user.update({ where: { id: user.id }, data: { score: 50 } });
      if (extra) await grant(user.id, extra);
      users.push({ user, cookie });
    }
    await prisma.user.update({ where: { id: users[2]!.user.id }, data: { heldPoints: 30000 } });
    await prisma.user.create({
      data: {
        xId: '1',
        handle: 'swaydotfamily',
        name: 'Sway',
        official: true,
        joinedAt: new Date(),
        memberNo: 999,
        score: 100,
      },
    });
    const res = (
      await ctx.app.inject({ url: '/api/leaderboard?tab=points', headers: { cookie: users[0]!.cookie } })
    ).json<LeaderboardResponse>();
    expect(res.rows.map((r) => [r.user.handle, r.points, r.rank])).toEqual([
      ['lb4', 125000, 1],
      ['lb2', 55000, 2],
      ['lb3', 35000, 3],
      ['lb1', 14000, 4],
    ]);
    expect(res.rows[0]!.tier).toBe('Echo');
    expect(res.me).toMatchObject({ rank: 4, points: 14000, me: true });
    const me = (await ctx.app.inject({ url: '/api/me', headers: { cookie: users[0]!.cookie } })).json();
    expect(me.points).toMatchObject({
      rank: 4,
      total: 14000,
      tier: 'Murmur',
      nextTier: 'Voice',
      toNext: 36000,
    });

    const stakers = (await ctx.app.inject('/api/leaderboard?tab=stakers')).json<LeaderboardResponse>();
    expect(stakers.me).toBeNull();
    expect(stakers.rows).toHaveLength(4);
  });

  it('ranks creators by fees and fighters by battle points won', async () => {
    const a = await member(ctx, 'feeking');
    const b = await member(ctx, 'feeless');
    const ma = await openMarketRow(a);
    await openMarketRow(b);
    await prisma.keyMarket.update({ where: { id: ma.id }, data: { creatorFeesWei: '5000000000000000' } });
    await prisma.battle.create({
      data: {
        aId: b.user.id,
        bId: a.user.id,
        theme: 't',
        stake: 1000,
        status: 'settled',
        expiresAt: new Date(),
        settledAt: new Date(),
        winner: 'a',
      },
    });
    await appendLedger(prisma, { userId: b.user.id, kind: 'battle_payout', amount: 1900, ref: 'payout:x' });
    const cr = (await ctx.app.inject('/api/leaderboard?tab=creators')).json<LeaderboardResponse>();
    expect(cr.rows.map((r) => [r.user.handle, r.feesWei])).toEqual([
      ['feeking', '5000000000000000'],
      ['feeless', '0'],
    ]);
    const fi = (await ctx.app.inject('/api/leaderboard?tab=fighters')).json<LeaderboardResponse>();
    expect(fi.rows.map((r) => [r.user.handle, r.won])).toEqual([
      ['feeless', 900],
      ['feeking', 0],
    ]);
  });

  it('Genesis: live ranking among eligible members with 1/√rank shares', async () => {
    const e1 = await member(ctx, 'gen1');
    const e2 = await member(ctx, 'gen2');
    const noTask = await member(ctx, 'gen3');
    for (const m of [e1, e2])
      await prisma.taskCompletion.create({
        data: {
          userId: m.user.id,
          taskId: 'follow',
          day: new Date('1970-01-01'),
          status: 'verified',
          points: 1000,
        },
      });
    await grant(e2.user.id, 100000);
    const g = (
      await ctx.app.inject({ url: '/api/genesis', headers: { cookie: e1.cookie } })
    ).json<GenesisResponse>();
    expect(g.snapshotAt).toBe('2026-10-27T15:00:00.000Z');
    expect(g.frozen).toBe(false);
    expect(g.top.map((r) => [r.rank, r.user.handle])).toEqual([
      [1, 'gen2'],
      [2, 'gen1'],
    ]);
    expect(g.top[0]!.sharePct).toBeCloseTo(genesisSharePercent(1), 10);
    expect(g.split.map((s) => s.rank)).toEqual([1, 10, 50, 100, 250, 500]);
    expect(g.me).toMatchObject({ rank: 2, inCut: true, toCut: 0 });
    expect(g.me!.sharePct).toBeCloseTo(genesisSharePercent(2), 10);
    const out = (
      await ctx.app.inject({ url: '/api/genesis', headers: { cookie: noTask.cookie } })
    ).json<GenesisResponse>();
    expect(out.me).toMatchObject({ inCut: false, sharePct: 0 });
  });

  it('Launchpad symbol and start cap', async () => {
    const { cookie, user } = await login(ctx, 'kenji_onchain99');
    const r = (
      await ctx.app.inject({ url: '/api/launchpad', headers: { cookie } })
    ).json<LaunchpadResponse>();
    expect(r).toEqual({
      symbol: '$KENJIONCHA', // display name too long for a ticker: the handle's first ten
      score: user.score,
      startCapUsd: 2000 + user.score * 60,
      launched: false,
      tokenAddress: null,
    });
    expect((await ctx.app.inject('/api/launchpad')).json<LaunchpadResponse>().symbol).toBe('$YOU');
  });
});
