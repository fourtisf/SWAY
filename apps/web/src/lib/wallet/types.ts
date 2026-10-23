import type { Abi, Address, Hex } from 'viem';
import type { MemberPermit } from '@sway/shared';

/** Any other contract call (launchpad, staking, ERC-20 approve…). */
export interface ContractCall {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

/** One wallet interface for the UI, whatever is behind it (burner, wagmi/RainbowKit, Privy, CDP, mock). */
export interface SwayWallet {
  address: Address;
  kind: 'embedded' | 'external';
  signMessage(msg: string): Promise<Hex>;
  /**
   * SwayKeys.buy(subject, units) payable; the contract refunds any change. With permits (POST /api/trade/permits)
   * it sends registerAndBuy, which first opens the market, claims it or records a referrer.
   */
  buy(subject: Address, units: bigint, valueWei: bigint, permits?: MemberPermit[]): Promise<Hex>;
  /** SwayKeys.register(permit) on its own, e.g. a creator taking their fan market before claiming. */
  register(permit: MemberPermit): Promise<Hex>;
  /** SwayKeys.sell(subject, units, minProceeds). */
  sell(subject: Address, units: bigint, minProceedsWei: bigint): Promise<Hex>;
  /** SwayKeys.claim(subjects): creator, holder and referral earnings in one transaction. */
  claim(subjects: Address[]): Promise<Hex>;
  sendEth(to: Address, wei: bigint): Promise<Hex>;
  /** Generic contract write for features beyond SwayKeys. */
  writeContract(call: ContractCall): Promise<Hex>;
  /** Resolves once mined; throws if the transaction reverted. */
  waitForReceipt(hash: Hex): Promise<void>;
  /** The same address on Ethereum (ConfigDTO.parentChain); go through moveFromParent() in ./parent. */
  parent?: ParentOps | null;
}

/** Calls on the parent chain from this wallet. */
export interface ParentOps {
  /** Inbox.depositEth(): the value arrives at this address on the Sway chain. */
  deposit(wei: bigint): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<void>;
}

export type WalletStatus =
  /** Signed in but no wallet linked yet: run onboarding step 4. */
  | 'none'
  | 'ready'
  /** Embedded burner key belongs to another device/browser. */
  | 'missing-key'
  /** Linked to an external wallet that isn't connected right now. */
  | 'needs-external'
  /** Embedded provider (Privy/CDP) not wired up yet. */
  | 'unsupported';
