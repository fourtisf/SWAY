/**
 * X API jobs on the `x-jobs` BullMQ queue (the contract with apps/api):
 *   verify-task   { userId, taskId, day: 'YYYY-MM-DD' }   task left 'pending' by the API
 *   refresh-score { userId }                              rescore a member from public X data
 * plus a scheduled sweep that rescores the stalest members within the X budget.
 * When X can't answer (budget spent, or the endpoint off our API plan), low-value tasks (≤ 1,000 pts) are
 * marked 'trusted' and re-checked later (brief §12); the rest go back to Verify with a note. A check that finds
 * nothing also hands the task back, so a task never sits in 'pending' for good.
 */
import { TASK_TRUST_MAX_POINTS, taskById, type TaskId } from '@sway/shared';
import { checkTaskOnX, getRecentPosts, getUserById, isXBudgetExceeded, isXUnavailable, scoreXAccount } from '@sway/x';
import type { Clients } from '../clients';
import { notify } from '../notify';
import { appXContext } from '../xctx';

export const X_QUEUE = 'x-jobs';
export const TRUST_MAX_POINTS = TASK_TRUST_MAX_POINTS;

export interface VerifyTaskJob {
  userId: string;
  taskId: TaskId;
  day: string;
}

const dayDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`);

/** Marks a task verified (idempotent), appends its points and notifies. Shared rule: ref = task:<id>:<day>. */
export async function completeTask(c: Clients, job: VerifyTaskJob, status: 'verified' | 'trusted'): Promise<void> {
  const def = taskById(job.taskId);
  if (!def) return;
  const day = dayDate(job.day);
  const ref = `task:${job.taskId}:${job.day.slice(0, 10)}`;
  const first = await c.prisma.$transaction(async (tx) => {
    const tc = await tx.taskCompletion.findUnique({ where: { userId_taskId_day: { userId: job.userId, taskId: job.taskId, day } } });
    if (tc && (tc.status === 'verified' || (tc.status === 'trusted' && status === 'trusted'))) return false;
    await tx.taskCompletion.upsert({
      where: { userId_taskId_day: { userId: job.userId, taskId: job.taskId, day } },
      update: { status, points: def.pts, verifiedAt: new Date(), checkedAt: new Date(), attempts: { increment: 1 } },
      create: { userId: job.userId, taskId: job.taskId, day, status, points: def.pts, verifiedAt: new Date(), checkedAt: new Date(), attempts: 1 },
    });
    const r = await tx.pointsLedger.createMany({ data: [{ userId: job.userId, kind: 'task', amount: def.pts, ref }], skipDuplicates: true });
    return r.count > 0;
  });
  if (first) {
    await notify(c, {
      userId: job.userId, type: 'points', link: '/tasks',
      body: [{ t: 'Task verified on X: ' }, { t: def.title, b: true }, { t: `. +${def.pts.toLocaleString('en-US')} points.` }],
    });
  }
}

/**
 * Hands a 'pending' task back to the member (the row goes, so it reads Verify again) with a note saying why.
 * Verified, trusted and skipped rows are never touched.
 */
export async function reopenTask(
  c: Clients,
  job: VerifyTaskJob,
  why: 'not_found' | 'unavailable',
  handle?: string,
): Promise<void> {
  const def = taskById(job.taskId);
  if (!def) return;
  const r = await c.prisma.taskCompletion.deleteMany({
    where: { userId: job.userId, taskId: job.taskId, day: dayDate(job.day), status: 'pending' },
  });
  if (!r.count) return;
  await notify(c, {
    userId: job.userId, type: 'points', link: '/tasks',
    body: why === 'not_found'
      ? [{ t: 'We couldn’t find ' }, { t: def.title, b: true }, { t: ` on ${handle ? '@' + handle : 'your X account'} yet. Do it with that X account (and keep it public), then press Verify again.` }]
      : [{ t: 'We couldn’t check ' }, { t: def.title, b: true }, { t: ' on X right now. Press Verify again later.' }],
  });
}

/**
 * Pending tasks whose check never came back (a job lost in a restart, or left by an older release): hand
 * them back. A verify job finishes its retries within ~15 minutes, so 30 minutes means it's gone.
 */
export async function reopenStalePending(c: Clients, olderThanMs = 30 * 60_000): Promise<number> {
  const before = new Date(Date.now() - olderThanMs);
  const rows = await c.prisma.taskCompletion.findMany({
    where: { status: 'pending', OR: [{ checkedAt: { lt: before } }, { checkedAt: null, createdAt: { lt: before } }] },
    select: { userId: true, taskId: true, day: true },
    take: 500,
  });
  for (const r of rows)
    await reopenTask(c, { userId: r.userId, taskId: r.taskId as TaskId, day: r.day.toISOString().slice(0, 10) }, 'unavailable');
  return rows.length;
}

/** X can't tell us: trust a low-value task (re-checked later), hand the rest back. */
async function cannotCheck(c: Clients, job: VerifyTaskJob, pts: number): Promise<'trusted' | 'unsupported'> {
  if (pts <= TRUST_MAX_POINTS) {
    await completeTask(c, job, 'trusted');
    return 'trusted';
  }
  await reopenTask(c, job, 'unavailable');
  return 'unsupported';
}

export async function runVerifyTask(c: Clients, job: VerifyTaskJob): Promise<'verified' | 'trusted' | 'not_found' | 'unsupported'> {
  const def = taskById(job.taskId);
  const user = await c.prisma.user.findUnique({ where: { id: job.userId } });
  if (!def || !user) return 'unsupported';
  const ctx = appXContext(c);
  if (!ctx) {
    if (c.cfg.devAuth) {
      await completeTask(c, job, 'verified'); // local dev without X: same behaviour as the prototype
      return 'verified';
    }
    console.warn('[x-jobs] X_BEARER_TOKEN is not set: tasks can only be checked with the member’s own X token');
    return cannotCheck(c, job, def.pts);
  }
  try {
    const r = await checkTaskOnX(ctx, {
      taskId: job.taskId, xUserId: user.xId, day: dayDate(job.day), joinedAt: user.joinedAt,
      launchPostId: c.cfg.launchPostId || null, cardHosts: [new URL(c.cfg.webUrl).host, 'swayfamily.com'],
    });
    if (r === 'verified') await completeTask(c, job, 'verified');
    else if (r === 'not_found') await reopenTask(c, job, 'not_found', user.handle);
    else return cannotCheck(c, job, def.pts); // e.g. 'repost' without X_LAUNCH_POST_ID
    return r;
  } catch (e) {
    if (isXUnavailable(e)) {
      console.warn(`[x-jobs] X can't check ${job.taskId}:`, (e as Error).message, JSON.stringify((e as { body?: unknown }).body ?? null));
      return cannotCheck(c, job, def.pts);
    }
    throw e; // network or 5xx: BullMQ retries with backoff, and the last failure reopens the task (main.ts)
  }
}

/** Re-checks 'trusted' tasks once the budget allows; revokes (and reverses points) when X says no. */
export async function recheckTrusted(c: Clients, limit = 20): Promise<number> {
  const ctx = appXContext(c);
  if (!ctx) return 0;
  const rows = await c.prisma.taskCompletion.findMany({ where: { status: 'trusted' }, include: { user: true }, orderBy: { checkedAt: 'asc' }, take: limit });
  let n = 0;
  for (const t of rows) {
    const day = t.day.toISOString().slice(0, 10);
    try {
      const r = await checkTaskOnX(ctx, { taskId: t.taskId as TaskId, xUserId: t.user.xId, day: t.day, joinedAt: t.user.joinedAt, launchPostId: c.cfg.launchPostId || null });
      if (r === 'verified') await c.prisma.taskCompletion.update({ where: { id: t.id }, data: { status: 'verified', checkedAt: new Date() } });
      else if (r === 'not_found') {
        await c.prisma.$transaction([
          c.prisma.taskCompletion.update({ where: { id: t.id }, data: { status: 'revoked', checkedAt: new Date() } }),
          c.prisma.pointsLedger.createMany({ data: [{ userId: t.userId, kind: 'task', amount: -t.points, ref: `task:${t.taskId}:${day}:revoked` }], skipDuplicates: true }),
        ]);
      }
      n++;
    } catch (e) {
      if (isXUnavailable(e)) break;
      throw e;
    }
  }
  return n;
}

/** Rescores a member from public X data (followers, last 50 posts) with the open model. */
export async function refreshScore(c: Clients, userId: string): Promise<boolean> {
  const ctx = appXContext(c);
  const user = await c.prisma.user.findUnique({ where: { id: userId } });
  if (!ctx || !user || !/^\d+$/.test(user.xId) || BigInt(user.xId) >= 9_000_000_000_000_000_000n) return false; // demo/dev ids aren't on X
  // A refresh queued before the member deleted their account must not write their X profile back.
  if (user.deletedAt) return false;
  const xu = await getUserById(ctx, user.xId);
  if (!xu) return false;
  const posts = await getRecentPosts(ctx, user.xId, 50);
  const { inputs, result } = scoreXAccount(xu, posts);
  await c.prisma.user.update({
    where: { id: userId },
    data: {
      handle: xu.username.toLowerCase(), name: xu.name, avatarUrl: xu.profileImageUrl ?? user.avatarUrl, bio: xu.description ?? user.bio,
      followers: xu.followers, verified: xu.verified, score: result.score, reachValue: result.value, scoreInputs: inputs as never, scoredAt: new Date(),
    },
  });
  return true;
}

/** Scheduled sweep: rescore the members scored longest ago (default 24h staleness), budget permitting. */
export async function sweepScores(c: Clients, limit = 25): Promise<number> {
  if (!appXContext(c)) return 0;
  const stale = await c.prisma.user.findMany({
    where: { joinedAt: { not: null }, OR: [{ scoredAt: null }, { scoredAt: { lt: new Date(Date.now() - 24 * 3600e3) } }] },
    orderBy: { scoredAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  let n = 0;
  for (const u of stale) {
    try {
      if (await refreshScore(c, u.id)) n++;
    } catch (e) {
      if (isXBudgetExceeded(e)) break;
      console.warn(`[score] ${u.id}: ${(e as Error).message}`);
    }
  }
  return n;
}
