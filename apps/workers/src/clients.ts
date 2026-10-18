import { Redis } from 'ioredis';
import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient, type Account, type Chain, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { prisma } from '@sway/db';
import { BUS_CHANNEL, swayChain, type BusEvent } from '@sway/shared';
import type { WorkerConfig } from './config';

export interface Clients {
  cfg: WorkerConfig;
  prisma: typeof prisma;
  redis: Redis;
  chain: Chain;
  pub: PublicClient<Transport, Chain>;
  operator: WalletClient<Transport, Chain, Account> | null;
  issuer: WalletClient<Transport, Chain, Account> | null;
  publish(e: BusEvent): Promise<void>;
  ethUsd(): Promise<number>;
}

export const PRICE_KEY = 'price:ethusd';

export function makeClients(cfg: WorkerConfig, redis?: Redis): Clients {
  const r = redis ?? new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const chain = swayChain({ chainId: cfg.chainId, rpcUrl: cfg.rpcUrl, explorerUrl: cfg.explorerUrl });
  const transport = http(cfg.rpcUrl, { retryCount: 3 });
  // Local anvil mines every second; poll receipts fast there.
  const pollingInterval = cfg.chainId === 31337 ? 250 : 2_000;
  const pub = createPublicClient({ chain, transport, pollingInterval }) as PublicClient<Transport, Chain>;
  const wallet = (key: `0x${string}` | null) =>
    key ? createWalletClient({ chain, transport, account: privateKeyToAccount(key), pollingInterval }) : null;
  return {
    cfg,
    prisma,
    redis: r,
    chain,
    pub,
    operator: wallet(cfg.operatorKey),
    issuer: wallet(cfg.issuerKey),
    async publish(e) {
      await r.publish(BUS_CHANNEL, JSON.stringify(e));
    },
    async ethUsd() {
      const v = Number(await r.get(PRICE_KEY));
      return Number.isFinite(v) && v > 0 ? v : cfg.ethUsdFallback;
    },
  };
}
