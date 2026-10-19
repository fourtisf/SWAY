import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DmResponse, MessageDTO, MessagesResponse, ThreadDTO } from '@sway/shared';
import { IdParams, body, params, text } from './_util';
import { getViewer, requireViewer } from '../plugins/auth';
import { badRequest, forbidden, notFound } from '../errors';
import { blockedEitherWay } from '../services/social';
import { messageDTO } from '../services/dto';
import { DM_INCLUDE, dmThreadDTO, dmThreads, orderPair, roomThreads } from '../services/messages';
import { publish } from '../services/bus';
import { memberAddresses } from '../services/access';
import { normalizeHandle } from '@sway/shared';

export async function messageRoutes(app: FastifyInstance) {
  const { prisma, redis } = app.deps;

  app.get('/messages', async (req): Promise<MessagesResponse> => {
    const v = await getViewer(req);
    if (!v) return { rooms: [], dms: [] };
    const [rooms, dms] = await Promise.all([
      roomThreads(prisma, v.user.id, await memberAddresses(prisma, v.user.id)),
      dmThreads(prisma, v.user.id),
    ]);
    // [B] conversations with accounts you blocked are hidden from your list
    const blocked = await prisma.block.findMany({
      where: { blockerId: v.user.id },
      select: { blocked: { select: { handle: true } } },
    });
    const hide = new Set(blocked.map((b) => b.blocked.handle));
    return { rooms, dms: hide.size ? dms.filter((d) => !hide.has(d.with.handle)) : dms };
  });

  app.post('/messages/dm', async (req): Promise<ThreadDTO> => {
    const v = await requireViewer(req);
    const b = body(z.object({ handle: z.string().trim().min(1).max(40) }), req);
    const handle = normalizeHandle(b.handle);
    const other = await prisma.user.findUnique({ where: { handle } });
    if (!other || (!other.joinedAt && !other.official))
      throw notFound(`@${handle} isn’t on Sway yet`, 'user_not_found');
    if (other.id === v.user.id) throw badRequest('self', 'You can’t message yourself');
    if (await blockedEitherWay(prisma, v.user.id, other.id))
      throw forbidden('blocked', 'You can’t message this account'); // [B]
    const [aId, bId] = orderPair(v.user.id, other.id);
    const now = new Date();
    const thread = await prisma.dmThread.upsert({
      where: { aId_bId: { aId, bId } },
      create: { aId, bId, aReadAt: now, bReadAt: now, lastMessageAt: now },
      update: {},
      include: { ...DM_INCLUDE, messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    return dmThreadDTO(thread, v.user.id, thread.messages[0]?.text ?? null);
  });

  async function threadFor(req: FastifyRequest, viewerId: string) {
    const { id } = params(IdParams, req);
    const t = await prisma.dmThread.findUnique({ where: { id }, include: DM_INCLUDE });
    if (!t || (t.aId !== viewerId && t.bId !== viewerId))
      throw notFound('Conversation not found', 'thread_not_found');
    return t;
  }

  app.get('/messages/dm/:id', async (req): Promise<DmResponse> => {
    const v = await requireViewer(req);
    const t = await threadFor(req, v.user.id);
    const rows = await prisma.dmMessage.findMany({
      where: { threadId: t.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { author: { include: { market: true } } },
    });
    const now = new Date();
    const read = t.aId === v.user.id ? { aReadAt: now } : { bReadAt: now };
    const updated = await prisma.dmThread.update({ where: { id: t.id }, data: read, include: DM_INCLUDE });
    return {
      thread: dmThreadDTO(updated, v.user.id, rows[0]?.text ?? null),
      messages: rows.reverse().map((m) => messageDTO(m, v.user.id)),
    };
  });

  app.post(
    '/messages/dm/:id',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req): Promise<MessageDTO> => {
      const v = await requireViewer(req);
      const t = await threadFor(req, v.user.id);
      const b = body(z.object({ text: text(2000) }), req);
      if (await blockedEitherWay(prisma, t.aId, t.bId))
        throw forbidden('blocked', 'You can’t message this account'); // [B]
      const now = new Date();
      const read = t.aId === v.user.id ? { aReadAt: now } : { bReadAt: now };
      const [msg] = await prisma.$transaction([
        prisma.dmMessage.create({
          data: { threadId: t.id, authorId: v.user.id, text: b.text, createdAt: now },
          include: { author: { include: { market: true } } },
        }),
        prisma.dmThread.update({ where: { id: t.id }, data: { lastMessageAt: now, ...read } }),
      ]);
      await publish(redis, { kind: 'dm', messageId: msg.id }).catch(() => undefined);
      return messageDTO(msg, v.user.id);
    },
  );
}
