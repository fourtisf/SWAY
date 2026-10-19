/**
 * [B] /api/admin/*: moderation (reports, hidden posts, bot flags), claim/takedown requests, admins, market
 * halts and admin-opened fan markets. Every route requires User.isAdmin (403 otherwise) and every write is
 * logged with the actor, action and target.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { score } from '@sway/scoring';
import { FAN_BIO } from '@sway/db/demo';
import type { KeyMarket, Prisma, User } from '@sway/db';
import {
  MARKET_CATEGORIES,
  fanSubject,
  normalizeHandle,
  type Address,
  type AdminClaimDTO,
  type AdminMarketDTO,
  type AdminMemberDTO,
  type AdminReportDTO,
  type AdminTxResult,
  type MarketCategory,
  type ReportReason,
} from '@sway/shared';
import { HandleParams, IdParams, body, params, query, userByHandle } from './_util';
import { badRequest, conflict, notFound, unavailable } from '../errors';
import { userRef } from '../services/dto';
import { ChainError } from '../services/chain';
import { adminLog, requireAdmin } from '../services/social';

const MAX_UINT64 = (1n << 64n) - 1n;

const REPORT_INCLUDE = {
  reporter: { include: { market: true } },
  post: true,
  reportedUser: { include: { market: true } },
} satisfies Prisma.ReportInclude;
type ReportRow = Prisma.ReportGetPayload<{ include: typeof REPORT_INCLUDE }>;

function reportDTO(r: ReportRow): AdminReportDTO {
  return {
    id: r.id,
    reason: r.reason as ReportReason,
    note: r.note,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    reporter: userRef(r.reporter, r.reporter.market),
    post: r.post
      ? {
          id: r.post.id,
          text: r.post.text,
          media: r.post.media,
          visibility: r.post.visibility,
          createdAt: r.post.createdAt.toISOString(),
          hidden: r.post.hiddenAt !== null,
          deleted: r.post.deletedAt !== null,
        }
      : null,
    target: r.reportedUser ? { ...userRef(r.reportedUser, r.reportedUser.market), botFlag: r.reportedUser.botFlag } : null,
  };
}

function memberDTO(u: User & { market: KeyMarket | null }): AdminMemberDTO {
  return {
    ...userRef(u, u.market),
    id: u.id,
    memberNo: u.memberNo,
    joinedAt: u.joinedAt?.toISOString() ?? null,
    followers: u.followers,
    score: u.score,
    botFlag: u.botFlag,
    botReason: u.botReason,
    isAdmin: u.isAdmin,
    deleted: u.deletedAt !== null,
  };
}

function marketDTO(m: KeyMarket & { user: User }): AdminMarketDTO {
  return {
    ...userRef(m.user, m),
    subject: m.subject as Address,
    category: m.category as MarketCategory,
    fan: m.fan,
    claimed: m.claimed,
    opened: m.opened,
    halted: m.halted,
    supplyUnits: m.supplyUnits.toString(),
    holders: m.holders,
  };
}

const search = (q: string): Prisma.UserWhereInput =>
  q ? { OR: [{ handle: { contains: q } }, { name: { contains: q, mode: 'insensitive' } }] } : {};
const cleanQ = (q?: string) => (q ?? '').trim().toLowerCase().replace(/^@/, '').slice(0, 40);

export async function adminRoutes(app: FastifyInstance) {
  const { prisma, chain } = app.deps;

  await app.register(
    async (admin) => {
      // Guard every route in this scope, including any added later.
      admin.addHook('preHandler', async (req) => {
        await requireAdmin(req);
      });

      /* ------------------------------------------------------------ reports */

      admin.get('/reports', async (req): Promise<AdminReportDTO[]> => {
        const { status } = query(
          z.object({ status: z.enum(['open', 'actioned', 'dismissed']).default('open') }),
          req,
        );
        const rows = await prisma.report.findMany({
          where: { status },
          orderBy: { createdAt: status === 'open' ? 'asc' : 'desc' },
          take: 100,
          include: REPORT_INCLUDE,
        });
        return rows.map(reportDTO);
      });

      admin.post('/reports/:id', async (req): Promise<AdminReportDTO> => {
        const v = await requireAdmin(req);
        const { id } = params(IdParams, req);
        const { action } = body(z.object({ action: z.enum(['hide', 'dismiss', 'flag']) }), req);
        const r = await prisma.report.findUnique({ where: { id } });
        if (!r) throw notFound('Report not found');
        const now = new Date();
        const resolved = { resolvedById: v.user.id, resolvedAt: now };
        if (action === 'hide') {
          if (!r.postId) throw badRequest('no_post', 'This report is about an account, not a post');
          await prisma.$transaction([
            prisma.post.update({ where: { id: r.postId }, data: { hiddenAt: now } }),
            prisma.report.updateMany({ where: { postId: r.postId, status: 'open' }, data: { status: 'actioned', ...resolved } }),
          ]);
          adminLog(req, v, 'hide_post', r.postId, { report: id });
        } else if (action === 'flag') {
          if (!r.reportedUserId) throw badRequest('no_account', 'This report has no account');
          await prisma.$transaction([
            prisma.user.update({
              where: { id: r.reportedUserId },
              data: { botFlag: true, botReason: 'admin', botFlaggedAt: now },
            }),
            prisma.report.update({ where: { id }, data: { status: 'actioned', ...resolved } }),
          ]);
          adminLog(req, v, 'flag_bot', r.reportedUserId, { report: id });
        } else {
          await prisma.report.update({ where: { id }, data: { status: 'dismissed', ...resolved } });
          adminLog(req, v, 'dismiss_report', id);
        }
        return reportDTO(await prisma.report.findUniqueOrThrow({ where: { id }, include: REPORT_INCLUDE }));
      });

      admin.post('/posts/:id/hide', async (req) => {
        const v = await requireAdmin(req);
        const { id } = params(IdParams, req);
        const { hidden } = body(z.object({ hidden: z.boolean() }), req);
        const p = await prisma.post.findUnique({ where: { id } });
        if (!p || p.deletedAt) throw notFound('That post no longer exists', 'post_not_found');
        const now = new Date();
        await prisma.$transaction([
          prisma.post.update({ where: { id }, data: { hiddenAt: hidden ? now : null } }),
          ...(hidden
            ? [
                prisma.report.updateMany({
                  where: { postId: id, status: 'open' },
                  data: { status: 'actioned', resolvedById: v.user.id, resolvedAt: now },
                }),
              ]
            : []),
        ]);
        adminLog(req, v, hidden ? 'hide_post' : 'unhide_post', id);
        return { hidden };
      });

      /* ------------------------------------------------------------ claims & takedowns */

      const CLAIM_INCLUDE = {
        market: { include: { user: true } },
        user: { include: { market: true } },
      } satisfies Prisma.ClaimRequestInclude;
      const claimDTO = (c: Prisma.ClaimRequestGetPayload<{ include: typeof CLAIM_INCLUDE }>): AdminClaimDTO => ({
        id: c.id,
        kind: c.kind === 'takedown' ? 'takedown' : 'claim',
        contact: c.contact,
        note: c.note,
        status: c.status === 'resolved' ? 'resolved' : 'open',
        createdAt: c.createdAt.toISOString(),
        market: { ...userRef(c.market.user, c.market), subject: c.market.subject as Address, halted: c.market.halted },
        from: c.user ? userRef(c.user, c.user.market) : null,
      });

      admin.get('/claims', async (req): Promise<AdminClaimDTO[]> => {
        const { status } = query(z.object({ status: z.enum(['open', 'resolved']).default('open') }), req);
        const rows = await prisma.claimRequest.findMany({
          where: { status },
          orderBy: { createdAt: status === 'open' ? 'asc' : 'desc' },
          take: 100,
          include: CLAIM_INCLUDE,
        });
        return rows.map(claimDTO);
      });

      admin.post('/claims/:id/resolve', async (req): Promise<AdminClaimDTO> => {
        const v = await requireAdmin(req);
        const { id } = params(IdParams, req);
        const c = await prisma.claimRequest.findUnique({ where: { id } });
        if (!c) throw notFound('Request not found');
        const row = await prisma.claimRequest.update({ where: { id }, data: { status: 'resolved' }, include: CLAIM_INCLUDE });
        adminLog(req, v, 'resolve_claim', id, { kind: c.kind, market: c.marketId });
        return claimDTO(row);
      });

      /* ------------------------------------------------------------ members */

      admin.get('/members', async (req): Promise<AdminMemberDTO[]> => {
        const q = cleanQ(query(z.object({ q: z.string().max(60).optional() }), req).q);
        const rows = await prisma.user.findMany({
          where: { AND: [search(q), { OR: [{ joinedAt: { not: null } }, { deletedAt: { not: null } }] }] },
          orderBy: [{ joinedAt: { sort: 'desc', nulls: 'last' } }, { handle: 'asc' }],
          take: 50,
          include: { market: true },
        });
        return rows.map(memberDTO);
      });

      admin.post('/members/:handle/bot', async (req): Promise<AdminMemberDTO> => {
        const v = await requireAdmin(req);
        const { handle } = params(HandleParams, req);
        const { flagged } = body(z.object({ flagged: z.boolean() }), req);
        const u = await userByHandle(req, handle, {});
        const row = await prisma.user.update({
          where: { id: u.id },
          data: flagged
            ? { botFlag: true, botReason: 'admin', botFlaggedAt: new Date() }
            : { botFlag: false, botReason: null, botFlaggedAt: null },
          include: { market: true },
        });
        adminLog(req, v, flagged ? 'flag_bot' : 'unflag_bot', u.id, { handle });
        return memberDTO(row);
      });

      admin.post('/members/:handle/admin', async (req): Promise<AdminMemberDTO> => {
        const v = await requireAdmin(req);
        const { handle } = params(HandleParams, req);
        const { admin: on } = body(z.object({ admin: z.boolean() }), req);
        const u = await userByHandle(req, handle, {});
        if (u.id === v.user.id && !on) throw badRequest('self', 'You can’t remove your own admin access');
        if (on && (!u.joinedAt || u.deletedAt)) throw badRequest('not_member', 'Only members can be admins');
        const row = await prisma.user.update({ where: { id: u.id }, data: { isAdmin: on }, include: { market: true } });
        adminLog(req, v, on ? 'grant_admin' : 'revoke_admin', u.id, { handle });
        return memberDTO(row);
      });

      /* ------------------------------------------------------------ markets */

      admin.get('/markets', async (req): Promise<AdminMarketDTO[]> => {
        const q = cleanQ(query(z.object({ q: z.string().max(60).optional() }), req).q);
        const rows = await prisma.keyMarket.findMany({
          where: q ? { user: search(q) } : {},
          orderBy: [{ halted: 'desc' }, { volumeWei: 'desc' }],
          take: 50,
          include: { user: true },
        });
        return rows.map(marketDTO);
      });

      /** SwayKeys.setMarketHalted through the operator (fan admin). The indexer mirrors KeyMarket.halted. */
      admin.post('/markets/:handle/halt', async (req): Promise<AdminTxResult & { halted: boolean }> => {
        const v = await requireAdmin(req);
        const { handle } = params(HandleParams, req);
        const { halted } = body(z.object({ halted: z.boolean() }), req);
        const u = await userByHandle(req, handle, { market: true });
        if (!u.market) throw notFound(`@${handle} has no key market`, 'no_market');
        if (!chain.operatorEnabled) throw unavailable('chain_unavailable', 'SwayKeys or the operator key is not configured');
        const r = await chain.setMarketHalted(u.market.subject as Address, halted);
        if (r.status === 'reverted') throw new ChainError('setMarketHalted reverted', 'reverted');
        adminLog(req, v, halted ? 'halt_market' : 'unhalt_market', u.market.subject, { handle, tx: r.hash });
        return { txHash: r.hash, status: r.status, halted };
      });

      /**
       * Port of apps/workers/src/scripts/open-fan-market.ts: placeholder profile + KeyMarket row (category is
       * offchain metadata), then SwayKeys.openFanMarket(xId). The indexer marks the market opened.
       */
      const FanBody = z.object({
        handle: z.string().trim().min(1).max(30),
        name: z.string().trim().min(1).max(80),
        xId: z.string().trim().regex(/^\d{1,20}$/, 'must be a numeric X user id'),
        followers: z.coerce.number().int().min(0).max(2_000_000_000),
        category: z.enum(MARKET_CATEGORIES),
      });

      admin.post('/fan-markets', async (req): Promise<AdminTxResult & { market: AdminMarketDTO }> => {
        const v = await requireAdmin(req);
        const b = body(FanBody, req);
        const handle = normalizeHandle(b.handle);
        if (!/^[a-z0-9_]{1,30}$/.test(handle)) throw badRequest('invalid_handle', 'Handles use letters, digits and _');
        if (b.category === 'creators') throw badRequest('bad_category', 'Fan markets are crypto, football, stocks or rwa');
        const xId = BigInt(b.xId);
        if (xId === 0n || xId > MAX_UINT64) throw badRequest('bad_xid', 'That is not an X user id');

        const existing = await prisma.user.findUnique({ where: { xId: b.xId } });
        if (existing?.joinedAt) throw conflict('member', `@${existing.handle} is already a member; members open their own market`);
        const clash = await prisma.user.findUnique({ where: { handle } });
        if (clash && clash.xId !== b.xId) throw conflict('handle_taken', `@${handle} belongs to another X account`);
        const market0 = await prisma.keyMarket.findUnique({ where: { xId: b.xId } });
        if (market0?.opened) throw conflict('market_exists', `@${handle} already has a key market`);

        const inputs = { followers: b.followers, er: 0, ppw: 0, age: 0, verified: true };
        const r = score(inputs);
        const user =
          existing ??
          (await prisma.user.create({
            data: {
              xId: b.xId,
              handle,
              name: b.name,
              bio: FAN_BIO,
              followers: b.followers,
              verified: true,
              avatarUrl: null,
              score: r.score,
              reachValue: r.value,
              scoreInputs: inputs,
              scoredAt: new Date(),
            },
          }));
        const subject = fanSubject(xId).toLowerCase();
        const market = await prisma.keyMarket.upsert({
          where: { xId: b.xId },
          update: { category: b.category },
          create: { subject, userId: user.id, xId: b.xId, fan: true, claimed: false, category: b.category, opened: false },
          include: { user: true },
        });

        let result: AdminTxResult = { txHash: null, status: 'skipped' };
        if (chain.operatorEnabled) {
          const tx = await chain.openFanMarket(xId);
          if (tx.status === 'reverted') throw new ChainError('openFanMarket reverted', 'reverted');
          result = { txHash: tx.hash, status: tx.status };
        } else req.log.warn({ subject }, 'fan market opened in the DB only: SwayKeys/operator not configured');
        adminLog(req, v, 'open_fan_market', subject, { handle, xId: b.xId, category: b.category, tx: result.txHash });
        return { ...result, market: marketDTO(market) };
      });
    },
    { prefix: '/admin' },
  );
}
