import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ONE_OFF_DAY, utcDay } from '@sway/db';
import type { TaskDTO, TasksResponse } from '@sway/shared';
import { randomBytes } from 'node:crypto';
import { appendLedger } from '../src/services/points';
import { login, makeApp, member, openMarketRow, prisma, resetState, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
beforeEach(async () => {
  await resetState(ctx.redis);
  ctx.jobs.jobs.length = 0;
});
afterAll(() => ctx.close());

const tasks = (cookie?: string) => ctx.app.inject({ url: '/api/tasks', headers: cookie ? { cookie } : {} });
const verify = (cookie: string, id: string) =>
  ctx.app.inject({ method: 'POST', url: `/api/tasks/${id}/verify`, headers: { cookie } });
const skip = (cookie: string, id: string) =>
  ctx.app.inject({ method: 'POST', url: `/api/tasks/${id}/skip`, headers: { cookie } });
const status = (r: TasksResponse) => Object.fromEntries(r.tasks.map((t) => [t.id, t.status]));

describe('tasks', () => {
  it('unlocks the Join checklist in order and keeps daily tasks open', async () => {
    const { cookie } = await login(ctx, 'tasker');
    const t0 = (await tasks(cookie)).json<TasksResponse>();
    expect(status(t0)).toEqual({
      follow: 'open',
      repost: 'locked',
      tg: 'locked',
      card: 'locked',
      daily: 'open',
      buykey: 'open',
    });
    expect(t0.inviteLink).toBe('http://localhost:3000/i/tasker');
    // Each task says where it's done: Follow opens @swaydotfamily on X, Post a #SwayDaily draft.
    const by = Object.fromEntries(t0.tasks.map((t) => [t.id, t]));
    expect(by.follow).toMatchObject({ action: 'Follow', actionUrl: 'https://x.com/intent/follow?screen_name=swaydotfamily' });
    expect(by.daily!.actionUrl).toContain('SwayDaily');
    expect(by.card).toMatchObject({ action: 'Share card', actionUrl: null });
    expect(by.buykey).toMatchObject({ action: null, actionUrl: null });

    const locked = await verify(cookie, 'card');
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toBe('task_locked');

    expect((await verify(cookie, 'follow')).json<TaskDTO>().status).toBe('verified');
    expect(status((await tasks(cookie)).json<TasksResponse>())).toMatchObject({
      follow: 'verified',
      repost: 'open',
      tg: 'locked',
    });
    await verify(cookie, 'repost');
    expect((await skip(cookie, 'card')).json().error).toBe('not_skippable');
    expect((await skip(cookie, 'tg')).json<TaskDTO>().status).toBe('skipped');
    const t1 = (await tasks(cookie)).json<TasksResponse>();
    expect(status(t1)).toMatchObject({ follow: 'verified', repost: 'verified', tg: 'skipped', card: 'open' });
  });

  it('awards points once per task-day through the ledger and notifies', async () => {
    const { cookie, user } = await login(ctx, 'earner');
    const before = (await tasks(cookie)).json<TasksResponse>().points;
    await verify(cookie, 'follow');
    await verify(cookie, 'follow');
    await verify(cookie, 'daily');
    const ledger = await prisma.pointsLedger.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
    const day = utcDay().toISOString().slice(0, 10);
    expect(ledger.map((l) => [l.kind, l.amount, l.ref])).toEqual([
      ['task', 1000, 'task:follow:1970-01-01'],
      ['task', 750, `task:daily:${day}`],
    ]);
    // The unique index makes a replayed ledger write a no-op (e.g. the worker verifying the same task).
    expect(
      await appendLedger(prisma, {
        userId: user.id,
        kind: 'task',
        amount: 1000,
        ref: 'task:follow:1970-01-01',
      }),
    ).toBe(false);
    expect(await prisma.pointsLedger.count({ where: { userId: user.id } })).toBe(2);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).ledgerPoints).toBe(1750);

    const after = (await tasks(cookie)).json<TasksResponse>().points;
    expect(after.total).toBe(before.total + 1750);
    expect(after.ledger).toBe(1750);
    expect(after.earned).toBe(1750);
    const notes = await prisma.notification.findMany({ where: { userId: user.id, type: 'points' } });
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.body)).toContainEqual([
      { t: 'Task verified on X: ' },
      { t: 'Follow @swaydotfamily on X', b: true },
      { t: '. +1,000 points.' },
    ]);
    const tc = await prisma.taskCompletion.findUniqueOrThrow({
      where: { userId_taskId_day: { userId: user.id, taskId: 'follow', day: ONE_OFF_DAY } },
    });
    expect(tc).toMatchObject({ status: 'verified', points: 1000 });
  });

  it('Telegram is trusted (it cannot be read from X) and only skippable tasks skip for 0 points', async () => {
    const { cookie, user } = await login(ctx, 'tguser');
    await verify(cookie, 'follow');
    await verify(cookie, 'repost');
    expect((await verify(cookie, 'tg')).json<TaskDTO>().status).toBe('trusted');
    expect(await prisma.pointsLedger.count({ where: { userId: user.id, ref: 'task:tg:1970-01-01' } })).toBe(
      1,
    );
  });

  it('without an X token (or with the budget spent) the task goes pending and a verify-task job is queued', async () => {
    const { user } = await login(ctx, 'realuser');
    // A non-dev session with no X token (like a member whose token expired), written the way createSession does.
    const sid = randomBytes(16).toString('base64url');
    await ctx.redis.set(`sess:${sid}`, JSON.stringify({ userId: user.id, createdAt: Date.now() }), 'EX', 600);
    const cookie = `sway_sid=${ctx.app.signCookie(sid)}`;
    const r = await verify(cookie, 'follow');
    expect(r.statusCode).toBe(200);
    expect(r.json<TaskDTO>().status).toBe('pending');
    expect(ctx.jobs.jobs).toEqual([{ userId: user.id, taskId: 'follow', day: '1970-01-01' }]);
    const t = (await tasks(cookie)).json<TasksResponse>();
    expect(status(t)).toMatchObject({ follow: 'pending', repost: 'locked' });
    expect(await prisma.pointsLedger.count({ where: { userId: user.id } })).toBe(0);
  });

  it('completes the auto task when the member holds a key they did not mint', async () => {
    const me = await member(ctx, 'autouser');
    await openMarketRow(me);
    const other = await member(ctx, 'mintedby');
    const om = await openMarketRow(other);
    expect((await verify(me.cookie, 'buykey')).json().error).toBe('not_verified');
    await prisma.holding.create({ data: { marketId: om.id, address: me.address, units: 100n } });
    const t = (await tasks(me.cookie)).json<TasksResponse>();
    expect(status(t).buykey).toBe('verified');
    expect(
      await prisma.pointsLedger.count({ where: { userId: me.user.id, ref: 'task:buykey:1970-01-01' } }),
    ).toBe(1);
  });

  it('guests get the task list without points', async () => {
    const t = (await tasks()).json<TasksResponse>();
    expect(t.points.total).toBe(0);
    expect(t.inviteLink).toBe('');
    expect(t.tasks).toHaveLength(6);
  });
});

describe('X-backed verification', () => {
  const xSession = async (x: TestCtx, userId: string) => {
    const sid = randomBytes(16).toString('base64url');
    await x.redis.set(
      `sess:${sid}`,
      JSON.stringify({
        userId,
        x: { accessToken: 'user-token', expiresAt: Date.now() + 3600e3 },
        createdAt: Date.now(),
      }),
      'EX',
      600,
    );
    return `sway_sid=${x.app.signCookie(sid)}`;
  };
  const ok = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });

  it('verifies synchronously with the session token through @sway/x', async () => {
    const seen: string[] = [];
    const xFetch = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      seen.push(u.pathname);
      if (u.pathname === '/2/users/by/username/swaydotfamily')
        return ok({ data: { id: '4663', username: 'swaydotfamily', name: 'Sway' } });
      if (u.pathname.endsWith('/following')) return ok({ data: [{ id: '1' }, { id: '4663' }] });
      return ok({ data: [] });
    }) as typeof fetch;
    const x = await makeApp({ xFetch });
    try {
      const { user } = await login(x, 'xverified');
      const cookie = await xSession(x, user.id);
      const r = await verify2(x, cookie, 'follow');
      expect(r.json<TaskDTO>().status).toBe('verified');
      expect(seen).toEqual(['/2/users/by/username/swaydotfamily', `/2/users/${user.xId}/following`]);
      // Not found on X: 422, the task stays open.
      const d = await verify2(x, cookie, 'daily');
      expect(d.statusCode).toBe(422);
      expect(d.json().error).toBe('not_verified');
      expect(
        status((await x.app.inject({ url: '/api/tasks', headers: { cookie } })).json<TasksResponse>()).daily,
      ).toBe('open');
    } finally {
      await x.close();
    }
  });

  it('trusts small tasks at once when the X API plan refuses the read, and says so for bigger ones', async () => {
    const xFetch = (async () =>
      ok({ title: 'Client Forbidden', reason: 'client-not-enrolled' }, 403)) as typeof fetch;
    const x = await makeApp({ xFetch });
    try {
      const { user } = await login(x, 'xplan');
      const cookie = await xSession(x, user.id);
      const r = await verify2(x, cookie, 'follow');
      expect(r.json<TaskDTO>().status).toBe('trusted');
      expect(x.jobs.jobs).toEqual([]); // nothing left for the worker
      const sum = await prisma.pointsLedger.aggregate({ where: { userId: user.id, kind: 'task' }, _sum: { amount: true } });
      expect(sum._sum.amount).toBe(1000);
      // Unlock the card task, worth more than the trust limit: a clear error, no spinner.
      for (const taskId of ['repost', 'tg'])
        await prisma.taskCompletion.create({ data: { userId: user.id, taskId, day: new Date(0), status: 'verified', points: 0 } });
      const card = await verify2(x, cookie, 'card');
      expect(card.statusCode).toBe(422);
      expect(card.json().error).toBe('x_unavailable');
    } finally {
      await x.close();
    }
  });

  it('queues the job when the X budget is exhausted', async () => {
    const xFetch = (async () =>
      ok({}, 429, { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900) })) as typeof fetch;
    const x = await makeApp({ xFetch });
    try {
      const { user } = await login(x, 'xbudget');
      const cookie = await xSession(x, user.id);
      const r = await verify2(x, cookie, 'follow');
      expect(r.statusCode).toBe(200);
      expect(r.json<TaskDTO>().status).toBe('pending');
      expect(x.jobs.jobs).toEqual([{ userId: user.id, taskId: 'follow', day: '1970-01-01' }]);
    } finally {
      await x.close();
    }
  });
});

const verify2 = (x: TestCtx, cookie: string, id: string) =>
  x.app.inject({ method: 'POST', url: `/api/tasks/${id}/verify`, headers: { cookie } });
