/**
 * Burner embedded wallet (ConfigDTO.wallets.embedded === 'burner'): a viem private key kept in this
 * browser's localStorage, one per Sway user id. Local chains and testnets only.
 */
import { swayKeysAbi } from '@sway/shared/abi';
import { swayChain, type ConfigDTO } from '@sway/shared';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { SwayWallet } from './types';

const storageKey = (userId: string) => `sway.burner.${userId}`;

export function loadBurnerKey(userId: string): Hex | null {
  try {
    const v = localStorage.getItem(storageKey(userId));
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : null;
  } catch {
    return null;
  }
}

/** Loads this user's burner key, creating and storing one if there is none yet. */
export function loadOrCreateBurnerKey(userId: string): Hex {
  const existing = loadBurnerKey(userId);
  if (existing) return existing;
  const pk = generatePrivateKey();
  try {
    localStorage.setItem(storageKey(userId), pk);
  } catch {
    /* storage blocked: the key lives for this tab only */
  }
  return pk;
}

export const burnerAddress = (pk: Hex): Address => privateKeyToAccount(pk).address;

export function burnerWallet(pk: Hex, config: ConfigDTO): SwayWallet {
  const chain = swayChain({ chainId: config.chainId, rpcUrl: config.rpcUrl, explorerUrl: config.explorerUrl, name: config.chainName });
  const account = privateKeyToAccount(pk);
  const transport = http(config.rpcUrl);
  const wallet = createWalletClient({ account, chain, transport });
  const pub = createPublicClient({ chain, transport });
  const keys = () => {
    if (!config.contracts.swayKeys) throw new Error('SwayKeys is not deployed on this chain yet');
    return config.contracts.swayKeys;
  };
  return {
    address: account.address,
    kind: 'embedded',
    signMessage: (message) => wallet.signMessage({ message }),
    buy: (subject, units, value) => wallet.writeContract({ address: keys(), abi: swayKeysAbi, functionName: 'buy', args: [subject, units], value }),
    sell: (subject, units, minProceeds) => wallet.writeContract({ address: keys(), abi: swayKeysAbi, functionName: 'sell', args: [subject, units, minProceeds] }),
    claim: (subjects) => wallet.writeContract({ address: keys(), abi: swayKeysAbi, functionName: 'claim', args: [subjects] }),
    sendEth: (to, value) => wallet.sendTransaction({ to, value }),
    async waitForReceipt(hash) {
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error('Transaction reverted');
    },
  };
}
