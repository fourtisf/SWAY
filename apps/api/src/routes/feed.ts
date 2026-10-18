import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  POST_MAX,
  POST_MAX_STAKED,
  type FeedResponse,
  type PostDetailResponse,
  type PostDTO,
  type RichText,
  type TradeDTO,
} from '@sway/shared';
import { IdParams, body, params, query } from './_util';
import { getViewer, requireViewer } from '../plugins/auth';
import { badRequest, forbidden, notFound } from '../errors';
import { getFeed, parseMentions, parseTags, postDTOs, POST_INCLUDE } from '../services/feed';
import { notify, snippet } from '../services/notify';
import { stakingLevelOf } from '../services/me';
import { TRADE_INCLUDE, tradeDTOs } from '../services/dto';

const FeedQuery = z.object({
  tab: z.enum(['foryou', 'trending', 'following', 'latest']).default('foryou'),
  cursor: z.string().max(400).optional(),
});
const CreatePost = z.object({
  text: z.string().max(POST_MAX_STAKED * 2),
  visibility: z.enum(['public', 'holders', 'subs']).default('public'),
  parentId: z.string().max(64).optional(),
});

export async function feedRoutes(app: FastifyInstance) {
  const { prisma, redis, config } = app.deps;
  const ctx = { prisma, access: app.access };

  app.get('/feed', async (req): Promise<FeedResponse> => {
    const q = query(FeedQuery, req);
    return getFeed(ctx, await getViewer(req), q.tab, q.cursor);
  });

  app.post(
    '/posts',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req): Promise<PostDTO> => {
      const v = await requireViewer(req);
      const b = body(CreatePost, req);
      const text = b.text.replace(/\r\n/g, '\n').trim();
      if (!text) throw badRequest('empty_post', 'Write something first');
      const level = await stakingLevelOf(prisma, v.user.id, v.user.stakingLevel);
      const max = level >= 1 ? POST_MAX_STAKED : POST_MAX;
      if (text.length > max) {
        throw badRequest(
          'too_long',
          level >= 1
            ? `Posts can be up to ${max} characters`
            : `Posts can be up to ${max} characters (${POST_MAX_STAKED} with a staking level)`,
        );
      }

      let parent = null;
      if (b.parentId) {
        parent = await prisma.post.findFirst({
          where: { id: b.parentId, deletedAt: null },
          include: POST_INCLUDE,
        });
        if (!parent) throw notFound('That post no longer exists', 'post_not_found');
        const [pd] = await postDTOs(ctx, v, [parent]);
        if (pd!.locked) throw forbidden('locked', 'You need access to this post to reply');
      }

      const tags = parseTags(text);
      const post = await prisma.$transaction(async (tx) => {
        const p = await tx.post.create({
          data: { authorId: v.user.id, text, visibility: b.visibility, parentId: parent?.id ?? null },
        });
        if (tags.length)
          await tx.postTag.createMany({
            data: tags.map((tag) => ({ postId: p.id, tag })),
            skipDuplicates: true,
          });
        if (parent)
          await tx.post.update({ where: { id: parent.id }, data: { replyCount: { increment: 1 } } });
        return tx.post.findUniqueOrThrow({ where: { id: p.id }, include: POST_INCLUDE });
      });

      // Mentions → 'mention' notifications. Gated posts don't quote their text.
      const handles = parseMentions(text).filter((h) => h !== v.user.handle);
      const mentioned = handles.length
        ? await prisma.user.findMany({
            where: { handle: { in: handles }, joinedAt: { not: null } },
            select: { id: true },
          })
        : [];
      const quote =
        b.visibility === 'public'
          ? `: “${snippet(text)}”`
          : b.visibility === 'holders'
            ? ' in a post for key holders'
            : ' in a post for subscribers';
      const link = `/post/${post.id}`;
      const notified = new Set<string>();
      for (const m of mentioned) {
        notified.add(m.id);
        const bodyText: RichText = [{ t: v.user.name, b: true }, { t: ` mentioned you${quote}` }];
        await notify(prisma, redis, {
          userId: m.id,
          type: 'mention',
          fromUserId: v.user.id,
          body: bodyText,
          link,
        });
      }
      if (parent && parent.authorId !== v.user.id && !notified.has(parent.authorId)) {
        const r: RichText = [{ t: v.user.name, b: true }, { t: ` replied to your post${quote}` }];
        await notify(prisma, redis, {
          userId: parent.authorId,
          type: 'mention',
          fromUserId: v.user.id,
          body: r,
          link,
        });
      }

      const [dto] = await postDTOs(ctx, v, [post]);
      return dto!;
    },
  );

  app.get('/posts/:id', async (req): Promise<PostDetailResponse> => {
    const { id } = params(IdParams, req);
    const v = await getViewer(req);
    const post = await prisma.post.findFirst({ where: { id, deletedAt: null }, include: POST_INCLUDE });
    if (!post) throw notFound('That post no longer exists', 'post_not_found');
    const replies = await prisma.post.findMany({
      where: { parentId: id, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
      include: POST_INCLUDE,
    });
    const [p, ...r] = await postDTOs(ctx, v, [post, ...replies]);
    return { post: p!, replies: r };
  });

  /** Like / repost toggles: the row and the counter change in one transaction, race-safe without exceptions. */
  for (const kind of ['like', 'repost'] as const) {
    app.post(
      `/posts/:id/${kind}`,
      { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (req) => {
        const v = await requireViewer(req);
        const { id } = params(IdParams, req);
        const exists = await prisma.post.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
        if (!exists) throw notFound('That post no longer exists', 'post_not_found');
        const key = { userId: v.user.id, postId: id };
        const counter = kind === 'like' ? 'likeCount' : 'repostCount';
        const result = await prisma.$transaction(async (tx) => {
          const table = kind === 'like' ? tx.like : tx.repost;
          const removed = await (table as typeof tx.like).deleteMany({ where: key });
          if (removed.count === 1) {
            const p = await tx.post.update({ where: { id }, data: { [counter]: { decrement: 1 } } });
            return { on: false, count: p[counter] };
          }
          const added = await (table as typeof tx.like).createMany({ data: [key], skipDuplicates: true });
          const p =
            added.count === 1
              ? await tx.post.update({ where: { id }, data: { [counter]: { increment: 1 } } })
              : await tx.post.findUniqueOrThrow({ where: { id } });
          return { on: true, count: p[counter] };
        });
        return kind === 'like'
          ? { liked: result.on, count: result.count }
          : { reposted: result.on, count: result.count };
      },
    );
  }

  app.get('/trades', async (req): Promise<TradeDTO[]> => {
    const q = query(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }), req);
    const trades = await prisma.trade.findMany({
      orderBy: [{ ts: 'desc' }, { logIndex: 'desc' }],
      take: q.limit,
      include: TRADE_INCLUDE,
    });
    return tradeDTOs(prisma, trades, config.contracts.fanEscrow);
  });
}
