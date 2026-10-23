import type { FastifyInstance } from 'fastify';
import type { Address, ConfigDTO, PriceResponse } from '@sway/shared';
import { launchChainOf, tokenAddressOf } from '../services/launch';
import { officialUserId } from '../services/notify';
import { getEthUsd } from '../services/price';

let swayCache: { token: Address | null; at: number } | null = null;
export const resetSwayTokenCache = () => {
  swayCache = null;
};

export async function systemRoutes(app: FastifyInstance) {
  const { config, redis, prisma } = app.deps;

  /**
   * The official account's launched token: the mirror's, else the launchpad's tokenOf (the mirror can lag).
   * Null until SWAY_TOKEN_PUBLIC=1, so the site says "Coming soon" before the launch is announced.
   */
  const swayToken = async (): Promise<Address | null> => {
    if (!config.swayTokenPublic) return null;
    if (swayCache && (swayCache.token || Date.now() - swayCache.at < 30_000)) return swayCache.token;
    const official = await officialUserId(prisma);
    const user = official
      ? await prisma.user.findUnique({ where: { id: official }, select: { launchToken: true, wallet: { select: { address: true } } } })
      : null;
    const token = user ? await tokenAddressOf(launchChainOf(app), user.launchToken, user.wallet?.address ?? null).catch(() => undefined) : null;
    if (token === undefined) return null; // the chain can't say right now: ask again next time
    swayCache = { token, at: Date.now() };
    return token;
  };

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
      swayToken: await swayToken(),
      /* [A] */
      faucetUrl: config.faucetUrl,
      parentChain: config.chain.parent,
    };
  });

  app.get('/price', async (): Promise<PriceResponse> => getEthUsd(redis, config.ethUsdFallback));

  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));
}
