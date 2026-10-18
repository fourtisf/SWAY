/**
 * Feed ranking (the prototype's sc()) and post gating. Locked posts never carry their text: `text` is null
 * and `teaser` is neutral filler of the same length.
 */
import type { KeyMarket, Post, PrismaClient, User } from '@sway/db';
import { priceWei } from '@sway/curve';
import { OFFICIAL_HANDLE, type Address, type FeedResponse, type FeedTab, type PostDTO } from '@sway/shared';
import type { Viewer } from '../deps';
import type { AccessService } from './access';
import { userRef } from './dto';
import { marketStats } from './markets';

export const FEED_PAGE = 20;
const RANK_CANDIDATES = 500;
const TRENDING_WINDOW_MS = 48 * 3600 * 1000;

export type PostRow = Post & { author: User & { market: KeyMarket | null } };
export const POST_INCLUDE = { author: { include: { market: true } } } as const;

const FILLER = 'Hold a key to read this post. Sway rooms and holder posts open with one key. ';

/** Same-length neutral placeholder; never derived from the real text. */
export function teaser(length: number): string {
  if (length <= 0) return '';
  return FILLER.repeat(Math.ceil(length / FILLER.length)).slice(0, length);
}

/** For You score: (likes + 2·reposts + 3·replies) / (1 + ageMinutes/120) + 400 if boosted + authorScore·3. */
export function forYouScore(p: Pick<Post, 'likeCount' | 'repostCount' | 'replyCount' | 'boosted' | 'createdAt'>, authorScore: number, now: number): number {
  const ageMin = Math.max(0, (now - p.createdAt.getTime()) / 60000);
  return (p.likeCount + p.repostCount * 2 + p.replyCount * 3) / (1 + ageMin / 120) + (p.boosted ? 400 : 0) + (authorScore || 60) * 3;
}

export const trendingScore = (p: Pick<Post, 'likeCount' | 'repostCount'>): number => p.likeCount + p.repostCount * 2;

interface Ctx {
  prisma: PrismaClient;
  access: AccessService;
}

export async function postDTOs(ctx: Ctx, viewer: Viewer | null, posts: PostRow[]): Promise<PostDTO[]> {
  if (!posts.length) return [];
  const viewerId = viewer?.user.id ?? null;
  const ids = posts.map((p) => p.id);
  const authorMarkets = [...new Map(posts.flatMap((p) => (p.author.market ? [[p.author.market.id, p.author.market] as const] : []))).values()];

  const holderPosts = posts.filter((p) => p.visibility === 'holders' && p.authorId !== viewerId);
  const subPosts = posts.filter((p) => p.visibility === 'subs' && p.authorId !== viewerId);
  const accessViewer = viewer ? { userId: viewer.user.id, wallet: viewer.wallet?.address ?? null } : null;

  const [likes, reposts, stats, holderAccess, subs] = await Promise.all([
    viewerId ? ctx.prisma.like.findMany({ where: { userId: viewerId, postId: { in: ids } }, select: { postId: true } }) : [],
    viewerId ? ctx.prisma.repost.findMany({ where: { userId: viewerId, postId: { in: ids } }, select: { postId: true } }) : [],
    marketStats(ctx.prisma, authorMarkets),
    ctx.access.holderAccess(
      accessViewer,
      [...new Map(holderPosts.flatMap((p) => (p.author.market ? [[p.author.market.id, p.author.market] as const] : []))).values()],
    ),
    ctx.access.subscribedTo(viewerId, subPosts.map((p) => p.authorId)),
  ]);
  const liked = new Set(likes.map((l) => l.postId));
  const reposted = new Set(reposts.map((r) => r.postId));

  return posts.map((p) => {
    const m = p.author.market;
    const mine = viewerId !== null && p.authorId === viewerId;
    let locked = false;
    if (!mine && p.visibility === 'holders') locked = !(m && holderAccess.get(m.id));
    if (!mine && p.visibility === 'subs') locked = !subs.has(p.authorId);
    return {
      id: p.id,
      author: {
        ...userRef(p.author, m),
        subject: (m?.subject as Address | undefined) ?? null,
        priceWei: m ? priceWei(m.supplyUnits).toString() : null,
        change: m ? (stats.get(m.id)?.change ?? 0) : 0,
      },
      text: locked ? null : p.text,
      teaser: locked ? teaser(p.text.length) : null,
      locked,
      visibility: p.visibility,
      pinned: p.pinned,
      boosted: p.boosted,
      parentId: p.parentId,
      createdAt: p.createdAt.toISOString(),
      likes: p.likeCount,
      reposts: p.repostCount,
      replies: p.replyCount,
      liked: liked.has(p.id),
      reposted: reposted.has(p.id),
      mine,
    };
  });
}

/* ------------------------------------------------------------------ cursors */

interface OffsetCursor {
  o: number;
  t: number;
}
interface KeyCursor {
  c: string;
  i: string;
}

const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
function dec<T>(s: string | undefined | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ feed */

export async function pinnedPost(prisma: PrismaClient): Promise<PostRow | null> {
  return prisma.post.findFirst({
    where: { pinned: true, deletedAt: null, author: { official: true, handle: OFFICIAL_HANDLE } },
    orderBy: { createdAt: 'desc' },
    include: POST_INCLUDE,
  });
}

/** Author ids for the Following tab: followed accounts, markets the viewer holds, and the viewer. */
async function followingAuthorIds(prisma: PrismaClient, viewer: Viewer): Promise<string[]> {
  const [follows, held] = await Promise.all([
    prisma.follow.findMany({ where: { followerId: viewer.user.id }, select: { followeeId: true } }),
    viewer.wallet
      ? prisma.holding.findMany({ where: { address: viewer.wallet.address, units: { gt: 0n } }, select: { market: { select: { userId: true } } } })
      : [],
  ]);
  return [...new Set([viewer.user.id, ...follows.map((f) => f.followeeId), ...held.map((h) => h.market.userId)])];
}

export async function getFeed(ctx: Ctx, viewer: Viewer | null, tab: FeedTab, cursor?: string | null, now = Date.now()): Promise<FeedResponse> {
  const { prisma } = ctx;
  const pinned = !cursor && (tab === 'foryou' || tab === 'latest') ? await pinnedPost(prisma) : null;
  const base = { parentId: null, deletedAt: null, ...(pinned ? { id: { not: pinned.id } } : {}) };

  let page: PostRow[] = [];
  let nextCursor: string | null = null;

  if (tab === 'foryou' || tab === 'trending') {
    const oc = dec<OffsetCursor>(cursor);
    const at = oc?.t ?? now;
    const offset = Math.max(0, oc?.o ?? 0);
    const where = tab === 'trending' ? { ...base, createdAt: { gte: new Date(at - TRENDING_WINDOW_MS) } } : base;
    const candidates = await prisma.post.findMany({ where, orderBy: { createdAt: 'desc' }, take: RANK_CANDIDATES, include: POST_INCLUDE });
    const ranked =
      tab === 'foryou'
        ? candidates
            .map((p) => ({ p, s: forYouScore(p, p.author.score, at) }))
            .sort((a, b) => b.s - a.s || b.p.createdAt.getTime() - a.p.createdAt.getTime())
            .map((x) => x.p)
        : candidates.sort((a, b) => trendingScore(b) - trendingScore(a) || b.createdAt.getTime() - a.createdAt.getTime());
    page = ranked.slice(offset, offset + FEED_PAGE);
    if (offset + FEED_PAGE < ranked.length) nextCursor = enc({ o: offset + FEED_PAGE, t: at } satisfies OffsetCursor);
  } else {
    if (tab === 'following' && !viewer) return { pinned: null, posts: [], nextCursor: null };
    const kc = dec<KeyCursor>(cursor);
    const authorFilter = tab === 'following' && viewer ? { authorId: { in: await followingAuthorIds(prisma, viewer) } } : {};
    const keyset = kc
      ? { OR: [{ createdAt: { lt: new Date(kc.c) } }, { createdAt: new Date(kc.c), id: { lt: kc.i } }] }
      : {};
    const rows = await prisma.post.findMany({
      where: { ...base, ...authorFilter, ...keyset },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: FEED_PAGE + 1,
      include: POST_INCLUDE,
    });
    page = rows.slice(0, FEED_PAGE);
    if (rows.length > FEED_PAGE) {
      const last = page[page.length - 1]!;
      nextCursor = enc({ c: last.createdAt.toISOString(), i: last.id } satisfies KeyCursor);
    }
  }

  const dtos = await postDTOs(ctx, viewer, pinned ? [pinned, ...page] : page);
  return { pinned: pinned ? dtos[0]! : null, posts: pinned ? dtos.slice(1) : dtos, nextCursor };
}

/* ------------------------------------------------------------------ parsing */

/** #tags: lowercase, without '#', unique, at most 10. */
export function parseTags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(^|[^\w&])#([A-Za-z0-9_]{1,50})/g)) {
    if (/^\d+$/.test(m[2]!)) continue;
    out.add(m[2]!.toLowerCase());
    if (out.size >= 10) break;
  }
  return [...out];
}

/** @mentions: lowercase handles, unique, at most 10. */
export function parseMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(^|[^\w@])@([A-Za-z0-9_]{1,30})/g)) {
    out.add(m[2]!.toLowerCase());
    if (out.size >= 10) break;
  }
  return [...out];
}
