/**
 * Chain access for the launchpad, staking and the $SWAY dev faucet. Kept apart from ChainClient so tests
 * inject a fake (AppDeps.launchChain) and the rest of the API is untouched when these contracts are absent.
 * The operator's $SWAY transfers share OPERATOR_LOCK_KEY with every other operator transaction.
 */
import type { Redis } from 'ioredis';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { isZeroAddress, swayChain, type Address } from '@sway/shared';
import { swayLaunchpadAbi, swayStakingAbi } from '@sway/shared/abi';
import type { Config } from '../config';
import { ChainUnavailable, OPERATOR_LOCK_KEY, withRedisLock, type OperatorTxResult } from './chain';

export interface LaunchMessage {
  creator: Address;
  name: string;
  symbol: string;
  startCapWei: bigint;
  graduationCapWei: bigint;
  airdropRoot: Hex;
  deadline: bigint;
}

export interface OnchainCurve {
  creator: Address;
  virtualEth: bigint;
  ethReserve: bigint;
  tokenReserve: bigint;
  graduationCapWei: bigint;
  airdropRoot: Hex;
  graduated: boolean;
  migrated: boolean;
}

export interface OnchainStaking {
  token: Address;
  balance: bigint;
  allowance: bigint;
  staked: bigint;
  unstaking: bigint;
  /** Unix seconds, 0 when nothing is cooling down. */
  unlockAt: number;
  level: number;
  thresholds: bigint[];
  pendingRewards: bigint;
  totalStaked: bigint;
  /** Latest block timestamp (unix seconds), to compare with unlockAt in chain time. */
  blockTime: number;
}

export interface LaunchChain {
  readonly launchpad: Address | null;
  readonly staking: Address | null;
  /** RPC and SwayLaunchpad configured. */
  readonly launchEnabled: boolean;
  /** RPC and SwayStaking configured. */
  readonly stakingEnabled: boolean;
  /** SwayLaunchpad.signer(). */
  signer(): Promise<Address>;
  /** SwayLaunchpad.launchDigest(...): the EIP-712 digest the contract recovers the signer from. */
  launchDigest(m: LaunchMessage): Promise<Hex>;
  /** SwayLaunchpad.tokenOf(creator), null before launch. */
  tokenOf(creator: Address): Promise<Address | null>;
  curve(token: Address): Promise<OnchainCurve | null>;
  /** SwayLaunchpad.pairOf(token): the Uniswap V2 pair a graduated curve moves into. */
  pairOf(token: Address): Promise<Address | null>;
  creatorFees(creator: Address): Promise<bigint>;
  airdropClaimed(token: Address, account: Address): Promise<boolean>;
  /** ERC-20 balance and allowance to the launchpad, per owner. */
  tokenBalances(token: Address, owners: Address[]): Promise<Array<{ balance: bigint; allowance: bigint }>>;
  /** SwayStaking state for `account` (zeros for null) plus the contract-wide numbers. */
  stakingState(account: Address | null): Promise<OnchainStaking>;
  /** Dev faucet: the operator sends $SWAY (dev token minted to the deployer). */
  sendSway(to: Address, amount: bigint): Promise<OperatorTxResult>;
}

const lower = (a: string) => a.toLowerCase() as Address;

export class ViemLaunchChain implements LaunchChain {
  readonly launchpad: Address | null;
  readonly staking: Address | null;
  readonly launchEnabled: boolean;
  readonly stakingEnabled: boolean;
  private readonly chain: Chain;
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient | null;
  private readonly account: PrivateKeyAccount | null;
  private swayToken: Address | null = null;

  constructor(
    config: Config,
    private readonly redis: Redis,
  ) {
    const rpc = !!config.chain.rpcUrl;
    this.launchpad = config.contracts.launchpad;
    this.staking = config.contracts.swayStaking;
    this.launchEnabled = rpc && !!this.launchpad;
    this.stakingEnabled = rpc && !!this.staking;
    this.chain = swayChain({
      chainId: config.chain.id,
      rpcUrl: config.chain.rpcUrl,
      explorerUrl: config.chain.explorerUrl,
      name: config.chain.name,
    });
    const transport = http(config.chain.rpcUrl, { timeout: 10_000, retryCount: 1 });
    this.pub = createPublicClient({ chain: this.chain, transport }) as PublicClient;
    this.account = config.operatorKey ? privateKeyToAccount(config.operatorKey) : null;
    this.wallet = this.account
      ? createWalletClient({ chain: this.chain, transport, account: this.account })
      : null;
  }

  private pad(): Address {
    if (!this.launchEnabled) throw new ChainUnavailable('SwayLaunchpad');
    return this.launchpad!;
  }

  private stk(): Address {
    if (!this.stakingEnabled) throw new ChainUnavailable('SwayStaking');
    return this.staking!;
  }

  async signer(): Promise<Address> {
    return lower(
      (await this.pub.readContract({
        address: this.pad(),
        abi: swayLaunchpadAbi,
        functionName: 'signer',
      })) as string,
    );
  }

  async launchDigest(m: LaunchMessage): Promise<Hex> {
    return (await this.pub.readContract({
      address: this.pad(),
      abi: swayLaunchpadAbi,
      functionName: 'launchDigest',
      args: [m.creator, m.name, m.symbol, m.startCapWei, m.graduationCapWei, m.airdropRoot, m.deadline],
    })) as Hex;
  }

  async tokenOf(creator: Address): Promise<Address | null> {
    const t = (await this.pub.readContract({
      address: this.pad(),
      abi: swayLaunchpadAbi,
      functionName: 'tokenOf',
      args: [creator],
    })) as string;
    return isZeroAddress(t) ? null : lower(t);
  }

  async curve(token: Address): Promise<OnchainCurve | null> {
    const r = (await this.pub.readContract({
      address: this.pad(),
      abi: swayLaunchpadAbi,
      functionName: 'curves',
      args: [token],
    })) as readonly [string, bigint, bigint, bigint, bigint, Hex, boolean, boolean];
    if (isZeroAddress(r[0])) return null;
    return {
      creator: lower(r[0]),
      virtualEth: r[1],
      ethReserve: r[2],
      tokenReserve: r[3],
      graduationCapWei: r[4],
      airdropRoot: r[5],
      graduated: r[6],
      migrated: r[7],
    };
  }

  async pairOf(token: Address): Promise<Address | null> {
    const p = (await this.pub.readContract({
      address: this.pad(),
      abi: swayLaunchpadAbi,
      functionName: 'pairOf',
      args: [token],
    })) as string;
    return isZeroAddress(p) ? null : lower(p);
  }

  async creatorFees(creator: Address): Promise<bigint> {
    return (await this.pub.readContract({
      address: this.pad(),
      abi: swayLaunchpadAbi,
      functionName: 'creatorFees',
      args: [creator],
    })) as bigint;
  }

  async airdropClaimed(token: Address, account: Address): Promise<boolean> {
    return (await this.pub.readContract({
      address: this.pad(),
      abi: swayLaunchpadAbi,
      functionName: 'airdropClaimed',
      args: [token, account],
    })) as boolean;
  }

  async tokenBalances(
    token: Address,
    owners: Address[],
  ): Promise<Array<{ balance: bigint; allowance: bigint }>> {
    const pad = this.pad();
    return Promise.all(
      owners.map(async (o) => {
        const [balance, allowance] = await Promise.all([
          this.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [o] }),
          this.pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [o, pad] }),
        ]);
        return { balance, allowance };
      }),
    );
  }

  private async tokenAddress(): Promise<Address> {
    if (!this.swayToken)
      this.swayToken = lower(
        (await this.pub.readContract({
          address: this.stk(),
          abi: swayStakingAbi,
          functionName: 'token',
        })) as string,
      );
    return this.swayToken;
  }

  async stakingState(account: Address | null): Promise<OnchainStaking> {
    const staking = this.stk();
    const token = await this.tokenAddress();
    const read = <T>(functionName: string, args: readonly unknown[] = []) =>
      this.pub.readContract({
        address: staking,
        abi: swayStakingAbi,
        functionName,
        args,
      } as never) as Promise<T>;
    const [thresholds, totalStaked, block] = await Promise.all([
      Promise.all([0n, 1n, 2n, 3n].map((i) => read<bigint>('thresholds', [i]))),
      read<bigint>('totalStaked'),
      this.pub.getBlock({ blockTag: 'latest' }),
    ]);
    const blockTime = Number(block.timestamp);
    if (!account)
      return {
        token,
        balance: 0n,
        allowance: 0n,
        staked: 0n,
        unstaking: 0n,
        unlockAt: 0,
        level: 0,
        thresholds,
        pendingRewards: 0n,
        totalStaked,
        blockTime,
      };
    const [acct, level, pendingRewards, balance, allowance] = await Promise.all([
      read<readonly [bigint, bigint, bigint, bigint, bigint]>('accounts', [account]),
      read<number>('levelOf', [account]),
      read<bigint>('pendingRewards', [account]),
      this.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      this.pub.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, staking],
      }),
    ]);
    return {
      token,
      balance,
      allowance,
      staked: acct[0],
      unstaking: acct[1],
      unlockAt: Number(acct[2]),
      level: Number(level),
      thresholds,
      pendingRewards,
      totalStaked,
      blockTime,
    };
  }

  async sendSway(to: Address, amount: bigint): Promise<OperatorTxResult> {
    if (!this.wallet || !this.account) throw new ChainUnavailable('Operator');
    const token = await this.tokenAddress();
    return withRedisLock(this.redis, OPERATOR_LOCK_KEY, async () => {
      const hash = await this.wallet!.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to, amount],
        account: this.account!,
        chain: this.chain,
      });
      try {
        const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 500 });
        return { hash, status: r.status };
      } catch {
        return { hash, status: 'pending' as const };
      }
    });
  }
}
