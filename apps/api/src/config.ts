/**
 * Environment, validated with zod (see /.env.example). Fails fast on bad values and refuses Robinhood Chain
 * mainnet unless SWAY_ENABLE_MAINNET=1: the contracts are unaudited (brief §12).
 */
import { z } from 'zod';
import { LOCAL_CHAIN_ID, ROBINHOOD_MAINNET_ID, swayChain } from '@sway/shared';
import type { Address } from '@sway/shared';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optStr = z.preprocess(blank, z.string().trim().optional());
const optAddr = z.preprocess(
  blank,
  z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address')
    .optional(),
);
const flag = z
  .preprocess(blank, z.enum(['0', '1', 'true', 'false']).optional())
  .transform((v) => v === '1' || v === 'true');
const num = (def: number) => z.preprocess(blank, z.coerce.number().default(def));

const EnvSchema = z.object({
  NODE_ENV: z.preprocess(blank, z.enum(['development', 'test', 'production']).default('development')),
  LOG_LEVEL: z.preprocess(
    blank,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  ),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.preprocess(blank, z.string().default('redis://localhost:6379')),
  API_PORT: num(4000),
  API_HOST: z.preprocess(blank, z.string().default('0.0.0.0')),
  API_URL: z.preprocess(blank, z.string().url().default('http://localhost:4000')),
  WEB_URL: z.preprocess(blank, z.string().url().default('http://localhost:3000')),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),

  X_CLIENT_ID: optStr,
  X_CLIENT_SECRET: optStr,
  X_BEARER_TOKEN: optStr,
  X_CALLBACK_URL: optStr,
  /** Id of the official launch post that the 'repost' task checks. Optional: without it the task is queued. */
  X_LAUNCH_POST_ID: optStr,
  DEV_AUTH: flag,

  CHAIN_ID: num(LOCAL_CHAIN_ID),
  CHAIN_NAME: optStr,
  RPC_URL: z.preprocess(blank, z.string().default('http://127.0.0.1:8545')),
  /** RPC URL handed to browsers (defaults to RPC_URL). */
  PUBLIC_RPC_URL: optStr,
  EXPLORER_URL: optStr,
  SWAY_ENABLE_MAINNET: flag,
  MULTICALL3_ADDRESS: optAddr,

  SWAY_KEYS_ADDRESS: optAddr,
  SWAY_STAKING_ADDRESS: optAddr,
  GENESIS_PASS_ADDRESS: optAddr,
  FAN_ESCROW_ADDRESS: optAddr,
  LAUNCHPAD_ADDRESS: optAddr,
  OPERATOR_PRIVATE_KEY: z.preprocess(
    blank,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex key')
      .optional(),
  ),

  EMBEDDED_WALLET_PROVIDER: z.preprocess(blank, z.enum(['privy', 'cdp', 'burner']).default('burner')),
  WALLETCONNECT_PROJECT_ID: optStr,

  ETH_USD_FALLBACK: num(3420),
  SNAPSHOT_AT: z.preprocess(blank, z.string().datetime({ offset: true }).default('2026-10-27T15:00:00Z')),
  GENESIS_MIN_SCORE: num(10),

  /** Requests per minute per client (session or IP) across the API. */
  RATE_LIMIT_MAX: num(600),
  /** Requests per minute per client on auth routes. */
  RATE_LIMIT_AUTH_MAX: num(20),
  /** Requests per minute per client on X-backed routes (task verify). */
  RATE_LIMIT_X_MAX: num(10),
  /** Delay before a dev user's task is marked verified (DEV_AUTH only). */
  DEV_VERIFY_DELAY_MS: num(1200),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  env: Env['NODE_ENV'];
  isProd: boolean;
  logLevel: string;
  redisUrl: string;
  port: number;
  host: string;
  apiUrl: string;
  webUrl: string;
  /** Cookie `secure` flag: on when the web app is served over https. */
  secureCookies: boolean;
  sessionSecret: string;
  x: {
    clientId: string | null;
    clientSecret: string | null;
    bearerToken: string | null;
    callbackUrl: string;
    launchPostId: string | null;
    enabled: boolean;
  };
  devAuth: boolean;
  chain: {
    id: number;
    name: string;
    rpcUrl: string;
    publicRpcUrl: string;
    explorerUrl: string;
    isLocal: boolean;
    isMainnet: boolean;
    multicall3: Address | null;
  };
  contracts: {
    swayKeys: Address | null;
    swayStaking: Address | null;
    genesisPass: Address | null;
    fanEscrow: Address | null;
    launchpad: Address | null;
  };
  operatorKey: `0x${string}` | null;
  wallets: { embedded: 'privy' | 'cdp' | 'burner'; walletConnectProjectId: string | null };
  ethUsdFallback: number;
  snapshotAt: Date;
  genesisMinScore: number;
  rateLimit: { max: number; authMax: number; xMax: number };
  devVerifyDelayMs: number;
}

export class ConfigError extends Error {}

const DEFAULT_SECRET = 'change-me-to-a-long-random-string';
const lower = (a?: string): Address | null => (a ? (a.toLowerCase() as Address) : null);

export function loadConfig(
  raw: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Config {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';

  if (e.CHAIN_ID === ROBINHOOD_MAINNET_ID && !e.SWAY_ENABLE_MAINNET) {
    throw new ConfigError(
      `Refusing to start on Robinhood Chain mainnet (chain ${ROBINHOOD_MAINNET_ID}): the Sway contracts are unaudited. ` +
        'Set SWAY_ENABLE_MAINNET=1 only after the audit report is published.',
    );
  }
  if (isProd && (e.SESSION_SECRET.length < 32 || e.SESSION_SECRET === DEFAULT_SECRET)) {
    throw new ConfigError('SESSION_SECRET must be a random string of at least 32 characters in production');
  }

  const chain = swayChain({
    chainId: e.CHAIN_ID,
    rpcUrl: e.RPC_URL,
    explorerUrl: e.EXPLORER_URL,
    name: e.CHAIN_NAME,
  });
  const isLocal = e.CHAIN_ID === LOCAL_CHAIN_ID;
  return {
    env: e.NODE_ENV,
    isProd,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    redisUrl: e.REDIS_URL,
    port: e.API_PORT,
    host: e.API_HOST,
    apiUrl: e.API_URL.replace(/\/$/, ''),
    webUrl: e.WEB_URL.replace(/\/$/, ''),
    secureCookies: e.WEB_URL.startsWith('https://'),
    sessionSecret: e.SESSION_SECRET,
    x: {
      clientId: e.X_CLIENT_ID ?? null,
      clientSecret: e.X_CLIENT_SECRET ?? null,
      bearerToken: e.X_BEARER_TOKEN ?? null,
      callbackUrl: e.X_CALLBACK_URL ?? `${e.WEB_URL.replace(/\/$/, '')}/api/auth/x/callback`,
      launchPostId: e.X_LAUNCH_POST_ID ?? null,
      enabled: !!e.X_CLIENT_ID,
    },
    devAuth: e.DEV_AUTH && !isProd,
    chain: {
      id: e.CHAIN_ID,
      name: chain.name,
      rpcUrl: e.RPC_URL,
      publicRpcUrl: e.PUBLIC_RPC_URL ?? e.RPC_URL,
      explorerUrl: chain.blockExplorers?.default.url ?? '',
      isLocal,
      isMainnet: e.CHAIN_ID === ROBINHOOD_MAINNET_ID,
      multicall3: lower(e.MULTICALL3_ADDRESS),
    },
    contracts: {
      swayKeys: lower(e.SWAY_KEYS_ADDRESS),
      swayStaking: lower(e.SWAY_STAKING_ADDRESS),
      genesisPass: lower(e.GENESIS_PASS_ADDRESS),
      fanEscrow: lower(e.FAN_ESCROW_ADDRESS),
      launchpad: lower(e.LAUNCHPAD_ADDRESS),
    },
    operatorKey: (e.OPERATOR_PRIVATE_KEY as `0x${string}` | undefined) ?? null,
    wallets: {
      embedded: e.EMBEDDED_WALLET_PROVIDER,
      walletConnectProjectId: e.WALLETCONNECT_PROJECT_ID ?? null,
    },
    ethUsdFallback: e.ETH_USD_FALLBACK,
    snapshotAt: new Date(e.SNAPSHOT_AT),
    genesisMinScore: e.GENESIS_MIN_SCORE,
    rateLimit: { max: e.RATE_LIMIT_MAX, authMax: e.RATE_LIMIT_AUTH_MAX, xMax: e.RATE_LIMIT_X_MAX },
    devVerifyDelayMs: e.DEV_VERIFY_DELAY_MS,
  };
}
