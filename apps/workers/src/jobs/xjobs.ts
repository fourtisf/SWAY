/**
 * X API jobs on the `x-jobs` BullMQ queue (the contract with apps/api):
 *   verify-task   { userId, taskId, day: 'YYYY-MM-DD' }   task left 'pending' by the API
 *   refresh-score { userId }                              rescore a member from public X data
 * plus a scheduled sweep that rescores the stalest members within the X budget.
 * When the budget runs out, jobs retry with backoff and tasks stay open; low-value tasks (≤ 1,000 pts)
 * are marked 'trusted' and re-checked later (brief §12).
 */
import { taskById, type TaskId } from '@sway/shared';
import { checkTaskOnX, getRecentPosts, getUserById, isXBudgetExceeded, scoreXAccount } from '@sway/x';
import type { Clients } from '../clients';
import { notify } from '../notify';
import { appXContext } from '../xctx';

export const X_QUEUE = 'x-jobs';
export const TRUST_MAX_POINTS = 1000;

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
    return 'unsupported';
  }
  try {
    const r = await checkTaskOnX(ctx, {
      taskId: job.taskId, xUserId: user.xId, day: dayDate(job.day), joinedAt: user.joinedAt,
      launchPostId: c.cfg.launchPostId || null, cardHosts: [new URL(c.cfg.webUrl).host, 'sway.fam'],
    });
    if (r === 'verified') await completeTask(c, job, 'verified');
    else {
      await c.prisma.taskCompletion.updateMany({
        where: { userId: job.userId, taskId: job.taskId, day: dayDate(job.day) },
        data: { checkedAt: new Date(), attempts: { increment: 1 } },
      });
    }
    return r;
  } catch (e) {
    if (isXBudgetExceeded(e) && def.pts <= TRUST_MAX_POINTS) {
      await completeTask(c, job, 'trusted');
      return 'trusted';
    }
    throw e; // BullMQ retries with backoff; the task stays 'pending'
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
      if (isXBudgetExceeded(e)) break;
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
