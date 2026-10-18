import type { FastifyInstance } from 'fastify';
import type { TaskDTO, TasksResponse } from '@sway/shared';
import { IdParams, params } from './_util';
import { getViewer, requireViewer } from '../plugins/auth';
import { EMPTY_POINTS, pointsDTO } from '../services/points';
import { autoTasks, skipTask, taskList, verifyTask } from '../services/tasks';

export async function taskRoutes(app: FastifyInstance) {
  const { prisma, config } = app.deps;

  app.get('/tasks', async (req): Promise<TasksResponse> => {
    const v = await getViewer(req);
    if (!v) return { points: EMPTY_POINTS, tasks: await taskList(prisma, null), inviteLink: '', invitesCredited: 0 };
    let tasks = await taskList(prisma, v.user.id);
    if (await autoTasks(app.deps, v.user, v.wallet?.address ?? null, tasks)) tasks = await taskList(prisma, v.user.id);
    const [points, invitesCredited] = await Promise.all([
      pointsDTO(prisma, v.user),
      prisma.referral.count({ where: { inviterId: v.user.id, status: 'credited' } }),
    ]);
    return { points, tasks, inviteLink: `${config.webUrl}/i/${v.user.handle}`, invitesCredited };
  });

  app.post('/tasks/:id/verify', { config: { rateLimit: { max: config.rateLimit.xMax, timeWindow: '1 minute' } } }, async (req): Promise<TaskDTO> => {
    const v = await requireViewer(req);
    const { id } = params(IdParams, req);
    return verifyTask(req, v.user, v.wallet?.address ?? null, id);
  });

  app.post('/tasks/:id/skip', async (req): Promise<TaskDTO> => {
    const v = await requireViewer(req);
    const { id } = params(IdParams, req);
    return skipTask(prisma, v.user, id);
  });
}
