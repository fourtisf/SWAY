/**
 * Ethereum, where Robinhood Chain settles (ConfigDTO.parentChain): ETH balances there and the move here. Robinhood
 * Chain is an Arbitrum Orbit rollup, so Inbox.depositEth() on Ethereum credits the same address on this chain once
 * the sequencer picks it up (about 10–15 minutes); no third party holds the money on the way. Two checks run
 * before each move: the Inbox must be an allowed delayed inbox of the bridge whose rollup is this chain (a wrong
 * or swapped address in the config can't take the money), and the sender must be a plain account, since
 * depositEth credits a contract's aliased address instead, which a smart wallet can't spend from here.
 */
import { parentViemChain, swayChain, type ConfigDTO, type ParentChainDTO } from '@sway/shared';
import { createPublicClient, http, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { create } from 'zustand';
import { MOCK } from '../env';
import { getWorld } from '../mock';
import type { SwayWallet } from './types';

export const inboxAbi = parseAbi(['function depositEth() payable returns (uint256)', 'function bridge() view returns (address)']);
const bridgeAbi = parseAbi(['function allowedDelayedInboxes(address inbox) view returns (bool)', 'function rollup() view returns (address)']);
const rollupAbi = parseAbi(['function chainId() view returns (uint256)']);

/** Used when the node can't estimate (an empty account): depositEth takes well under this. */
const DEPOSIT_GAS = 150_000n;

export const BRIDGE_CHECK_FAILED = 'The Ethereum bridge didn’t check out, so nothing was sent. Try again in a few minutes.';
export const SMART_WALLET =
  'This wallet is a smart contract wallet. The bridge would credit a different address on Robinhood Chain, so move it from the wallet app’s own bridge instead.';

const clients = new Map<string, PublicClient>();
function client(key: string, make: () => PublicClient): PublicClient {
  let c = clients.get(key);
  if (!c) clients.set(key, (c = make()));
  return c;
}
export const parentClient = (p: ParentChainDTO): PublicClient =>
  client(`p:${p.chainId}:${p.rpcUrl}`, () => createPublicClient({ chain: parentViemChain(p), transport: http(p.rpcUrl) }));
const chainClient = (c: ConfigDTO): PublicClient =>
  client(`c:${c.chainId}:${c.rpcUrl}`, () =>
    createPublicClient({ chain: swayChain({ chainId: c.chainId, rpcUrl: c.rpcUrl, explorerUrl: c.explorerUrl, name: c.chainName }), transport: http(c.rpcUrl) }),
  );

/** Mock mode: every demo wallet starts with this much ETH on Ethereum. */
export const MOCK_PARENT_ETH = 0.04;

/** ETH on the parent chain per address (lowercase keys). */
export async function parentBalances(p: ParentChainDTO, addresses: Address[]): Promise<Record<string, bigint>> {
  if (MOCK) {
    const w = getWorld();
    return Object.fromEntries(addresses.map((a) => [a.toLowerCase(), BigInt(Math.round((w.parentEth[a.toLowerCase()] ?? MOCK_PARENT_ETH) * 1e18))]));
  }
  const c = parentClient(p);
  const out = await Promise.all(addresses.map((a) => c.getBalance({ address: a })));
  return Object.fromEntries(addresses.map((a, i) => [a.toLowerCase(), out[i]!]));
}

const checked = new Map<string, Promise<void>>();
/** Throws unless p.inbox is an allowed delayed inbox of p.bridge and that bridge's rollup is chain `chainId`. */
export function checkParentBridge(p: ParentChainDTO, chainId: number): Promise<void> {
  const k = `${p.chainId}:${p.inbox}:${p.bridge}:${chainId}`;
  let v = checked.get(k);
  if (!v) {
    const c = parentClient(p);
    v = (async () => {
      const bridge = await c.readContract({ address: p.inbox, abi: inboxAbi, functionName: 'bridge' });
      if (bridge.toLowerCase() !== p.bridge.toLowerCase()) throw new Error(BRIDGE_CHECK_FAILED);
      const [allowed, rollup] = await Promise.all([
        c.readContract({ address: bridge, abi: bridgeAbi, functionName: 'allowedDelayedInboxes', args: [p.inbox] }),
        c.readContract({ address: bridge, abi: bridgeAbi, functionName: 'rollup' }),
      ]);
      const id = await c.readContract({ address: rollup, abi: rollupAbi, functionName: 'chainId' });
      if (!allowed || id !== BigInt(chainId)) throw new Error(BRIDGE_CHECK_FAILED);
    })();
    checked.set(k, v);
    // An RPC hiccup shouldn't stick: check again next time.
    v.catch(() => checked.delete(k));
  }
  return v;
}

/** Throws SMART_WALLET when the address has code on either chain (a smart account or an EIP-7702 delegation). */
export async function assertPlainAccount(config: ConfigDTO, address: Address): Promise<void> {
  const p = config.parentChain;
  if (!p) return;
  const [a, b] = await Promise.all([parentClient(p).getCode({ address }), chainClient(config).getCode({ address })]);
  if ((a && a !== '0x') || (b && b !== '0x')) throw new Error(SMART_WALLET);
}

/**
 * The most a deposit from `from` could pay in Ethereum network fees: estimated gas at twice the current max fee,
 * so a fee rise between this quote and the wallet's send still fits. Max moves the balance minus this.
 */
export async function depositFeeCap(p: ParentChainDTO, from: Address): Promise<bigint> {
  if (MOCK) return 6n * 10n ** 13n;
  const c = parentClient(p);
  const [gas, fees] = await Promise.all([
    c.estimateContractGas({ address: p.inbox, abi: inboxAbi, functionName: 'depositEth', account: from, value: 1n }).catch(() => DEPOSIT_GAS),
    c.estimateFeesPerGas(),
  ]);
  return gas * fees.maxFeePerGas * 2n;
}

/** Checks the bridge and the sender, then sends depositEth from `w` on Ethereum. Returns the Ethereum tx hash. */
export async function moveFromParent(w: SwayWallet, config: ConfigDTO, wei: bigint): Promise<Hex> {
  const p = config.parentChain;
  if (!p || !w.parent) throw new Error('Moving ETH from Ethereum isn’t available on this network');
  if (!MOCK) await Promise.all([checkParentBridge(p, config.chainId), assertPlainAccount(config, w.address)]);
  return w.parent.deposit(wei);
}

/* ------------------------------------------------------------------ moves on their way */

export interface Arriving {
  hash: Hex;
  address: Address;
  wei: string;
  at: number;
}
/** Deposits usually land in 10–15 minutes; after this a move stops showing as on its way. */
export const ARRIVING_FOR_MS = 40 * 60_000;

const arrivingKey = (userId: string) => `sway.arriving.${userId}`;
const fresh = (xs: Arriving[], now = Date.now()) => xs.filter((x) => now - x.at < ARRIVING_FOR_MS);

function readArriving(userId: string): Arriving[] {
  try {
    const v = JSON.parse(localStorage.getItem(arrivingKey(userId)) ?? '[]') as Arriving[];
    return Array.isArray(v) ? fresh(v) : [];
  } catch {
    return [];
  }
}

export const useArriving = create<{ byUser: Record<string, Arriving[]> }>(() => ({ byUser: {} }));

export function arrivingOf(userId: string): Arriving[] {
  const s = useArriving.getState().byUser;
  return fresh(userId in s ? s[userId]! : readArriving(userId));
}

export function addArriving(userId: string, a: Arriving): void {
  const next = [a, ...arrivingOf(userId)].slice(0, 10);
  try {
    localStorage.setItem(arrivingKey(userId), JSON.stringify(next));
  } catch {
    /* storage blocked: it shows for this tab only */
  }
  useArriving.setState((s) => ({ byUser: { ...s.byUser, [userId]: next } }));
}
