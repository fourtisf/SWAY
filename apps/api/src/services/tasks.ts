/**
 * Tasks (brief §6): the Join checklist unlocks in order (a task is 'locked' until the previous checklist task
 * is verified, trusted or skipped); daily tasks are keyed by utcDay(); 'buykey' completes automatically from
 * the Holding mirror. Points go to the append-only ledger with ref `task:<id>:<YYYY-MM-DD>`.
 */
import type { FastifyRequest } from 'fastify';
import type { PrismaClient, TaskCompletion, User } from '@sway/db';
import { ONE_OFF_DAY, utcDay } from '@sway/db';
import { isXBudgetExceeded, XApiError, checkTaskOnX, type TaskCheckResult } from '@sway/x';
import {
  TASKS,
  TASK_TRUST_MAX_POINTS,
  taskActionUrl,
  taskById,
  type TaskLinks,
  type RichText,
  type TaskDef,
  type TaskDTO,
  type TaskId,
  type TaskStatus,
} from '@sway/shared';
import type { AppDeps } from '../deps';
import { notFound, conflict, unprocessable, badRequest, unavailable } from '../errors';
import { notify, officialUserId } from './notify';
import { appendLedger } from './points';
import { sessionXToken, xClient } from './xauth';
import { ACCESS_UNITS, memberAddresses } from './access';

const DONE: ReadonlySet<string> = new Set(['verified', 'trusted', 'skipped']);
export const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
export const taskDay = (def: TaskDef, now = new Date()): Date => (def.daily ? utcDay(now) : ONE_OFF_DAY);

/** Ensures the Task catalogue rows exist (TaskCompletion references them). */
export async function syncTaskCatalogue(prisma: PrismaClient): Promise<void> {
  await prisma.task.createMany({
    data: TASKS.map((t) => ({ id: t.id, title: t.title, pts: t.pts, group: t.group })),
    skipDuplicates: true,
  });
}

function dto(def: TaskDef, status: TaskStatus, links: TaskLinks): TaskDTO {
  return {
    id: def.id,
    title: def.title,
    pts: def.pts,
    icon: def.icon,
    group: def.group,
    skippable: !!def.skippable,
    auto: !!def.auto,
    status,
    action: def.action ?? null,
    actionUrl: taskActionUrl(def.id, links),
  };
}

export const taskLinks = (deps: Pick<AppDeps, 'config'>): TaskLinks => ({
  launchPostId: deps.config.x.launchPostId,
  telegramUrl: deps.config.telegramUrl,
});

async function activeDefs(prisma: PrismaClient): Promise<TaskDef[]> {
  const off = await prisma.task.findMany({ where: { active: false }, select: { id: true } });
  const disabled = new Set(off.map((t) => t.id));
  return TASKS.filter((t) => !disabled.has(t.id));
}

/** Statuses for every active task, applying the sequential unlock. `userId` null → guest view. */
export async function taskList(
  prisma: PrismaClient,
  userId: string | null,
  links: TaskLinks = {},
  now = new Date(),
): Promise<TaskDTO[]> {
  const defs = await activeDefs(prisma);
  const rows: TaskCompletion[] = userId
    ? await prisma.taskCompletion.findMany({ where: { userId, day: { in: [ONE_OFF_DAY, utcDay(now)] } } })
    : [];
  const by = new Map(rows.map((r) => [`${r.taskId}:${dayKey(r.day)}`, r]));
  let unlocked = true;
  return defs.map((def) => {
    const c = by.get(`${def.id}:${dayKey(taskDay(def, now))}`);
    let status: TaskStatus = c ? c.status : 'open';
    if (def.group === 'Join checklist') {
      if (!unlocked && !c) status = 'locked';
      if (!DONE.has(status)) unlocked = false;
    }
    return dto(def, status, links);
  });
}

async function award(
  deps: AppDeps,
  user: User,
  def: TaskDef,
  day: Date,
  status: 'verified' | 'trusted',
  how: 'x' | 'auto' | 'trusted',
): Promise<void> {
  const { prisma, redis } = deps;
  const now = new Date();
  const created = await prisma.$transaction(async (tx) => {
    await tx.taskCompletion.upsert({
      where: { userId_taskId_day: { userId: user.id, taskId: def.id, day } },
      create: {
        userId: user.id,
        taskId: def.id,
        day,
        status,
        points: def.pts,
        attempts: 1,
        checkedAt: now,
        verifiedAt: now,
      },
      update: { status, points: def.pts, attempts: { increment: 1 }, checkedAt: now, verifiedAt: now },
    });
    return appendLedger(tx, {
      userId: user.id,
      kind: 'task',
      amount: def.pts,
      ref: `task:${def.id}:${dayKey(day)}`,
    });
  });
  if (!created) return;
  const lead = how === 'x' ? 'Task verified on X: ' : how === 'auto' ? 'Task verified: ' : 'Task recorded: ';
  const body: RichText = [
    { t: lead },
    { t: def.title, b: true },
    { t: `. +${def.pts.toLocaleString('en-US')} points.` },
  ];
  await notify(prisma, redis, {
    userId: user.id,
    type: 'points',
    fromUserId: await officialUserId(prisma),
    body,
    link: '/tasks',
  });
}

/** Holds ≥ 1 key of a market that isn't theirs (Holding mirror), summed across all of their wallets. */
export async function holdsOthersKey(
  prisma: PrismaClient,
  user: User,
  wallet: string | null,
): Promise<boolean> {
  const addrs = await memberAddresses(prisma, user.id);
  if (wallet && !addrs.includes(wallet.toLowerCase())) addrs.push(wallet.toLowerCase());
  if (!addrs.length) return false;
  const rows = await prisma.holding.findMany({
    where: { address: { in: addrs }, units: { gt: 0n }, market: { userId: { not: user.id } } },
    select: { marketId: true, units: true },
  });
  const units = new Map<string, bigint>();
  for (const r of rows) units.set(r.marketId, (units.get(r.marketId) ?? 0n) + r.units);
  return [...units.values()].some((u) => u >= ACCESS_UNITS);
}

/** Completes the auto task when the mirror shows a key the member didn't mint. */
export async function autoTasks(
  deps: AppDeps,
  user: User,
  wallet: string | null,
  list: TaskDTO[],
): Promise<boolean> {
  const t = list.find((x) => x.id === 'buykey');
  if (!t || t.status !== 'open') return false;
  if (!(await holdsOthersKey(deps.prisma, user, wallet))) return false;
  const def = taskById('buykey')!;
  await award(deps, user, def, taskDay(def), 'verified', 'auto');
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function verifyTask(
  req: FastifyRequest,
  user: User,
  wallet: string | null,
  id: string,
): Promise<TaskDTO> {
  const deps = req.server.deps;
  const def = taskById(id);
  const links = taskLinks(deps);
  const list = await taskList(deps.prisma, user.id, links);
  const current = list.find((t) => t.id === id);
  if (!def || !current) throw notFound('Unknown task', 'unknown_task');
  if (current.status === 'locked') throw conflict('task_locked', 'Finish the previous checklist task first');
  if (DONE.has(current.status)) return current;
  const day = taskDay(def);
  const done = async (status: TaskStatus) => dto(def, status, links);

  if (def.auto) {
    if (await holdsOthersKey(deps.prisma, user, wallet)) {
      await award(deps, user, def, day, 'verified', 'auto');
      return done('verified');
    }
    throw unprocessable('not_verified', 'Hold at least 1 key of a creator other than yourself');
  }
  // Telegram membership cannot be read from X: low-value task, trusted now and re-checkable later (brief §12).
  if (def.id === 'tg') {
    await award(deps, user, def, day, 'trusted', 'trusted');
    return done('trusted');
  }
  if (deps.config.devAuth && req.session?.dev) {
    if (deps.config.devVerifyDelayMs > 0) await sleep(deps.config.devVerifyDelayMs);
    await award(deps, user, def, day, 'verified', 'x');
    return done('verified');
  }

  // The member's own token first, then the app's bearer token (its own quota, and it still works when the
  // session's token can't be refreshed). Settled here, never left pending: X either answers, or the task is
  // trusted (small ones) or refused with a reason.
  const input = {
    taskId: def.id as TaskId,
    xUserId: user.xId,
    day,
    joinedAt: user.joinedAt,
    launchPostId: deps.config.x.launchPostId,
    cardHosts: [new URL(deps.config.webUrl).host],
  };
  const tries: Array<{ token: string; scope: string }> = [];
  const own = await sessionXToken(req);
  if (own) tries.push({ token: own, scope: `u:${user.id}` });
  if (deps.config.x.bearerToken) tries.push({ token: deps.config.x.bearerToken, scope: 'app' });
  let failure: unknown = null;
  for (const t of tries) {
    let r: TaskCheckResult;
    try {
      r = await checkTaskOnX(xClient(deps, t.token, t.scope).ctx, input);
    } catch (e) {
      if (!isXBudgetExceeded(e) && !(e instanceof XApiError)) throw e;
      req.log.warn(
        { err: e, task: def.id, via: t.scope === 'app' ? 'app' : 'member', body: (e as XApiError).body },
        'X task check failed',
      );
      failure = e;
      continue;
    }
    if (r === 'verified') {
      await award(deps, user, def, day, 'verified', 'x');
      return done('verified');
    }
    // The usual cause: it was done from another X account than the one signed in to Sway.
    if (r === 'not_found')
      throw unprocessable(
        'not_verified',
        `We couldn’t find that on @${user.handle} yet. Do it with that X account, then try again in a minute.`,
      );
    failure = null; // 'unsupported': X has no way to check it (e.g. no launch post id)
    break;
  }
  if (failure instanceof XApiError && (failure.status === 0 || failure.status >= 500))
    throw unavailable('x_down', 'X isn’t answering right now. Try again in a minute.');
  // X won't tell us (API plan, quota, no token): trust small tasks, re-checked later by the workers.
  if (def.pts <= TASK_TRUST_MAX_POINTS) {
    await award(deps, user, def, day, 'trusted', 'trusted');
    return done('trusted');
  }
  throw unprocessable('x_unavailable', 'X can’t confirm this task right now. Try again later.');
}

export async function skipTask(
  prisma: PrismaClient,
  user: User,
  id: string,
  links: TaskLinks = {},
): Promise<TaskDTO> {
  const def = taskById(id);
  const list = await taskList(prisma, user.id, links);
  const current = list.find((t) => t.id === id);
  if (!def || !current) throw notFound('Unknown task', 'unknown_task');
  if (!def.skippable) throw badRequest('not_skippable', 'Only optional tasks can be skipped');
  if (current.status === 'locked') throw conflict('task_locked', 'Finish the previous checklist task first');
  if (DONE.has(current.status)) return current;
  const day = taskDay(def);
  await prisma.taskCompletion.upsert({
    where: { userId_taskId_day: { userId: user.id, taskId: def.id, day } },
    create: { userId: user.id, taskId: def.id, day, status: 'skipped', points: 0, checkedAt: new Date() },
    update: { status: 'skipped', points: 0, checkedAt: new Date() },
  });
  return dto(def, 'skipped', links);
}
