/**
 * [B] Moderation and account helpers shared by the feed, social, account and admin routes: blocks, admin
 * guard and audit log, wallets of a member, and post images (magic-byte sniffing, upload URLs).
 */
import type { FastifyRequest } from 'fastify';
import type { PrismaClient } from '@sway/db';
import { isVideoUrl, normalizeHandle, type UploadMime } from '@sway/shared';
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
export const UPLOAD_NAME = /^[a-f0-9]{32}\.(jpg|png|webp|gif|mp4|webm)$/;
export const EXT: Record<UploadMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};
/** Bytes a member can upload per rolling 24h, so videos can't fill the disk. */
export const UPLOAD_DAILY_BYTES = 500 * 1024 * 1024;

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

/**
 * ISO-BMFF video brands (the `ftyp` box). Phones record `mp42`/`isom`, iPhones `qt  ` (a QuickTime .mov, which
 * browsers play as mp4). HEIF/AVIF images share the box, so the brand is allow-listed rather than just `ftyp`.
 */
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'mp71',
  'avc1',
  'M4V ',
  'M4VH',
  'M4VP',
  'qt  ',
  '3gp4',
  '3gp5',
  '3gp6',
  '3g2a',
  'dash',
  'MSNV',
  'mmp4',
]);

/** Content type from the file's first bytes; null for anything that isn't an mp4/mov or webm video. */
export function sniffVideo(b: Buffer): UploadMime | null {
  if (
    b.length >= 12 &&
    b.subarray(4, 8).toString('latin1') === 'ftyp' &&
    MP4_BRANDS.has(b.subarray(8, 12).toString('latin1'))
  )
    return 'video/mp4';
  if (
    b.length >= 4 &&
    b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    b.subarray(0, 64).includes('webm', 0, 'latin1')
  )
    return 'video/webm';
  return null;
}

export const sniffUpload = (b: Buffer): UploadMime | null => sniffImage(b) ?? sniffVideo(b);

export const uploadUrl = (name: string) => UPLOAD_PREFIX + name;

/**
 * One `Range: bytes=a-b` (or `a-`, `-n`) → inclusive [start, end]. Null means send the whole file (no header,
 * several ranges or nonsense, which the RFC lets a server ignore); 'unsatisfiable' is a 416.
 */
export function byteRange(
  header: string | undefined,
  size: number,
): [number, number] | 'unsatisfiable' | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const n = Number(m[2]);
    return n > 0 && size > 0 ? [Math.max(0, size - n), size - 1] : 'unsatisfiable';
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start < size && start <= end ? [start, end] : 'unsatisfiable';
}

/**
 * CreatePostBody.media → canonical URLs. Each entry must be one of the author's own uploads (relative
 * "/api/uploads/<name>" or an absolute URL ending in it); duplicates are dropped, order is kept. A video
 * goes on its own, like on X.
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
  if (names.length > 1 && names.some(isVideoUrl))
    throw badRequest('video_alone', 'A video goes in a post on its own');
  const own = await prisma.upload.findMany({
    where: { userId, name: { in: names } },
    select: { name: true },
  });
  if (own.length !== names.length) throw badRequest('bad_media', 'Attach images you uploaded to Sway');
  return names.map(uploadUrl);
}
