import { PrismaClient, Prisma } from '@prisma/client';

export * from '@prisma/client';

const globalForPrisma = globalThis as unknown as { swayPrisma?: PrismaClient };

/** Shared Prisma client (one per process; reused across hot reloads in dev). */
export const prisma: PrismaClient =
  globalForPrisma.swayPrisma ??
  new PrismaClient({ log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') globalForPrisma.swayPrisma = prisma;

/** Wei/unit helpers for Decimal(78,0) columns. */
export const dec = (v: bigint | number | string): Prisma.Decimal => new Prisma.Decimal(v.toString());
export const decToBig = (d: Prisma.Decimal | null | undefined): bigint => (d ? BigInt(d.toFixed(0)) : 0n);
export const decToStr = (d: Prisma.Decimal | null | undefined): string => (d ? d.toFixed(0) : '0');

/** Lowercase hex address for storage and lookups. */
export const addr = (a: string): string => a.toLowerCase();

/** Day key for one-off tasks. */
export const ONE_OFF_DAY = new Date('1970-01-01T00:00:00Z');
export const utcDay = (d = new Date()): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
