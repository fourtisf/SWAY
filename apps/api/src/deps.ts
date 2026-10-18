import type { Redis } from 'ioredis';
import type { PrismaClient, User, Wallet, KeyMarket } from '@sway/db';
import type { Config } from './config';
import type { ChainClient } from './services/chain';
import type { JobQueue } from './services/jobs';
import type { AccessService } from './services/access';

/** Everything buildApp needs from the outside world; tests pass fakes. */
export interface AppDeps {
  config: Config;
  prisma: PrismaClient;
  /** Commands, cache, sessions, pub. */
  redis: Redis;
  /** Dedicated subscriber connection for the WebSocket hub; defaults to redis.duplicate(). */
  redisSub?: Redis;
  chain: ChainClient;
  jobs: JobQueue;
  /** fetch used by @sway/x (tests inject a mock). */
  xFetch?: typeof fetch;
}

export interface SessionData {
  userId: string;
  /** X OAuth tokens, kept only here (Redis, 30-day TTL), never in Postgres. */
  x?: { accessToken: string; refreshToken?: string; expiresAt: number };
  /** Signed in through POST /api/auth/dev. */
  dev?: boolean;
  createdAt: number;
}

export interface Viewer {
  user: User;
  wallet: Wallet | null;
  market: KeyMarket | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    access: AccessService;
  }
  interface FastifyRequest {
    sid: string | null;
    session: SessionData | null;
    /** Memoised viewer row for this request. */
    viewerCache?: Promise<Viewer | null>;
  }
}
