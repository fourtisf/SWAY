/**
 * buildApp(deps): the Fastify instance with every route, used by main.ts and by the tests (fastify.inject with
 * a fake ChainClient and an in-memory job queue).
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { AppDeps } from './deps';
import { setupErrors } from './plugins/errors';
import { setupSession } from './plugins/session';
import { AccessService } from './services/access';
import { syncTaskCatalogue } from './services/tasks';
import { setupWs, type WsHub } from './ws';
import { systemRoutes } from './routes/system';
import { authRoutes } from './routes/auth';
import { walletRoutes } from './routes/wallet';
import { feedRoutes } from './routes/feed';
import { marketRoutes } from './routes/markets';
import { userRoutes } from './routes/users';
import { messageRoutes } from './routes/messages';
import { notificationRoutes } from './routes/notifications';
import { taskRoutes } from './routes/tasks';
import { rankingRoutes } from './routes/rankings';
import { battleRoutes } from './routes/battles';

/** JSON that never throws on BigInt (wei and units go out as decimal strings). */
export const jsonReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/** req.ip can throw for upgrade requests without a socket address; never let that fail a request. */
function clientIp(req: FastifyRequest): string {
  try {
    return req.ip || 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface BuiltApp extends FastifyInstance {
  hub?: WsHub;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { config } = deps;
  const app: BuiltApp = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
            ...(config.isProd
              ? {}
              : {
                  transport: {
                    target: 'pino-pretty',
                    options: { singleLine: true, translateTime: 'HH:MM:ss' },
                  },
                }),
          },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  app.decorate('deps', deps);
  app.decorate('access', new AccessService(deps.prisma, deps.redis, deps.chain));
  app.setReplySerializer((payload) => JSON.stringify(payload, jsonReplacer));
  setupErrors(app);

  await app.register(cors, {
    origin: [config.webUrl],
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });
  await setupSession(app);
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.max,
    timeWindow: '1 minute',
    redis: deps.redis,
    nameSpace: 'rl:',
    skipOnError: true,
    keyGenerator: (req) => (req.session?.userId ? `u:${req.session.userId}` : `ip:${clientIp(req)}`),
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: `Too many requests. Try again in ${ctx.after}.`,
    }),
  });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  await app.register(
    async (api) => {
      await systemRoutes(api);
      await authRoutes(api);
      await walletRoutes(api);
      await feedRoutes(api);
      await marketRoutes(api);
      await userRoutes(api);
      await messageRoutes(api);
      await notificationRoutes(api);
      await taskRoutes(api);
      await rankingRoutes(api);
      await battleRoutes(api);
    },
    { prefix: '/api' },
  );
  app.hub = await setupWs(app);
  app.addHook('onReady', () => syncTaskCatalogue(deps.prisma));
  return app;
}
