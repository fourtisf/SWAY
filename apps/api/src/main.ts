import { Redis } from 'ioredis';
import { prisma } from '@sway/db';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { ViemChainClient } from './services/chain';
import { BullJobQueue } from './services/jobs';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`[sway-api] ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: false });
  const chain = new ViemChainClient(config, redis);
  const jobs = new BullJobQueue(config.redisUrl);
  const app = await buildApp({ config, prisma, redis, chain, jobs });

  if (!chain.keysEnabled)
    app.log.warn('SWAY_KEYS_ADDRESS is empty: no holder room access, zero earnings, market opens are no-ops');
  else if (!chain.operatorEnabled)
    app.log.warn('OPERATOR_PRIVATE_KEY is empty: markets cannot be opened or claimed onchain');
  if (config.devAuth)
    app.log.warn('DEV_AUTH is on: POST /api/auth/dev signs anyone in. Never enable it in production.');

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await jobs.close();
      await prisma.$disconnect();
      redis.disconnect();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
