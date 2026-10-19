import { ROBINHOOD_MAINNET_ID } from '@sway/shared';
import type { Address, Hex } from 'viem';

const str = (k: string, d = ''): string => (process.env[k] ?? d).trim();
const num = (k: string, d: number): number => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : Number(v);
};
const addrOrNull = (k: string): Address | null => {
  const v = str(k);
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null;
};
const keyOrNull = (k: string): Hex | null => {
  const v = str(k);
  return /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : null;
};

export interface WorkerConfig {
  redisUrl: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  contracts: {
    swayKeys: Address | null;
    fanEscrow: Address | null;
    swayStaking: Address | null;
    genesisPass: Address | null;
    launchpad: Address | null;
    drops: Address | null;
  };
  operatorKey: Hex | null;
  issuerKey: Hex | null;
  indexer: { startBlock: bigint; confirmations: number; pollMs: number; batchBlocks: number };
  ethUsdFeedUrl: string;
  ethUsdFallback: number;
  snapshotAt: Date;
  genesisMinScore: number;
  /** $SWAY units for the Genesis pool (5% of supply). Placeholder until the token supply is final. */
  genesisPoolUnits: bigint;
  genesisListBaseUrl: string;
  xBearer: string;
  devAuth: boolean;
  launchPostId: string;
  webUrl: string;
  /** VAPID keys for web push; null = push off. */
  push: { publicKey: string; privateKey: string; subject: string } | null;
  /** host:port receivers allowed besides the browser push services (local tests only). */
  pushDevHosts: string[];
}

export function loadConfig(): WorkerConfig {
  const chainId = num('CHAIN_ID', 31337);
  if (chainId === ROBINHOOD_MAINNET_ID && str('SWAY_ENABLE_MAINNET') !== '1') {
    throw new Error('Refusing to run against Robinhood Chain mainnet: contracts are unaudited (set SWAY_ENABLE_MAINNET=1 after the audit).');
  }
  return {
    redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
    chainId,
    rpcUrl: str('RPC_URL', 'http://127.0.0.1:8545'),
    explorerUrl: str('EXPLORER_URL'),
    contracts: {
      swayKeys: addrOrNull('SWAY_KEYS_ADDRESS'),
      fanEscrow: addrOrNull('FAN_ESCROW_ADDRESS'),
      swayStaking: addrOrNull('SWAY_STAKING_ADDRESS'),
      genesisPass: addrOrNull('GENESIS_PASS_ADDRESS'),
      launchpad: addrOrNull('LAUNCHPAD_ADDRESS'),
      drops: addrOrNull('DROPS_ADDRESS'),
    },
    operatorKey: keyOrNull('OPERATOR_PRIVATE_KEY'),
    issuerKey: keyOrNull('ISSUER_PRIVATE_KEY'),
    indexer: {
      startBlock: BigInt(num('INDEXER_START_BLOCK', 0)),
      confirmations: num('INDEXER_CONFIRMATIONS', chainId === 31337 ? 0 : 2),
      pollMs: num('INDEXER_POLL_MS', chainId === 31337 ? 1000 : 4000),
      batchBlocks: num('INDEXER_BATCH_BLOCKS', 2000),
    },
    ethUsdFeedUrl: str('ETH_USD_FEED_URL'),
    ethUsdFallback: num('ETH_USD_FALLBACK', 3420),
    snapshotAt: new Date(str('SNAPSHOT_AT', '2026-10-27T15:00:00Z')),
    genesisMinScore: num('GENESIS_MIN_SCORE', 10),
    genesisPoolUnits: BigInt(str('GENESIS_POOL_UNITS', (50_000_000n * 10n ** 18n).toString())),
    genesisListBaseUrl: str('GENESIS_LIST_URL', `${str('WEB_URL', 'http://localhost:3000')}/genesis/list`),
    xBearer: str('X_BEARER_TOKEN'),
    devAuth: str('DEV_AUTH') === '1' && process.env.NODE_ENV !== 'production',
    launchPostId: str('X_LAUNCH_POST_ID'),
    webUrl: str('WEB_URL', 'http://localhost:3000'),
    push:
      str('VAPID_PUBLIC_KEY') && str('VAPID_PRIVATE_KEY')
        ? { publicKey: str('VAPID_PUBLIC_KEY'), privateKey: str('VAPID_PRIVATE_KEY'), subject: str('VAPID_SUBJECT', 'mailto:ops@swayfamily.com') }
        : null,
    pushDevHosts: process.env.NODE_ENV === 'production' ? [] : str('PUSH_DEV_HOSTS').split(',').map((h) => h.trim()).filter(Boolean),
  };
}
