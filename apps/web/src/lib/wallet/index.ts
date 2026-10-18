'use client';
/**
 * Picks the SwayWallet for the signed-in member:
 * - mock mode: the in-memory wallet;
 * - embedded 'burner': the key in this browser's localStorage;
 * - external: the wagmi/RainbowKit account (when connected to the linked address);
 * - embedded 'privy' / 'cdp': adapters are TODO stubs (see ./privy.ts, ./cdp.ts).
 */
import type { ConfigDTO } from '@sway/shared';
import { useMemo } from 'react';
import { create } from 'zustand';
import { MOCK } from '../env';
import { useConfig, useMe } from '../queries';
import { burnerAddress, burnerWallet, loadBurnerKey, loadOrCreateBurnerKey } from './burner';
import { cdpWallet } from './cdp';
import { mockWallet } from './mock';
import { privyWallet } from './privy';
import type { SwayWallet, WalletStatus } from './types';

export type { SwayWallet, WalletStatus } from './types';

/** Filled by <ExternalWalletRoot/> (wagmi + RainbowKit), real mode only. */
export const useExternalWallet = create<{ wallet: SwayWallet | null; openConnect: (() => void) | null; ready: boolean }>(() => ({
  wallet: null,
  openConnect: null,
  ready: false,
}));

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function useSwayWallet(): { wallet: SwayWallet | null; status: WalletStatus } {
  const me = useMe().data;
  const config = useConfig().data;
  const external = useExternalWallet((s) => s.wallet);
  return useMemo(() => {
    if (!me || !me.wallet) return { wallet: null, status: 'none' as const };
    if (MOCK) return { wallet: mockWallet(me.wallet.address), status: 'ready' as const };
    if (!config) return { wallet: null, status: 'none' as const };
    if (me.wallet.kind === 'external')
      return same(external?.address, me.wallet.address) ? { wallet: external, status: 'ready' as const } : { wallet: null, status: 'needs-external' as const };
    if (config.wallets.embedded !== 'burner') return { wallet: null, status: 'unsupported' as const };
    const pk = loadBurnerKey(me.user.id);
    if (!pk || !same(burnerAddress(pk), me.wallet.address)) return { wallet: null, status: 'missing-key' as const };
    return { wallet: burnerWallet(pk, config), status: 'ready' as const };
  }, [me, config, external]);
}

/** Onboarding step 4: create (or load) the member's embedded wallet. */
export async function createEmbeddedWallet(userId: string, config: ConfigDTO): Promise<SwayWallet> {
  switch (config.wallets.embedded) {
    case 'burner':
      return burnerWallet(loadOrCreateBurnerKey(userId), config);
    case 'privy':
      return privyWallet(userId, config);
    case 'cdp':
      return cdpWallet(userId, config);
  }
}
