import { defineChain, encodePacked, keccak256, getAddress, type Chain } from 'viem';
import type { Address, ParentChainDTO } from './api';

/**
 * Robinhood Chain. Mainnet is chain ID 4663; its explorer is the Blockscout below (the brief's
 * explorer.mainnet.chain.robinhood.com doesn't answer TLS). Development uses a local anvil chain or the testnet (set CHAIN_ID,
 * RPC_URL and EXPLORER_URL). Contracts are unaudited, so the API refuses mainnet unless
 * SWAY_ENABLE_MAINNET=1.
 */
export const ROBINHOOD_MAINNET_ID = 4663;
export const ROBINHOOD_MAINNET_EXPLORER = 'https://robinhoodchain.blockscout.com';
export const ROBINHOOD_TESTNET_ID = 46630;
export const LOCAL_CHAIN_ID = 31337;

/**
 * Robinhood Chain is an Arbitrum Orbit rollup on Ethereum (testnet: Sepolia). Delayed Inbox and Bridge addresses
 * from the Robinhood Chain docs (protocol contracts); the RPCs are public endpoints (PARENT_RPC_URL overrides).
 */
export const PARENT_CHAINS: Record<number, ParentChainDTO> = {
  [ROBINHOOD_MAINNET_ID]: {
    chainId: 1,
    name: 'Ethereum',
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    explorerUrl: 'https://etherscan.io',
    inbox: '0x1a07cc4bd17e0118bdb54d70990d2158abad7a2d',
    bridge: '0xdf8755334ce7a73ccf6b581c02ea649ae3e864b3',
  },
  [ROBINHOOD_TESTNET_ID]: {
    chainId: 11155111,
    name: 'Sepolia',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorerUrl: 'https://sepolia.etherscan.io',
    inbox: '0xf2939afa86f6f933a3ce17fcab007907b6b0b7a4',
    bridge: '0x96295bdad104ead97cc08797b3dc68eff59ccf30',
  },
};

export function parentViemChain(p: ParentChainDTO): Chain {
  return defineChain({
    id: p.chainId,
    name: p.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [p.rpcUrl] } },
    blockExplorers: p.explorerUrl ? { default: { name: 'Etherscan', url: p.explorerUrl } } : undefined,
    testnet: p.chainId !== 1,
  });
}

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
