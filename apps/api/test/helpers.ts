import { Redis } from 'ioredis';
import { verifyMessage, type Hash } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { prisma, type KeyMarket, type User } from '@sway/db';
import { fanSubject, type Address } from '@sway/shared';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import type { ChainClient, Claimable, OnchainMarket, OperatorTxResult, TxInfo } from '../src/services/chain';
import { MemoryJobQueue } from '../src/services/jobs';
import { resetOfficialCache } from '../src/services/notify';
import { resetPriceMemo } from '../src/services/price';

export { prisma };

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.DATABASE_URL!,
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
  SESSION_SECRET: 'test-secret-test-secret-test-secret-1234',
  WEB_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:4000',
  DEV_AUTH: '1',
  CHAIN_ID: '31337',
  RPC_URL: 'http://127.0.0.1:1',
  SWAY_KEYS_ADDRESS: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  FAN_ESCROW_ADDRESS: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  ETH_USD_FALLBACK: '3420',
  RATE_LIMIT_MAX: '100000',
  RATE_LIMIT_AUTH_MAX: '100000',
  RATE_LIMIT_X_MAX: '100000',
  DEV_VERIFY_DELAY_MS: '0',
  SNAPSHOT_AT: '2026-10-27T15:00:00Z',
};

let txSeq = 1;
export const fakeHash = (): Hash => `0x${(txSeq++).toString(16).padStart(64, '0')}` as Hash;

/** In-memory ChainClient. Signatures are verified for real (viem), everything else is a map. */
export class FakeChain implements ChainClient {
  rpcEnabled = true;
  keysEnabled = true;
  operatorEnabled = true;
  readonly keys = new Map<string, bigint>();
  readonly eth = new Map<string, bigint>();
  readonly txs = new Map<string, TxInfo>();
  readonly markets = new Map<string, OnchainMarket>();
  readonly calls: Array<{ fn: string; args: unknown[] }> = [];
  claim: Claimable = { creator: 0n, holder: 0n, referral: 0n, protocol: 0n };
  balanceReads = 0;

  setKeys(subject: string, holder: string, units: bigint) {
    this.keys.set(`${subject.toLowerCase()}:${holder.toLowerCase()}`, units);
  }
  addTx(t: Omit<TxInfo, 'hash' | 'blockNumber'> & { hash?: Hash }): Hash {
    const hash = t.hash ?? fakeHash();
    this.txs.set(hash, {
      blockNumber: 1n,
      ...t,
      hash,
      from: t.from.toLowerCase() as Address,
      to: (t.to?.toLowerCase() as Address) ?? null,
    });
    return hash;
  }
  async getBalance(a: Address) {
    return this.eth.get(a.toLowerCase()) ?? 0n;
  }
  async getTransaction(h: Hash) {
    return this.txs.get(h) ?? null;
  }
  async waitForTx(h: Hash) {
    return this.txs.get(h) ?? null;
  }
  async verifyMessage(address: Address, message: string, signature: `0x${string}`) {
    return verifyMessage({ address, message, signature }).catch(() => false);
  }
  async keyBalances(pairs: Array<{ subject: Address; holder: Address }>) {
    this.balanceReads += pairs.length;
    return pairs.map((p) => this.keys.get(`${p.subject.toLowerCase()}:${p.holder.toLowerCase()}`) ?? 0n);
  }
  async claimable(account: Address, subjects: Address[]) {
    this.calls.push({ fn: 'claimable', args: [account, subjects] });
    return this.claim;
  }
  async market(subject: Address) {
    return this.markets.get(subject.toLowerCase()) ?? null;
  }
  async openMarket(owner: Address, xId: bigint): Promise<OperatorTxResult> {
    this.calls.push({ fn: 'openMarket', args: [owner, xId] });
    this.markets.set(owner.toLowerCase(), {
      owner: owner.toLowerCase() as Address,
      xId,
      fan: false,
      halted: false,
      supply: 100n,
    });
    this.setKeys(owner, owner, 100n);
    return { hash: fakeHash(), status: 'success' };
  }
  async claimFanMarket(subject: Address, newOwner: Address): Promise<OperatorTxResult> {
    this.calls.push({ fn: 'claimFanMarket', args: [subject, newOwner] });
    const m = this.markets.get(subject.toLowerCase());
    if (m) m.owner = newOwner.toLowerCase() as Address;
    return { hash: fakeHash(), status: 'success' };
  }
  async sendEth(to: Address, value: bigint): Promise<OperatorTxResult> {
    this.calls.push({ fn: 'sendEth', args: [to, value] });
    this.eth.set(to.toLowerCase(), (this.eth.get(to.toLowerCase()) ?? 0n) + value);
    return { hash: fakeHash(), status: 'success' };
  }
}

export interface TestCtx {
  app: BuiltApp;
  chain: FakeChain;
  jobs: MemoryJobQueue;
  redis: Redis;
  config: Config;
  close(): Promise<void>;
}

export async function makeApp(
  opts: { env?: Record<string, string>; chain?: FakeChain; xFetch?: typeof fetch } = {},
): Promise<TestCtx> {
  const config = loadConfig({ ...TEST_ENV, ...opts.env });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  const chain = opts.chain ?? new FakeChain();
  const jobs = new MemoryJobQueue();
  resetOfficialCache();
  resetPriceMemo();
  const app = await buildApp({ config, prisma, redis, chain, jobs, xFetch: opts.xFetch });
  await app.ready();
  return {
    app,
    chain,
    jobs,
    redis,
    config,
    async close() {
      await app.close();
      redis.disconnect();
    },
  };
}

const TABLES = [
  'PointsLedger',
  'TaskCompletion',
  'Notification',
  'DmMessage',
  'DmThread',
  'RoomMessage',
  'RoomRead',
  'Like',
  'Repost',
  'PostTag',
  'Post',
  'Follow',
  'Subscription',
  'BattleBacking',
  'Battle',
  'TreasuryEntry',
  'Stake',
  'EarningsClaim',
  'Activity',
  'GenesisEntry',
  'GenesisSnapshot',
  'LaunchToken',
  'ClaimRequest',
  'Referral',
  'Trade',
  'Holding',
  'KeyMarket',
  'Wallet',
  'User',
];

/** Empties the test database and Redis db 15. */
export async function resetState(redis?: Redis): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  if (redis) await redis.flushdb();
}

export const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }): string => {
  const c = res.cookies.find((x) => x.name === 'sway_sid');
  if (!c) throw new Error('no session cookie');
  return `sway_sid=${c.value}`;
};

export interface Member {
  cookie: string;
  user: User;
  account: PrivateKeyAccount;
  address: Address;
}

/** Dev sign-in; returns the session cookie and user row. */
export async function login(
  ctx: TestCtx,
  handle: string,
  followers?: number,
  ref?: string,
): Promise<{ cookie: string; user: User; me: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/dev',
    payload: { handle, followers, ref },
  });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  const user = await prisma.user.findUniqueOrThrow({ where: { handle } });
  return { cookie: cookieOf(res), user, me: res.json() };
}

/** Dev sign-in + linked wallet (direct DB row, the link route is tested on its own). */
export async function member(ctx: TestCtx, handle: string, followers = 5000): Promise<Member> {
  const { cookie, user } = await login(ctx, handle, followers);
  const account = privateKeyToAccount(generatePrivateKey());
  const address = account.address.toLowerCase() as Address;
  await prisma.wallet.create({ data: { userId: user.id, address, kind: 'external' } });
  return { cookie, user, account, address };
}

/** A member's own key market row (opened). */
export async function openMarketRow(m: Member, supply = 100n): Promise<KeyMarket> {
  return prisma.keyMarket.create({
    data: {
      subject: m.address,
      userId: m.user.id,
      xId: m.user.xId,
      claimed: true,
      opened: true,
      supplyUnits: supply,
      holders: 1,
    },
  });
}

/** Placeholder user + unclaimed fan market. */
export async function fanMarket(
  handle: string,
  xId: string,
  category: 'crypto' | 'football' | 'stocks' | 'rwa' = 'crypto',
): Promise<{ user: User; market: KeyMarket }> {
  const user = await prisma.user.create({
    data: { xId, handle, name: handle.toUpperCase(), followers: 100000, verified: true },
  });
  const market = await prisma.keyMarket.create({
    data: {
      subject: fanSubject(BigInt(xId)).toLowerCase(),
      userId: user.id,
      xId,
      fan: true,
      claimed: false,
      opened: true,
      category,
      supplyUnits: 300n,
      holders: 2,
    },
  });
  return { user, market };
}

export const json = <T = any>(res: { json: () => unknown }) => res.json() as T;
