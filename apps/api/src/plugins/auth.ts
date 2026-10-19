import type { FastifyRequest } from 'fastify';
import type { Viewer } from '../deps';
import { unauthorized } from '../errors';

/** The signed-in user's id, or 401 auth_required. */
export function requireUserId(req: FastifyRequest): string {
  const id = req.session?.userId;
  if (!id) throw unauthorized();
  return id;
}

/** Signed-in member with wallet and own market, memoised per request; null for guests. */
export function getViewer(req: FastifyRequest): Promise<Viewer | null> {
  if (!req.viewerCache) {
    const id = req.session?.userId;
    req.viewerCache = id
      ? req.server.deps.prisma.user
          .findUnique({ where: { id }, include: { wallet: true, market: true } })
          // A deleted account's sessions are revoked; treat any straggler as a guest.
          .then((u) => (u && !u.deletedAt ? { user: u, wallet: u.wallet, market: u.market } : null))
      : Promise.resolve(null);
  }
  return req.viewerCache;
}

export async function requireViewer(req: FastifyRequest): Promise<Viewer> {
  const v = await getViewer(req);
  if (!v) throw unauthorized();
  return v;
}

/** Forget the memoised viewer after a write that changes it (wallet link, market open). */
export function resetViewer(req: FastifyRequest): void {
  req.viewerCache = undefined;
}
