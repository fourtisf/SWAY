/**
 * [B] Moderation and account helpers shared by the feed, social, account and admin routes: blocks, admin
 * guard and audit log, wallets of a member, and post images (magic-byte sniffing, upload URLs).
 */
import type { FastifyRequest } from 'fastify';
import type { PrismaClient } from '@sway/db';
import { normalizeHandle, type UploadMime } from '@sway/shared';
import type { Config } from '../config';
import type { Viewer } from '../deps';
import { badRequest, forbidden } from '../errors';
import { requireViewer } from '../plugins/auth';

/* ------------------------------------------------------------------ blocks */

/** True when either account blocked the other (DMs are refused both ways). */
export async function blockedEitherWay(prisma: PrismaClient, a: string, b: string): Promise<boolean> {
  const n = await prisma.block.count({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
  });
  return n > 0;
}

/* ------------------------------------------------------------------ admins */

export async function requireAdmin(req: FastifyRequest): Promise<Viewer> {
  const v = await requireViewer(req);
  if (!v.user.isAdmin) throw forbidden('forbidden', 'Admins only');
  return v;
}

/** Every admin action goes to the app log: who, what, on what. */
export function adminLog(
  req: FastifyRequest,
  v: Viewer,
  action: string,
  target: string,
  extra: object = {},
): void {
  req.log.info(
    { admin: { actor: v.user.handle, actorId: v.user.id, action, target, ...extra } },
    `admin ${action} ${target}`,
  );
}

/** ADMIN_HANDLES bootstraps admins at every sign-in (it only grants; the panel can revoke). */
export async function bootstrapAdmin(
  prisma: PrismaClient,
  config: Config,
  userId: string,
  handle: string,
): Promise<void> {
  if (!config.adminHandles.includes(normalizeHandle(handle))) return;
  await prisma.user.updateMany({ where: { id: userId, isAdmin: false }, data: { isAdmin: true } });
}

/* ------------------------------------------------------------------ images */

export const UPLOAD_PREFIX = '/api/uploads/';
export const UPLOAD_NAME = /^[a-f0-9]{32}\.(jpg|png|webp|gif)$/;
export const EXT: Record<UploadMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Content type from the file's first bytes; null for anything that isn't a jpeg/png/webp/gif image. */
export function sniffImage(b: Buffer): UploadMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

export const uploadUrl = (name: string) => UPLOAD_PREFIX + name;

/**
 * CreatePostBody.media → canonical URLs. Each entry must be one of the author's own uploads (relative
 * "/api/uploads/<name>" or an absolute URL ending in it); duplicates are dropped, order is kept.
 */
export async function resolveMedia(prisma: PrismaClient, userId: string, urls: string[]): Promise<string[]> {
  const names: string[] = [];
  for (const u of urls) {
    const i = u.indexOf(UPLOAD_PREFIX);
    const name = i >= 0 ? u.slice(i + UPLOAD_PREFIX.length) : '';
    if (!UPLOAD_NAME.test(name)) throw badRequest('bad_media', 'Attach images you uploaded to Sway');
    if (!names.includes(name)) names.push(name);
  }
  if (!names.length) return [];
  const own = await prisma.upload.findMany({
    where: { userId, name: { in: names } },
    select: { name: true },
  });
  if (own.length !== names.length) throw badRequest('bad_media', 'Attach images you uploaded to Sway');
  return names.map(uploadUrl);
}
