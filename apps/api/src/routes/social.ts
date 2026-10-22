/**
 * [B] Reports, blocks, post images, price history, share cards and the account (settings, export, deletion).
 */
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { priceWei } from '@sway/curve';
import {
  POST_MEDIA_MAX,
  REPORT_REASONS,
  UPLOAD_MAX_BYTES,
  UPLOAD_VIDEO_MAX_BYTES,
  deleteConfirmText,
  isVideoMime,
  type AccountDTO,
  type CardDTO,
  type HistoryRange,
  type PriceHistoryResponse,
  type UploadDTO,
  type UploadMime,
  type UploadResponse,
} from '@sway/shared';
import { HandleParams, body, params, query, userByHandle } from './_util';
import { requireViewer } from '../plugins/auth';
import { HttpError, badRequest, notFound } from '../errors';
import { userRef } from '../services/dto';
import { canSeePost } from '../services/feed';
import { deleteAccount, exportAccount } from '../services/account';
import { EXT, UPLOAD_DAILY_BYTES, UPLOAD_NAME, byteRange, sniffUpload, uploadUrl } from '../services/social';

const RANGE_MS: Record<HistoryRange, number> = { '1h': 3600e3, '1d': 86400e3, '7d': 7 * 86400e3 };

export async function socialRoutes(app: FastifyInstance) {
  const { prisma, redis, config } = app.deps;

  /* ------------------------------------------------------------------ reports & blocks */

  const ReportBody = z.object({
    postId: z.string().trim().min(1).max(64).optional(),
    handle: z.string().trim().min(1).max(40).optional(),
    reason: z.enum(REPORT_REASONS),
    note: z.string().trim().max(1000).optional(),
  });

  app.post('/reports', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const v = await requireViewer(req);
    const b = body(ReportBody, req);
    if (!!b.postId === !!b.handle) throw badRequest('bad_target', 'Report either a post or an account');
    let postId: string | null = null;
    let reportedUserId: string;
    if (b.postId) {
      const p = await prisma.post.findUnique({ where: { id: b.postId } });
      if (!p || !canSeePost(p, v)) throw notFound('That post no longer exists', 'post_not_found');
      postId = p.id;
      reportedUserId = p.authorId;
    } else {
      const u = await userByHandle(req, b.handle!.replace(/^@/, '').toLowerCase(), {});
      reportedUserId = u.id;
    }
    if (reportedUserId === v.user.id) throw badRequest('self', 'You can’t report yourself');
    // One open report per reporter and target.
    const dup = await prisma.report.findFirst({
      where: { reporterId: v.user.id, status: 'open', postId, ...(postId ? {} : { reportedUserId }) },
    });
    if (!dup)
      await prisma.report.create({
        data: { reporterId: v.user.id, postId, reportedUserId, reason: b.reason, note: b.note || null },
      });
    return { ok: true as const };
  });

  /** Toggle. Blocking also removes follows both ways. */
  app.post('/users/:handle/block', async (req) => {
    const v = await requireViewer(req);
    const { handle } = params(HandleParams, req);
    const u = await userByHandle(req, handle, {});
    if (u.id === v.user.id) throw badRequest('self', 'You can’t block yourself');
    const key = { blockerId: v.user.id, blockedId: u.id };
    return prisma.$transaction(async (tx) => {
      const removed = await tx.block.deleteMany({ where: key });
      if (removed.count) return { blocked: false };
      await tx.block.createMany({ data: [key], skipDuplicates: true });
      await tx.follow.deleteMany({
        where: {
          OR: [
            { followerId: v.user.id, followeeId: u.id },
            { followerId: u.id, followeeId: v.user.id },
          ],
        },
      });
      return { blocked: true };
    });
  });

  /* ------------------------------------------------------------------ images */

  await app.register(async (scope) => {
    await scope.register(multipart, {
      // One more than allowed so a fifth file is a clear 400 instead of a silent truncation. Images are held
      // to UPLOAD_MAX_BYTES once their type is known; nginx caps the whole request.
      limits: { fileSize: UPLOAD_VIDEO_MAX_BYTES, files: POST_MEDIA_MAX + 1, fields: 10, parts: 20 },
    });

    scope.post(
      '/uploads',
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (req): Promise<UploadResponse> => {
        const v = await requireViewer(req);
        if (!req.isMultipart()) throw badRequest('not_multipart', 'Send the images as multipart/form-data');
        const files: Array<{ buf: Buffer; mime: UploadMime }> = [];
        try {
          for await (const part of req.parts()) {
            if (part.type !== 'file') continue;
            if (files.length >= POST_MEDIA_MAX)
              throw badRequest('too_many_files', `Up to ${POST_MEDIA_MAX} images per post`);
            if (files.some((f) => isVideoMime(f.mime)))
              throw badRequest('video_alone', 'A video goes in a post on its own');
            const buf = await part.toBuffer();
            const mime = sniffUpload(buf);
            if (!mime)
              throw badRequest('bad_image', 'Only JPEG, PNG, WebP and GIF images, or MP4 and WebM videos');
            if (isVideoMime(mime) && files.length)
              throw badRequest('video_alone', 'A video goes in a post on its own');
            if (!isVideoMime(mime) && buf.length > UPLOAD_MAX_BYTES)
              throw new HttpError(413, 'too_large', 'Images can be up to 5 MB');
            files.push({ buf, mime });
          }
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'FST_REQ_FILE_TOO_LARGE')
            throw new HttpError(413, 'too_large', 'Videos can be up to 50 MB, images up to 5 MB');
          if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT')
            throw badRequest('too_many_files', `Up to ${POST_MEDIA_MAX} images per post`);
          throw e;
        }
        if (!files.length) throw badRequest('no_file', 'Pick an image first');
        const bytes = files.reduce((n, f) => n + f.buf.length, 0);
        const today = await prisma.upload.aggregate({
          where: { userId: v.user.id, createdAt: { gt: new Date(Date.now() - 86_400_000) } },
          _sum: { bytes: true },
        });
        if ((today._sum.bytes ?? 0) + bytes > UPLOAD_DAILY_BYTES)
          throw new HttpError(429, 'upload_quota', 'You hit today’s upload limit. Try again tomorrow.');

        await mkdir(config.uploadDir, { recursive: true });
        const out: UploadDTO[] = [];
        const written: string[] = [];
        try {
          for (const f of files) {
            const name = `${randomBytes(16).toString('hex')}.${EXT[f.mime]}`;
            await writeFile(path.join(config.uploadDir, name), f.buf, { flag: 'wx', mode: 0o644 });
            written.push(name);
            out.push({ url: uploadUrl(name), name, mime: f.mime, bytes: f.buf.length });
          }
          await prisma.upload.createMany({
            data: out.map((u) => ({ userId: v.user.id, name: u.name, mime: u.mime, bytes: u.bytes })),
          });
        } catch (e) {
          await Promise.all(
            written.map((n) => unlink(path.join(config.uploadDir, n)).catch(() => undefined)),
          );
          throw e;
        }
        return { uploads: out };
      },
    );

    scope.get(
      '/uploads/:name',
      { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const { name } = params(z.object({ name: z.string().max(64) }), req);
        if (!UPLOAD_NAME.test(name)) throw notFound('No such image');
        const row = await prisma.upload.findUnique({ where: { name } });
        if (!row) throw notFound('No such image');
        const file = path.join(config.uploadDir, name);
        let size: number;
        try {
          size = (await stat(file)).size;
        } catch {
          throw notFound('No such image');
        }
        reply
          .header('Content-Type', row.mime)
          .header('Cache-Control', 'public, max-age=31536000, immutable')
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Security-Policy', "default-src 'none'; sandbox")
          .header('Accept-Ranges', 'bytes');
        // Video players (Safari above all) fetch in ranges and won't play without 206 responses.
        const range = byteRange(req.headers.range, size);
        if (range === 'unsatisfiable')
          return reply.code(416).header('Content-Range', `bytes */${size}`).send();
        if (range) {
          const [start, end] = range;
          return reply
            .code(206)
            .header('Content-Range', `bytes ${start}-${end}/${size}`)
            .header('Content-Length', end - start + 1)
            .send(createReadStream(file, { start, end }));
        }
        return reply.header('Content-Length', size).send(createReadStream(file));
      },
    );
  });

  /* ------------------------------------------------------------------ profile extras */

  /** Key price over a range: the price at the start, priceWei(supplyAfter) at each trade, then now. */
  app.get('/users/:handle/history', async (req): Promise<PriceHistoryResponse> => {
    const { handle } = params(HandleParams, req);
    const { range } = query(z.object({ range: z.enum(['1h', '1d', '7d']).default('1d') }), req);
    const u = await userByHandle(req, handle, { market: true });
    const m = u.market;
    if (!m) return { range, points: [] };
    const now = new Date();
    const opened = m.openedAt ?? m.createdAt;
    const since = new Date(
      Math.max(now.getTime() - RANGE_MS[range], Math.min(opened.getTime(), now.getTime())),
    );
    const order = [{ ts: 'asc' as const }, { blockNumber: 'asc' as const }, { logIndex: 'asc' as const }];
    const sel = { isBuy: true, units: true, supplyAfter: true, ts: true } as const;
    const [before, trades] = await Promise.all([
      prisma.trade.findFirst({
        where: { marketId: m.id, ts: { lt: since } },
        orderBy: [{ ts: 'desc' }, { blockNumber: 'desc' }, { logIndex: 'desc' }],
        select: sel,
      }),
      prisma.trade.findMany({
        where: { marketId: m.id, ts: { gte: since } },
        orderBy: order,
        take: 2000,
        select: sel,
      }),
    ]);
    const first = trades[0];
    const startSupply = before
      ? before.supplyAfter
      : first
        ? first.isBuy
          ? first.supplyAfter - first.units
          : first.supplyAfter + first.units
        : m.supplyUnits;
    return {
      range,
      points: [
        { t: since.toISOString(), priceWei: priceWei(startSupply).toString() },
        ...trades.map((t) => ({ t: t.ts.toISOString(), priceWei: priceWei(t.supplyAfter).toString() })),
        { t: now.toISOString(), priceWei: priceWei(m.supplyUnits).toString() },
      ],
    };
  });

  /** Public share card data (the web's /card/:handle page and its OG image). */
  app.get('/users/:handle/card', async (req): Promise<CardDTO> => {
    const { handle } = params(HandleParams, req);
    const u = await userByHandle(req, handle, { market: true });
    if (u.deletedAt) throw notFound(`No account @${handle}`, 'user_not_found');
    return {
      ...userRef(u, u.market),
      score: u.score,
      reachValue: u.reachValue,
      followers: u.followers,
      tier: u.tier,
      memberNo: u.memberNo,
      priceWei: u.market ? priceWei(u.market.supplyUnits).toString() : null,
    };
  });

  /* ------------------------------------------------------------------ account */

  app.get('/me/account', async (req): Promise<AccountDTO> => {
    const v = await requireViewer(req);
    const blocks = await prisma.block.findMany({
      where: { blockerId: v.user.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { blocked: { include: { market: true } } },
    });
    const u = v.user;
    return {
      id: u.id,
      handle: u.handle,
      name: u.name,
      avatarUrl: u.avatarUrl,
      verified: u.verified,
      memberNo: u.memberNo,
      joinedAt: u.joinedAt?.toISOString() ?? null,
      isAdmin: u.isAdmin,
      blocked: blocks.map((b) => userRef(b.blocked, b.blocked.market)),
    };
  });

  app.get('/me/export', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const v = await requireViewer(req);
    const data = await exportAccount(prisma, v.user);
    return reply
      .header('Content-Disposition', `attachment; filename="sway-${v.user.handle}-export.json"`)
      .header('Cache-Control', 'no-store')
      .send(data);
  });

  /** Typed confirmation "delete @handle"; every session of the account is revoked. */
  app.delete('/me', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const v = await requireViewer(req);
    const { confirm } = body(z.object({ confirm: z.string().max(80) }), req);
    if (confirm.trim().toLowerCase() !== deleteConfirmText(v.user.handle))
      throw badRequest('confirm_mismatch', `Type “${deleteConfirmText(v.user.handle)}” to confirm`);
    await deleteAccount({ prisma, redis, config }, v.user.id);
    req.log.info({ account: { action: 'delete', userId: v.user.id } }, 'account deleted');
    reply.clearCookie('sway_sid', { path: '/' });
    return { ok: true as const };
  });
}
