import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decToStr, Prisma, type PrismaClient } from '@sway/db';
import { MARKET_CATEGORIES, TAGS, type ExploreResponse, type MarketDTO, type MarketsResponse, type SearchResponse, type TagDTO } from '@sway/shared';
import { query } from './_util';
import { marketDTOs, marketDtosForUsers, marketStats, marketDTO } from '../services/markets';

const DISPLAY_TAG = new Map(TAGS.map((t) => [t.toLowerCase(), t]));
const cleanQ = (q?: string) => (q ?? '').trim().toLowerCase().replace(/^[@#]/, '').slice(0, 40);

/** Tags by post count (all time), merged with the curated TAGS so the list is never empty. */
export async function tagList(prisma: PrismaClient, q: string, limit: number): Promise<TagDTO[]> {
  const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  const rows = await prisma.$queryRaw<Array<{ tag: string; posts: number }>>(Prisma.sql`
    SELECT pt.tag, count(*)::int AS posts
    FROM "PostTag" pt JOIN "Post" p ON p.id = pt."postId"
    WHERE p."deletedAt" IS NULL AND pt.tag ILIKE ${like}
    GROUP BY pt.tag ORDER BY posts DESC, pt.tag ASC LIMIT ${limit}`);
  const out = new Map<string, TagDTO>();
  for (const r of rows) out.set(r.tag, { tag: DISPLAY_TAG.get(r.tag) ?? r.tag, posts: r.posts });
  for (const t of TAGS) {
    const k = t.toLowerCase();
    if (!out.has(k) && (!q || k.includes(q))) out.set(k, { tag: t, posts: 0 });
  }
  return [...out.values()].sort((a, b) => b.posts - a.posts).slice(0, limit);
}

const nameFilter = (q: string): Prisma.UserWhereInput =>
  q ? { OR: [{ handle: { contains: q } }, { name: { contains: q, mode: 'insensitive' } }] } : {};

export async function marketRoutes(app: FastifyInstance) {
  const { prisma } = app.deps;

  app.get('/search', async (req): Promise<SearchResponse> => {
    const raw = query(z.object({ q: z.string().max(60).default('') }), req).q.trim();
    const q = cleanQ(raw);
    if (!q) return { members: [], tags: await tagList(prisma, '', 8) };
    const tags = await tagList(prisma, q, 8);
    if (raw.startsWith('#')) return { members: [], tags };
    const users = await prisma.user.findMany({
      where: { AND: [nameFilter(q), { OR: [{ joinedAt: { not: null } }, { market: { isNot: null } }] }] },
      include: { market: true },
      orderBy: { followers: 'desc' },
      take: 8,
    });
    return { members: await marketDtosForUsers(prisma, users), tags };
  });

  const ExploreQuery = z.object({
    tab: z.enum(['creators', 'tags', 'new']).default('creators'),
    sort: z.enum(['trending', 'volume', 'price', 'score']).default('trending'),
    q: z.string().max(60).optional(),
  });

  app.get('/explore', async (req): Promise<ExploreResponse> => {
    const p = query(ExploreQuery, req);
    const q = cleanQ(p.q);
    const tags = await tagList(prisma, q, 20);
    if (p.tab === 'tags') return { creators: [], tags };

    const where: Prisma.KeyMarketWhereInput = { claimed: true, user: { ...nameFilter(q), official: false } };
    let creators: MarketDTO[];
    if (p.tab === 'new') {
      const ms = await prisma.keyMarket.findMany({ where, include: { user: true }, orderBy: { user: { joinedAt: { sort: 'desc', nulls: 'last' } } }, take: 60 });
      creators = await marketDTOs(prisma, ms);
    } else if (p.sort === 'trending') {
      const ms = await prisma.keyMarket.findMany({
        where,
        include: { user: true },
        orderBy: [{ lastTradeAt: { sort: 'desc', nulls: 'last' } }, { volumeWei: 'desc' }],
        take: 500,
      });
      const stats = await marketStats(prisma, ms);
      creators = ms
        .map((m) => marketDTO(m, stats.get(m.id)))
        .sort((a, b) => b.change - a.change || (BigInt(b.volumeWei) > BigInt(a.volumeWei) ? 1 : -1))
        .slice(0, 60);
    } else {
      const orderBy: Prisma.KeyMarketOrderByWithRelationInput =
        p.sort === 'volume' ? { volumeWei: 'desc' } : p.sort === 'price' ? { supplyUnits: 'desc' } : { user: { score: 'desc' } };
      const ms = await prisma.keyMarket.findMany({ where, include: { user: true }, orderBy, take: 60 });
      creators = await marketDTOs(prisma, ms);
    }
    return { creators, tags };
  });

  app.get('/markets', async (req): Promise<MarketsResponse> => {
    const { tab } = query(z.object({ tab: z.enum(MARKET_CATEGORIES).default('creators') }), req);
    const where: Prisma.KeyMarketWhereInput = tab === 'creators' ? { claimed: true, user: { official: false } } : { category: tab, claimed: false };
    const [ms, agg] = await Promise.all([
      prisma.keyMarket.findMany({ where, include: { user: true }, orderBy: [{ volumeWei: 'desc' }, { supplyUnits: 'desc' }], take: 100 }),
      prisma.keyMarket.aggregate({ where, _count: { _all: true }, _sum: { volumeWei: true, holders: true } }),
    ]);
    return {
      stats: { markets: agg._count._all, volumeWei: decToStr(agg._sum.volumeWei), holders: agg._sum.holders ?? 0 },
      markets: await marketDTOs(prisma, ms),
    };
  });
}
