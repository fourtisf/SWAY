import type { FastifyInstance } from 'fastify';
import type { ConfigDTO, PriceResponse } from '@sway/shared';
import { getEthUsd } from '../services/price';

export async function systemRoutes(app: FastifyInstance) {
  const { config, redis } = app.deps;

  app.get('/config', async (): Promise<ConfigDTO> => {
    const { ethUsd } = await getEthUsd(redis, config.ethUsdFallback);
    return {
      chainId: config.chain.id,
      chainName: config.chain.name,
      rpcUrl: config.chain.publicRpcUrl,
      explorerUrl: config.chain.explorerUrl,
      contracts: config.contracts,
      ethUsd,
      snapshotAt: config.snapshotAt.toISOString(),
      auth: { x: config.x.enabled, dev: config.devAuth },
      wallets: config.wallets,
      mainnet: config.chain.isMainnet,
    };
  });

  app.get('/price', async (): Promise<PriceResponse> => getEthUsd(redis, config.ethUsdFallback));

  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));
}
