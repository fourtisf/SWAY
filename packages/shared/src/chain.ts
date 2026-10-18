import { defineChain, encodePacked, keccak256, getAddress, type Chain } from 'viem';
import type { Address } from './api';

/**
 * Robinhood Chain. influence.family documents chain ID 4663 and the explorer below for mainnet:
 * VERIFY BOTH before any deploy. Development uses a local anvil chain or the testnet (set CHAIN_ID,
 * RPC_URL and EXPLORER_URL). Contracts are unaudited, so the API refuses mainnet unless
 * SWAY_ENABLE_MAINNET=1.
 */
export const ROBINHOOD_MAINNET_ID = 4663;
export const ROBINHOOD_MAINNET_EXPLORER = 'https://explorer.mainnet.chain.robinhood.com';
export const LOCAL_CHAIN_ID = 31337;

export interface ChainEnv {
  chainId: number;
  rpcUrl: string;
  explorerUrl?: string;
  name?: string;
}

export function swayChain(env: ChainEnv): Chain {
  const isLocal = env.chainId === LOCAL_CHAIN_ID;
  const isMainnet = env.chainId === ROBINHOOD_MAINNET_ID;
  const explorer = env.explorerUrl || (isMainnet ? ROBINHOOD_MAINNET_EXPLORER : '');
  return defineChain({
    id: env.chainId,
    name: env.name || (isLocal ? 'Sway Local' : isMainnet ? 'Robinhood Chain' : 'Robinhood Chain Testnet'),
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [env.rpcUrl] } },
    blockExplorers: explorer ? { default: { name: 'Explorer', url: explorer } } : undefined,
    testnet: !isMainnet,
  });
}

/** Same as SwayKeys.fanSubject(xId): the placeholder subject address of a fan market. */
export function fanSubject(xId: bigint | string | number): Address {
  const h = keccak256(encodePacked(['string', 'uint64'], ['sway.fan', BigInt(xId)]));
  return getAddress(`0x${h.slice(-40)}`) as Address;
}

export const isZeroAddress = (a: string | null | undefined): boolean =>
  !a || /^0x0{40}$/i.test(a);
