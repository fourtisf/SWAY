import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { normalizeHandle } from '@sway/shared';
import type { Prisma } from '@sway/db';
import { notFound } from '../errors';

export const HandleParams = z.object({ handle: z.string().trim().min(1).max(40).transform((h) => normalizeHandle(h)) });
export const IdParams = z.object({ id: z.string().trim().min(1).max(64) });
export const TxHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte transaction hash').transform((h) => h.toLowerCase() as `0x${string}`);
export const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address');
/** Signed wei amount as a decimal string. */
export const WeiString = z.string().regex(/^-?\d{1,78}$/, 'must be a decimal wei string');

export const text = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\r\n/g, '\n').trim())
    .refine((s) => s.length > 0, 'cannot be empty')
    .refine((s) => s.length <= max, `must be at most ${max} characters`);

export const body = <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> => schema.parse(req.body ?? {});
export const query = <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> => schema.parse(req.query ?? {});
export const params = <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> => schema.parse(req.params ?? {});

/** Loads a user (with market) by handle or 404s. */
export async function userByHandle<T extends Prisma.UserInclude>(
  req: FastifyRequest,
  handle: string,
  include: T,
): Promise<Prisma.UserGetPayload<{ include: T }>> {
  const u = await req.server.deps.prisma.user.findUnique({ where: { handle }, include });
  if (!u) throw notFound(`No account @${handle}`, 'user_not_found');
  return u as Prisma.UserGetPayload<{ include: T }>;
}
