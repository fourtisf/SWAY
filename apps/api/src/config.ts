/**
 * Environment, validated with zod (see /.env.example). Fails fast on bad values and refuses Robinhood Chain
 * mainnet unless SWAY_ENABLE_MAINNET=1: the contracts are unaudited (brief §12).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BOOST_USD_DEFAULT,
  LOCAL_CHAIN_ID,
  normalizeHandle,
  ROBINHOOD_MAINNET_ID,
  swayChain,
} from '@sway/shared';
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
  DROPS_ADDRESS: optAddr,
  OPERATOR_PRIVATE_KEY: z.preprocess(
    blank,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex key')
      .optional(),
  ),

  /** Web push: browsers get the public key; the workers sign with the private one. */
  VAPID_PUBLIC_KEY: optStr,
  /** host:port push receivers allowed besides the browser push services (local tests only). */
  PUSH_DEV_HOSTS: optStr,

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

  /* [B] social, moderation, account & admin */
  /** Where post images are stored (default <repo>/uploads). */
  UPLOAD_DIR: optStr,
  /** Price of a 24h post boost in USD. */
  BOOST_USD: num(BOOST_USD_DEFAULT),
  /** Boost payments go here; defaults to SwayKeys.treasury(). */
  TREASURY_ADDRESS: optAddr,
  /** Comma-separated X handles made admins at every sign-in. */
  ADMIN_HANDLES: optStr,

  /* [A] wallets & funding */
  /** Wei the operator sends once to a qualifying member's account wallet on a non-local chain. 0 = off. */
  GAS_DRIP_WEI: z.preprocess(blank, z.string().trim().regex(/^\d{1,30}$/, 'must be a wei amount').default('0')),
  /** Testnet faucet page shown in the Deposit modal. */
  FAUCET_URL: z.preprocess(blank, z.string().url().optional()),
  /** Telegram group for the "Join the Telegram" task (its Join button). */
  TELEGRAM_URL: z.preprocess(blank, z.string().url().optional()),
  /**
   * 1 = the operator pays to open each member's market, claim fan markets and set referrers at sign-up.
   * Default 0: the operator only signs permits and the first buyer's transaction carries them.
   */
  SPONSOR_ONBOARDING: flag,
  /**
   * 1 = show the token @swaydotfamily launched as $SWAY: its CA on the site, its token page and its airdrop.
   * Default 0 keeps it off the site until the team announces it (the owner still sees it on /launchpad).
   */
  SWAY_TOKEN_PUBLIC: flag,
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
    drops: Address | null;
  };
  operatorKey: `0x${string}` | null;
  push: { publicKey: string | null; devHosts: string[] };
  wallets: { embedded: 'privy' | 'cdp' | 'burner' | 'off'; walletConnectProjectId: string | null };
  ethUsdFallback: number;
  snapshotAt: Date;
  genesisMinScore: number;
  rateLimit: { max: number; authMax: number; xMax: number };
  devVerifyDelayMs: number;
  /* [B] */
  uploadDir: string;
  boostUsd: number;
  treasury: Address | null;
  adminHandles: string[];
  /* [A] */
  gasDripWei: bigint;
  faucetUrl: string | null;
  telegramUrl: string | null;
  sponsorOnboarding: boolean;
  swayTokenPublic: boolean;
}

export class ConfigError extends Error {}

/** The pnpm workspace root (dev runs from apps/api, builds from apps/api/dist). */
function repoRoot(): string {
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

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
      drops: lower(e.DROPS_ADDRESS),
    },
    operatorKey: (e.OPERATOR_PRIVATE_KEY as `0x${string}` | undefined) ?? null,
    push: {
      publicKey: e.VAPID_PUBLIC_KEY ?? null,
      devHosts: e.NODE_ENV === 'production' ? [] : (e.PUSH_DEV_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    },
    wallets: {
      // The burner keeps its key in browser storage: fine for testnets, not for real funds.
      embedded: e.CHAIN_ID === ROBINHOOD_MAINNET_ID && e.EMBEDDED_WALLET_PROVIDER === 'burner' ? 'off' : e.EMBEDDED_WALLET_PROVIDER,
      walletConnectProjectId: e.WALLETCONNECT_PROJECT_ID ?? null,
    },
    ethUsdFallback: e.ETH_USD_FALLBACK,
    snapshotAt: new Date(e.SNAPSHOT_AT),
    genesisMinScore: e.GENESIS_MIN_SCORE,
    rateLimit: { max: e.RATE_LIMIT_MAX, authMax: e.RATE_LIMIT_AUTH_MAX, xMax: e.RATE_LIMIT_X_MAX },
    devVerifyDelayMs: e.DEV_VERIFY_DELAY_MS,
    /* [B] */
    uploadDir: path.resolve(e.UPLOAD_DIR ?? path.join(repoRoot(), 'uploads')),
    boostUsd: e.BOOST_USD,
    treasury: lower(e.TREASURY_ADDRESS),
    adminHandles: (e.ADMIN_HANDLES ?? '')
      .split(',')
      .map((h) => normalizeHandle(h))
      .filter(Boolean),
    /* [A] */
    gasDripWei: BigInt(e.GAS_DRIP_WEI),
    faucetUrl: e.FAUCET_URL ?? null,
    telegramUrl: e.TELEGRAM_URL ?? null,
    sponsorOnboarding: e.SPONSOR_ONBOARDING,
    swayTokenPublic: e.SWAY_TOKEN_PUBLIC,
  };
}
