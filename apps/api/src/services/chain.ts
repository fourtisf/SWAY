/**
 * Everything the API reads from or sends to the chain goes through ChainClient, so tests inject a fake and the
 * API degrades gracefully without deployed contracts:
 * - rpcEnabled false: balances read as 0, transactions cannot be verified.
 * - keysEnabled false (SWAY_KEYS_ADDRESS empty): no holder room access, zero earnings, market open is a no-op.
 * - operatorEnabled false (no OPERATOR_PRIVATE_KEY): markets cannot be opened or claimed onchain.
 *
 * Operator transactions are serialized across every API (and worker) process with the Redis lock
 * OPERATOR_LOCK_KEY, held from simulation until the receipt, so nonces never collide.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  verifyMessage as verifyEoaMessage,
  type Chain,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { swayChain, type Address } from '@sway/shared';
import { swayKeysAbi } from '@sway/shared/abi';
import type { Config } from '../config';

export const OPERATOR_LOCK_KEY = 'lock:operator';
const CANONICAL_MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11' as Address;

export interface OnchainMarket {
  owner: Address;
  xId: bigint;
  fan: boolean;
  halted: boolean;
  supply: bigint;
}

export interface Claimable {
  creator: bigint;
  holder: bigint;
  referral: bigint;
  protocol: bigint;
}

export interface TxInfo {
  hash: Hash;
  from: Address;
  to: Address | null;
  value: bigint;
  status: 'pending' | 'success' | 'reverted';
  blockNumber: bigint | null;
}

export interface OperatorTxResult {
  hash: Hash;
  /** 'pending' when the receipt did not arrive within the wait budget. */
  status: 'success' | 'reverted' | 'pending';
}

export class ChainError extends Error {
  constructor(
    message: string,
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = 'ChainError';
  }
}

export interface ChainClient {
  readonly rpcEnabled: boolean;
  readonly keysEnabled: boolean;
  readonly operatorEnabled: boolean;
  getBalance(address: Address): Promise<bigint>;
  getTransaction(hash: Hash): Promise<TxInfo | null>;
  /** Waits for a receipt; null when the tx is unknown or still pending after timeoutMs. */
  waitForTx(hash: Hash, timeoutMs?: number): Promise<TxInfo | null>;
  /** EOA signatures, plus ERC-1271/6492 smart wallets when the RPC is available. */
  verifyMessage(address: Address, message: string, signature: `0x${string}`): Promise<boolean>;
  /** SwayKeys.balanceOf for many (subject, holder) pairs; multicall when available. */
  keyBalances(pairs: Array<{ subject: Address; holder: Address }>): Promise<bigint[]>;
  claimable(account: Address, subjects: Address[]): Promise<Claimable>;
  market(subject: Address): Promise<OnchainMarket | null>;
  openMarket(owner: Address, xId: bigint): Promise<OperatorTxResult>;
  claimFanMarket(subject: Address, newOwner: Address): Promise<OperatorTxResult>;
  /** Dev faucet: operator sends ETH. */
  sendEth(to: Address, value: bigint): Promise<OperatorTxResult>;
  /* [B] */
  /** SwayKeys.treasury(), where boost payments go; null without contracts. */
  treasury(): Promise<Address | null>;
  /** Fan admin writes (the operator is fan admin on local chains): takedowns and admin-opened fan markets. */
  setMarketHalted(subject: Address, halted: boolean): Promise<OperatorTxResult>;
  openFanMarket(xId: bigint): Promise<OperatorTxResult>;
}

export class ChainUnavailable extends ChainError {
  constructor(what: string) {
    super(`${what} is not available: chain not configured`, 'unavailable');
    this.name = 'ChainUnavailable';
  }
}

/* ------------------------------------------------------------------ redis lock */

const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export async function withRedisLock<T>(
  redis: Redis,
  key: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; waitMs?: number } = {},
): Promise<T> {
  const token = randomUUID();
  const ttl = opts.ttlMs ?? 90_000;
  const deadline = Date.now() + (opts.waitMs ?? 60_000);
  for (;;) {
    const ok = await redis.set(key, token, 'PX', ttl, 'NX');
    if (ok === 'OK') break;
    if (Date.now() > deadline) throw new ChainError(`Timed out waiting for ${key}`, 'lock_timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE_LUA, 1, key, token).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ viem implementation */

function revertReason(e: unknown): string | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? null;
    return e.shortMessage;
  }
  return null;
}

export class ViemChainClient implements ChainClient {
  readonly rpcEnabled: boolean;
  readonly keysEnabled: boolean;
  readonly operatorEnabled: boolean;
  private readonly chain: Chain;
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient | null;
  private readonly account: PrivateKeyAccount | null;
  private readonly keys: Address | null;
  private multicallOk: boolean;

  constructor(
    private readonly config: Config,
    private readonly redis: Redis,
  ) {
    this.rpcEnabled = !!config.chain.rpcUrl;
    this.keys = config.contracts.swayKeys;
    this.keysEnabled = this.rpcEnabled && !!this.keys;
    const multicall = config.chain.multicall3 ?? (config.chain.isLocal ? null : CANONICAL_MULTICALL3);
    this.multicallOk = !!multicall;
    const base = swayChain({
      chainId: config.chain.id,
      rpcUrl: config.chain.rpcUrl,
      explorerUrl: config.chain.explorerUrl,
      name: config.chain.name,
    });
    this.chain = multicall ? { ...base, contracts: { multicall3: { address: multicall } } } : base;
    const transport = http(config.chain.rpcUrl, { timeout: 10_000, retryCount: 1 });
    this.pub = createPublicClient({ chain: this.chain, transport }) as PublicClient;
    this.account = config.operatorKey ? privateKeyToAccount(config.operatorKey) : null;
    this.wallet = this.account
      ? createWalletClient({ chain: this.chain, transport, account: this.account })
      : null;
    this.operatorEnabled = this.keysEnabled && !!this.account;
  }

  get operatorAddress(): Address | null {
    return (this.account?.address.toLowerCase() as Address) ?? null;
  }

  async getBalance(address: Address): Promise<bigint> {
    if (!this.rpcEnabled) return 0n;
    return this.pub.getBalance({ address });
  }

  async getTransaction(hash: Hash): Promise<TxInfo | null> {
    if (!this.rpcEnabled) throw new ChainUnavailable('Transaction lookup');
    let tx;
    try {
      tx = await this.pub.getTransaction({ hash });
    } catch {
      return null;
    }
    let status: TxInfo['status'] = 'pending';
    if (tx.blockNumber !== null) {
      const r = await this.pub.getTransactionReceipt({ hash }).catch(() => null);
      status = r ? r.status : 'pending';
    }
    return {
      hash,
      from: tx.from.toLowerCase() as Address,
      to: (tx.to?.toLowerCase() as Address) ?? null,
      value: tx.value,
      status,
      blockNumber: tx.blockNumber,
    };
  }

  async waitForTx(hash: Hash, timeoutMs = 20_000): Promise<TxInfo | null> {
    if (!this.rpcEnabled) throw new ChainUnavailable('Transaction lookup');
    try {
      await this.pub.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 500 });
    } catch {
      /* fall through to a plain lookup */
    }
    return this.getTransaction(hash);
  }

  async verifyMessage(address: Address, message: string, signature: `0x${string}`): Promise<boolean> {
    const eoa = await verifyEoaMessage({ address, message, signature }).catch(() => false);
    if (eoa || !this.rpcEnabled) return eoa;
    return this.pub.verifyMessage({ address, message, signature }).catch(() => false);
  }

  async keyBalances(pairs: Array<{ subject: Address; holder: Address }>): Promise<bigint[]> {
    if (!this.keysEnabled || pairs.length === 0) return pairs.map(() => 0n);
    const contracts = pairs.map((p) => ({
      address: this.keys!,
      abi: swayKeysAbi,
      functionName: 'balanceOf' as const,
      args: [p.subject, p.holder] as const,
    }));
    if (this.multicallOk && pairs.length > 1) {
      try {
        const res = await this.pub.multicall({ contracts, allowFailure: false });
        return res.map((v) => v as bigint);
      } catch {
        this.multicallOk = false; // Multicall3 is not deployed on this chain; read one by one from now on.
      }
    }
    return Promise.all(contracts.map((c) => this.pub.readContract(c) as Promise<bigint>));
  }

  async claimable(account: Address, subjects: Address[]): Promise<Claimable> {
    if (!this.keysEnabled) return { creator: 0n, holder: 0n, referral: 0n, protocol: 0n };
    const [creator, holder, referral, protocol] = (await this.pub.readContract({
      address: this.keys!,
      abi: swayKeysAbi,
      functionName: 'claimable',
      args: [account, subjects],
    })) as readonly [bigint, bigint, bigint, bigint];
    return { creator, holder, referral, protocol };
  }

  async market(subject: Address): Promise<OnchainMarket | null> {
    if (!this.keysEnabled) return null;
    const r = (await this.pub.readContract({
      address: this.keys!,
      abi: swayKeysAbi,
      functionName: 'markets',
      args: [subject],
    })) as readonly [Address, bigint, number, number, boolean, boolean, bigint, bigint];
    const [owner, xId, , , fan, halted, supply] = r;
    if (supply === 0n) return null;
    return { owner: owner.toLowerCase() as Address, xId, fan, halted, supply };
  }

  private async operatorWrite(
    functionName: 'openMarket' | 'claimFanMarket' | 'setMarketHalted' | 'openFanMarket',
    args:
      | readonly [Address, bigint]
      | readonly [Address, Address]
      | readonly [Address, boolean]
      | readonly [bigint],
  ): Promise<OperatorTxResult> {
    if (!this.operatorEnabled || !this.wallet || !this.account) throw new ChainUnavailable('Operator');
    return withRedisLock(this.redis, OPERATOR_LOCK_KEY, async () => {
      let request;
      try {
        ({ request } = await this.pub.simulateContract({
          address: this.keys!,
          abi: swayKeysAbi,
          functionName,
          args: args as never,
          account: this.account!,
        }));
      } catch (e) {
        const reason = revertReason(e);
        throw new ChainError(`${functionName} would revert${reason ? `: ${reason}` : ''}`, reason);
      }
      const hash = await this.wallet!.writeContract(request as never);
      return this.receipt(hash);
    });
  }

  private async receipt(hash: Hash): Promise<OperatorTxResult> {
    try {
      const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 500 });
      return { hash, status: r.status };
    } catch {
      return { hash, status: 'pending' };
    }
  }

  openMarket(owner: Address, xId: bigint): Promise<OperatorTxResult> {
    return this.operatorWrite('openMarket', [owner, xId] as const);
  }

  claimFanMarket(subject: Address, newOwner: Address): Promise<OperatorTxResult> {
    return this.operatorWrite('claimFanMarket', [subject, newOwner] as const);
  }

  /* [B] */
  async treasury(): Promise<Address | null> {
    if (!this.keysEnabled) return null;
    const t = (await this.pub.readContract({
      address: this.keys!,
      abi: swayKeysAbi,
      functionName: 'treasury',
    })) as Address;
    return /^0x0{40}$/i.test(t) ? null : (t.toLowerCase() as Address);
  }

  setMarketHalted(subject: Address, halted: boolean): Promise<OperatorTxResult> {
    return this.operatorWrite('setMarketHalted', [subject, halted] as const);
  }

  openFanMarket(xId: bigint): Promise<OperatorTxResult> {
    return this.operatorWrite('openFanMarket', [xId] as const);
  }

  async sendEth(to: Address, value: bigint): Promise<OperatorTxResult> {
    if (!this.rpcEnabled || !this.wallet || !this.account) throw new ChainUnavailable('Operator');
    return withRedisLock(this.redis, OPERATOR_LOCK_KEY, async () => {
      const hash = await this.wallet!.sendTransaction({
        to,
        value,
        account: this.account!,
        chain: this.chain,
      });
      return this.receipt(hash);
    });
  }
}
