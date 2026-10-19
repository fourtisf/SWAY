import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { usdToWei } from '@sway/curve';
import { Prisma } from '@sway/db';
import {
  BOOST_HOURS,
  POST_MAX,
  POST_MAX_STAKED,
  POST_MEDIA_MAX,
  type Address,
  type BoostQuoteDTO,
  type BoostResponse,
  type FeedResponse,
  type PostDetailResponse,
  type PostDTO,
  type RichText,
  type TradeDTO,
} from '@sway/shared';
import { IdParams, TxHash, body, params, query } from './_util';
import { getViewer, requireViewer } from '../plugins/auth';
import { badRequest, conflict, forbidden, notFound, unavailable } from '../errors';
import {
  blockedIds,
  canSeePost,
  getFeed,
  parseMentions,
  parseTags,
  postDTOs,
  POST_INCLUDE,
  visiblePosts,
  type PostRow,
} from '../services/feed';
import { notify, snippet } from '../services/notify';
import { stakingLevelOf } from '../services/me';
import { TRADE_INCLUDE, tradeDTOs } from '../services/dto';
import { getEthUsd } from '../services/price';
import { memberAddresses } from '../services/access';
import { adminLog, resolveMedia } from '../services/social';

const FeedQuery = z.object({
  tab: z.enum(['foryou', 'trending', 'following', 'latest']).default('foryou'),
  cursor: z.string().max(400).optional(),
});
const CreatePost = z.object({
  text: z.string().max(POST_MAX_STAKED * 2).default(''),
  visibility: z.enum(['public', 'holders', 'subs']).default('public'),
  parentId: z.string().max(64).optional(),
  media: z.array(z.string().max(300)).max(20).optional(),
});

/** Ancestors shown above a post on its page. */
const MAX_PARENTS = 20;
const HOUR_MS = 3600 * 1000;

export async function feedRoutes(app: FastifyInstance) {
  const { prisma, redis, config, chain } = app.deps;
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
      if ((b.media?.length ?? 0) > POST_MEDIA_MAX)
        throw badRequest('too_many_media', `Posts can have up to ${POST_MEDIA_MAX} images`);
      const media = await resolveMedia(prisma, v.user.id, b.media ?? []);
      if (!text && !media.length) throw badRequest('empty_post', 'Write something first');
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
        if (!parent || !canSeePost(parent, v)) throw notFound('That post no longer exists', 'post_not_found');
        const blockedBy = await prisma.block.findUnique({
          where: { blockerId_blockedId: { blockerId: parent.authorId, blockedId: v.user.id } },
        });
        if (blockedBy) throw forbidden('blocked', 'You can’t reply to this account');
        const [pd] = await postDTOs(ctx, v, [parent]);
        if (pd!.locked) throw forbidden('locked', 'You need access to this post to reply');
      }

      const tags = parseTags(text);
      const post = await prisma.$transaction(async (tx) => {
        const p = await tx.post.create({
          data: { authorId: v.user.id, text, media, visibility: b.visibility, parentId: parent?.id ?? null },
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

      // Mentions → 'mention' notifications (not for accounts that blocked the author). Gated posts don't
      // quote their text.
      const handles = parseMentions(text).filter((h) => h !== v.user.handle);
      const mentioned = handles.length
        ? await prisma.user.findMany({
            where: {
              handle: { in: handles },
              joinedAt: { not: null },
              blocks: { none: { blockedId: v.user.id } },
            },
            select: { id: true },
          })
        : [];
      const quote =
        b.visibility === 'public'
          ? `: “${snippet(text || 'an image')}”`
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

  /** The post, the chain above it (root first) and two levels of replies, oldest first. */
  app.get('/posts/:id', async (req): Promise<PostDetailResponse> => {
    const { id } = params(IdParams, req);
    const v = await getViewer(req);
    const post = await prisma.post.findFirst({ where: { id, deletedAt: null }, include: POST_INCLUDE });
    if (!post || !canSeePost(post, v)) throw notFound('That post no longer exists', 'post_not_found');
    const blocked = await blockedIds(prisma, v);

    const parents: PostRow[] = [];
    let parentUnavailable = false;
    for (let pid = post.parentId; pid && parents.length < MAX_PARENTS; ) {
      const p = await prisma.post.findUnique({ where: { id: pid }, include: POST_INCLUDE });
      if (!p || !canSeePost(p, v, blocked)) {
        parentUnavailable = true;
        break;
      }
      parents.unshift(p);
      pid = p.parentId;
    }

    const vis = await visiblePosts(prisma, v);
    const order = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
    const replies = await prisma.post.findMany({
      where: { AND: [vis, { parentId: id }] },
      orderBy: order,
      take: 200,
      include: POST_INCLUDE,
    });
    const nested = replies.length
      ? await prisma.post.findMany({
          where: { AND: [vis, { parentId: { in: replies.map((r) => r.id) } }] },
          orderBy: order,
          take: 500,
          include: POST_INCLUDE,
        })
      : [];
    const dtos = await postDTOs(ctx, v, [post, ...parents, ...replies, ...nested]);
    let i = 1;
    const take = (n: number) => dtos.slice(i, (i += n));
    return {
      post: dtos[0]!,
      parents: take(parents.length),
      parentUnavailable,
      replies: take(replies.length),
      nested: take(nested.length),
    };
  });

  /** Soft delete by the author or an admin; the parent's reply count drops with it. */
  app.delete('/posts/:id', async (req) => {
    const v = await requireViewer(req);
    const { id } = params(IdParams, req);
    const p = await prisma.post.findUnique({ where: { id } });
    if (!p || p.deletedAt) throw notFound('That post no longer exists', 'post_not_found');
    const mine = p.authorId === v.user.id;
    if (!mine && !v.user.isAdmin) throw forbidden('not_yours', 'You can only delete your own posts');
    await prisma.$transaction(async (tx) => {
      const r = await tx.post.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } });
      if (r.count && p.parentId)
        await tx.$executeRaw`UPDATE "Post" SET "replyCount" = GREATEST(0, "replyCount" - 1) WHERE id = ${p.parentId}`;
    });
    if (!mine) adminLog(req, v, 'delete_post', id, { author: p.authorId });
    return { ok: true as const };
  });

  /* ------------------------------------------------------------------ boosts */

  let treasuryMemo: { at: number; value: Address | null } | null = null;
  async function treasury(): Promise<Address | null> {
    if (config.treasury) return config.treasury;
    if (treasuryMemo && Date.now() - treasuryMemo.at < 5 * 60_000) return treasuryMemo.value;
    const value = await chain.treasury().catch(() => null);
    treasuryMemo = { at: Date.now(), value };
    return value;
  }

  async function boostWei(): Promise<bigint> {
    const { ethUsd } = await getEthUsd(redis, config.ethUsdFallback);
    return usdToWei(config.boostUsd, ethUsd);
  }

  app.get('/boost', async (): Promise<BoostQuoteDTO> => ({
    usd: config.boostUsd,
    wei: (await boostWei()).toString(),
    treasury: await treasury(),
    hours: BOOST_HOURS,
  }));

  /**
   * Boost one of your posts for 24h: txHash must have sent ≥ BOOST_USD of ETH (2% tolerance at the current
   * price) from one of your wallets to the treasury. Each transaction boosts once (Post.boostTx and the
   * `boost:<tx>` activity ref are unique). A running boost is extended.
   */
  app.post(
    '/posts/:id/boost',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req): Promise<BoostResponse> => {
      const v = await requireViewer(req);
      const { id } = params(IdParams, req);
      const { txHash } = body(z.object({ txHash: TxHash }), req);
      const p = await prisma.post.findUnique({ where: { id } });
      if (!p || p.deletedAt) throw notFound('That post no longer exists', 'post_not_found');
      if (p.authorId !== v.user.id) throw forbidden('not_yours', 'You can only boost your own posts');
      if (p.hiddenAt) throw conflict('hidden', 'This post was hidden by a moderator');
      const ref = `boost:${txHash}`;
      const used =
        (await prisma.post.findUnique({ where: { boostTx: txHash }, select: { id: true } })) ||
        (await prisma.activity.findUnique({ where: { ref }, select: { id: true } }));
      if (used) throw conflict('tx_used', 'This payment was already used for a boost');

      const to = await treasury();
      if (!to) throw unavailable('boost_unavailable', 'Boosts aren’t available on this network yet');
      if (!chain.rpcEnabled) throw unavailable('chain_unavailable', 'Could not reach the chain to check the payment');
      const expected = await boostWei();
      let tx;
      try {
        tx = await chain.waitForTx(txHash, 15_000);
      } catch {
        throw unavailable('chain_unavailable', 'Could not reach the chain to check the payment. Try again.');
      }
      if (!tx) throw badRequest('tx_not_found', 'That transaction was not found onchain');
      if (tx.status === 'pending')
        throw conflict('tx_pending', 'The payment is not confirmed yet. Try again in a moment.');
      if (tx.status === 'reverted') throw badRequest('tx_reverted', 'That payment reverted');
      if (!(await memberAddresses(prisma, v.user.id)).includes(tx.from.toLowerCase()))
        throw forbidden('tx_not_yours', 'That payment was not sent from one of your wallets');
      if (tx.to?.toLowerCase() !== to.toLowerCase())
        throw badRequest('wrong_recipient', 'That payment did not go to the Sway treasury');
      if (tx.value * 100n < expected * 98n)
        throw badRequest('underpaid', `A boost costs $${config.boostUsd}`);

      const now = Date.now();
      const from = Math.max(now, p.boostedUntil?.getTime() ?? 0);
      try {
        await prisma.$transaction([
          prisma.activity.create({
            data: { userId: v.user.id, label: 'Boosted a post', amountWei: (-tx.value).toString(), txHash, ref },
          }),
          prisma.post.update({
            where: { id },
            data: { boostedUntil: new Date(from + BOOST_HOURS * HOUR_MS), boostTx: txHash },
          }),
        ]);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw conflict('tx_used', 'This payment was already used for a boost');
        throw e;
      }
      const row = await prisma.post.findUniqueOrThrow({ where: { id }, include: POST_INCLUDE });
      const [dto] = await postDTOs(ctx, v, [row]);
      return { post: dto! };
    },
  );

  /** Like / repost toggles: the row and the counter change in one transaction, race-safe without exceptions. */
  for (const kind of ['like', 'repost'] as const) {
    app.post(
      `/posts/:id/${kind}`,
      { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (req) => {
        const v = await requireViewer(req);
        const { id } = params(IdParams, req);
        const exists = await prisma.post.findFirst({
          where: { id, deletedAt: null },
          select: { id: true, authorId: true, deletedAt: true, hiddenAt: true },
        });
        if (!exists || !canSeePost(exists, v)) throw notFound('That post no longer exists', 'post_not_found');
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
