/**
 * Burner embedded wallet (ConfigDTO.wallets.embedded === 'burner'): viem private keys kept in this browser's
 * localStorage, never sent anywhere. `sway.burner.<userId>` holds the key created at onboarding; more Sway
 * wallets (added, or imported from a backup) live under `sway.burner.<userId>.<address>`. Local chains and
 * testnets only.
 */
import { swayKeysAbi } from '@sway/shared/abi';
import { swayChain, type ConfigDTO } from '@sway/shared';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { SwayWallet } from './types';

const storageKey = (userId: string) => `sway.burner.${userId}`;
const extraKey = (userId: string, address: string) => `sway.burner.${userId}.${address.toLowerCase()}`;
const isKey = (v: string | null | undefined): v is Hex => !!v && /^0x[0-9a-fA-F]{64}$/.test(v);

export function loadBurnerKey(userId: string): Hex | null {
  try {
    const v = localStorage.getItem(storageKey(userId));
    return isKey(v) ? v : null;
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

/** This browser's key for one of the member's Sway wallets, if it has it. */
export function findBurnerKey(userId: string, address: string): Hex | null {
  const main = loadBurnerKey(userId);
  if (main && burnerAddress(main).toLowerCase() === address.toLowerCase()) return main;
  try {
    const v = localStorage.getItem(extraKey(userId, address));
    return isKey(v) && burnerAddress(v).toLowerCase() === address.toLowerCase() ? v : null;
  } catch {
    return null;
  }
}

/** Keeps a key in this browser (an added or imported Sway wallet). Returns its address. */
export function saveBurnerKey(userId: string, pk: Hex): Address {
  const address = burnerAddress(pk);
  try {
    localStorage.setItem(extraKey(userId, address), pk);
  } catch {
    /* storage blocked: the key lives for this tab only */
  }
  return address;
}

/** A fresh Sway wallet for "Add wallet", kept in this browser. */
export function newBurnerKey(userId: string): Hex {
  const pk = generatePrivateKey();
  saveBurnerKey(userId, pk);
  return pk;
}

/** Accepts a pasted private key (with or without 0x, surrounding spaces ignored). */
export function parsePrivateKey(raw: string): Hex | null {
  const t = raw.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(t)) return null;
  const pk = `0x${t.toLowerCase()}` as Hex;
  try {
    privateKeyToAccount(pk);
    return pk;
  } catch {
    return null;
  }
}

const clients = new Map<string, SwayWallet>();

/** One SwayWallet per key and chain config (viem clients are reused across renders). */
export function burnerWalletCached(pk: Hex, config: ConfigDTO): SwayWallet {
  const k = `${pk}:${config.chainId}:${config.rpcUrl}:${config.contracts.swayKeys}`;
  let w = clients.get(k);
  if (!w) clients.set(k, (w = burnerWallet(pk, config)));
  return w;
}

export function burnerWallet(pk: Hex, config: ConfigDTO): SwayWallet {
  const chain = swayChain({ chainId: config.chainId, rpcUrl: config.rpcUrl, explorerUrl: config.explorerUrl, name: config.chainName });
  const account = privateKeyToAccount(pk);
  const transport = http(config.rpcUrl);
  // Poll every second (viem's default is 4s) so trades confirm quickly on 1-2s block times.
  const wallet = createWalletClient({ account, chain, transport, pollingInterval: 1000 });
  const pub = createPublicClient({ chain, transport, pollingInterval: 1000 });
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
    writeContract: (call) => wallet.writeContract(call as never),
    async waitForReceipt(hash) {
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error('Transaction reverted');
    },
  };
}
