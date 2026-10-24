/**
 * Empties a wallet into another address (the Wallet page's "Move everything"): claims its open key-holder airdrops,
 * sells every launchpad token it holds on its curve, claims SwayKeys earnings and launchpad creator fees (last:
 * selling your own token pays you one more), then sends all its ETH but the transfer's gas. Keys stay where they
 * are: sell them from Your keys first (a creator's first key can never be sold).
 */
import { createPublicClient, erc20Abi, http, type Abi, type Address, type Hex } from 'viem';
import { swayKeysAbi, swayLaunchpadAbi } from './abi';
import { swayChain } from './chain';

/** The few wallet calls this needs; the web's SwayWallet fits. */
export interface MoveAllWallet {
  address: Address;
  writeContract(call: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<Hex>;
  claim(subjects: Address[]): Promise<Hex>;
  sendEth(to: Address, wei: bigint): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<void>;
}

export interface MoveAllInput {
  wallet: MoveAllWallet;
  to: Address;
  chain: { chainId: number; rpcUrl: string; swayKeys: Address | null; launchpad: Address | null };
  /** Markets whose holder rewards to settle in the claim. */
  claimSubjects: Address[];
  /** Launched tokens to look at besides the airdropped ones (the member's own, say). */
  tokens: Array<Address | null | undefined>;
  airdrops: Array<{ address: string; token: Address; amount: string; proof: Hex[]; symbol: string }>;
  onStep?: (step: string) => void;
}

export interface MoveAllResult {
  soldWei: bigint;
  claimedWei: bigint;
  sentWei: bigint;
  sendHash: Hex | null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** ETH kept for the final transfer's gas: 900k gas at today's price (an L2 transfer plus its L1 part), at least 0.00001 ETH. */
const MIN_KEEP = 10_000_000_000_000n;

export async function moveAll(i: MoveAllInput): Promise<MoveAllResult> {
  const { wallet, chain } = i;
  const me = wallet.address;
  // A short timeout and few retries: a stuck RPC should end in an error the member sees, not an endless spinner.
  const pub = createPublicClient({ chain: swayChain({ chainId: chain.chainId, rpcUrl: chain.rpcUrl }), transport: http(chain.rpcUrl, { timeout: 20_000, retryCount: 2 }) });
  const step = i.onStep ?? (() => undefined);
  const write = async (call: Parameters<MoveAllWallet['writeContract']>[0]) => wallet.waitForReceipt(await wallet.writeContract(call));
  const out: MoveAllResult = { soldWei: 0n, claimedWei: 0n, sentWei: 0n, sendHash: null };
  const pad = chain.launchpad;

  if (pad) {
    const tokens = new Set(i.tokens.filter((t): t is Address => !!t).map((t) => t.toLowerCase() as Address));
    step('Checking airdrops…');
    for (const a of i.airdrops) {
      if (!same(a.address, me)) continue;
      tokens.add(a.token.toLowerCase() as Address);
      if (await pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'airdropClaimed', args: [a.token, me] })) continue;
      step(`Claiming the $${a.symbol} airdrop…`);
      await write({ address: pad, abi: swayLaunchpadAbi, functionName: 'claimAirdrop', args: [a.token, BigInt(a.amount), a.proof] });
    }
    for (const token of tokens) {
      step('Checking your tokens…');
      const balance = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
      if (balance === 0n) continue;
      const curve = (await pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'curves', args: [token] })) as readonly unknown[];
      if (curve[6]) continue; // graduated: it trades on Uniswap now
      const [ethOut] = (await pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'quoteSell', args: [token, balance] })) as readonly bigint[];
      if (!ethOut) continue;
      const symbol = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'token');
      const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [me, pad] });
      if (allowance < balance) {
        step(`Approving $${symbol}…`);
        await write({ address: token, abi: erc20Abi, functionName: 'approve', args: [pad, balance] });
      }
      step(`Selling $${symbol}…`);
      await write({ address: pad, abi: swayLaunchpadAbi, functionName: 'sell', args: [token, balance, (ethOut * 99n) / 100n] });
      out.soldWei += ethOut;
    }
  }

  if (chain.swayKeys) {
    step('Checking key earnings…');
    const e = (await pub.readContract({ address: chain.swayKeys, abi: swayKeysAbi, functionName: 'claimable', args: [me, i.claimSubjects] })) as readonly bigint[];
    const total = e.reduce((s, x) => s + x, 0n);
    if (total > 0n) {
      step('Claiming key earnings…');
      await wallet.waitForReceipt(await wallet.claim(i.claimSubjects));
      out.claimedWei += total;
    }
  }

  if (pad) {
    step('Checking creator fees…');
    const fees = (await pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'creatorFees', args: [me] })) as bigint;
    if (fees > 0n) {
      step('Claiming creator fees…');
      await write({ address: pad, abi: swayLaunchpadAbi, functionName: 'claimCreatorFees' });
      out.claimedWei += fees;
    }
  }

  step('Checking your ETH…');
  const [balance, gasPrice] = await Promise.all([pub.getBalance({ address: me }), pub.getGasPrice()]);
  const keep = gasPrice * 900_000n > MIN_KEEP ? gasPrice * 900_000n : MIN_KEEP;
  if (balance > keep && !same(i.to, me)) {
    step('Sending your ETH…');
    out.sendHash = await wallet.sendEth(i.to, balance - keep);
    await wallet.waitForReceipt(out.sendHash);
    out.sentWei = balance - keep;
  }
  return out;
}
