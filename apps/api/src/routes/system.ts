import type { FastifyInstance } from 'fastify';
import type { ConfigDTO, PriceResponse } from '@sway/shared';
import type { Address } from '@sway/shared';
import { officialUserId } from '../services/notify';
import { getEthUsd } from '../services/price';

export async function systemRoutes(app: FastifyInstance) {
  const { config, redis, prisma } = app.deps;

  app.get('/config', async (): Promise<ConfigDTO> => {
    const { ethUsd } = await getEthUsd(redis, config.ethUsdFallback);
    const official = await officialUserId(prisma);
    const sway = official ? await prisma.launchToken.findUnique({ where: { userId: official }, select: { tokenAddress: true } }) : null;
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
      swayToken: (sway?.tokenAddress as Address | null | undefined) ?? null,
      /* [A] */
      faucetUrl: config.faucetUrl,
    };
  });

  app.get('/price', async (): Promise<PriceResponse> => getEthUsd(redis, config.ethUsdFallback));

  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));
}
