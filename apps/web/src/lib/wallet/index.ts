'use client';
/**
 * The member's wallets in this browser. A member has an account wallet plus linked wallets (MeDTO.wallets);
 * each is usable here when:
 * - mock mode: always (in-memory wallets);
 * - Sway wallet (embedded 'burner'): its key is in this browser's localStorage;
 * - wallet app (external): wagmi has a live connection to that address (<ExternalWalletRoot/>);
 * - embedded 'privy' / 'cdp': adapters are TODO stubs (see ./privy.ts, ./cdp.ts).
 * One of them is active (./active.ts); useSwayWallet() returns it, so every SwayWallet call goes through it.
 */
import type { Address, ConfigDTO, MeDTO, WalletInfoDTO } from '@sway/shared';
import { useMemo } from 'react';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { create } from 'zustand';
import { getApi } from '../api';
import { MOCK } from '../env';
import { useConfig, useMe } from '../queries';
import { openModal } from '../store';
import { activeChoice, resolveActive, setActiveChoice, useActiveChoice } from './active';
import { burnerWalletCached, findBurnerKey, loadOrCreateBurnerKey, newBurnerKey } from './burner';
import { walletName, useWalletCatalog, type DetectedWallet } from './catalog';
import { cdpWallet } from './cdp';
import { mockWallet } from './mock';
import { privyWallet } from './privy';
import type { SwayWallet, WalletStatus } from './types';

export type { SwayWallet, WalletStatus } from './types';

export type ConnectAction = { via: 'injected'; rdns: string | null } | { via: 'coinbaseWallet' } | { via: 'walletConnect' };

/** wagmi behind a small interface (filled by <ExternalWalletRoot/>, real mode only). */
export interface ExternalApi {
  /** Opens the wallet app; WalletConnect reports its pairing URI through onUri (QR / deep link). */
  connect(a: ConnectAction, onUri?: (uri: string) => void): Promise<{ address: Address; chainId: number; wallet: SwayWallet }>;
  /** Switches (or adds) the Sway chain in the wallet app connected to this address. */
  switchChain(address: Address): Promise<void>;
  chainOf(address: Address): number | null;
}

export const useExternalWallet = create<{
  /** Every account connected through a wallet app, as SwayWallets. */
  wallets: SwayWallet[];
  /** EIP-6963 browser wallets in this browser. */
  detected: DetectedWallet[];
  /** wagmi has restored last session's connections. */
  ready: boolean;
  api: ExternalApi | null;
  /** @deprecated first connected account; use useMemberWallets(). */
  wallet: SwayWallet | null;
  /** @deprecated opens the connect modal; use openConnectWallet() from lib/wallet-actions. */
  openConnect: (() => void) | null;
}>(() => ({ wallets: [], detected: [], ready: false, api: null, wallet: null, openConnect: () => openModal({ type: 'wallets', purpose: 'reconnect' }) }));

/** Bumped when a Sway wallet key is added to or imported into this browser. */
export const useKeyring = create<{ v: number }>(() => ({ v: 0 }));
export const keyringChanged = () => useKeyring.setState((s) => ({ v: s.v + 1 }));

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export interface MemberWallet extends WalletInfoDTO {
  wallet: SwayWallet | null;
  status: Exclude<WalletStatus, 'none'>;
  usable: boolean;
  /** Label, else the wallet app's name. */
  name: string;
}

/** The member's wallets (account first) with what this browser can do with each. */
export function memberWalletsOf(
  me: MeDTO,
  config: ConfigDTO | undefined,
  externals: SwayWallet[],
  name: (w: WalletInfoDTO) => string,
): MemberWallet[] {
  const infos: WalletInfoDTO[] =
    me.wallets ??
    (me.wallet ? [{ address: me.wallet.address, kind: me.wallet.kind, connector: me.wallet.kind === 'embedded' ? 'sway' : null, label: null, account: true, createdAt: '' }] : []);
  const list = infos.map((w) => {
    let wallet: SwayWallet | null = null;
    let status: MemberWallet['status'];
    if (MOCK) {
      wallet = mockWallet(w.address, w.kind);
      status = 'ready';
    } else if (w.kind === 'external') {
      wallet = externals.find((x) => same(x.address, w.address)) ?? null;
      status = wallet ? 'ready' : 'needs-external';
    } else if (!config) status = 'missing-key';
    else if (config.wallets.embedded !== 'burner') status = 'unsupported';
    else {
      const pk = findBurnerKey(me.user.id, w.address);
      wallet = pk ? burnerWalletCached(pk, config) : null;
      status = wallet ? 'ready' : 'missing-key';
    }
    return { ...w, wallet, status, usable: !!wallet, name: w.label || name(w) };
  });
  // Two unlabelled wallets of the same app read "Sway wallet", "Sway wallet 2", …
  const seen = new Map<string, number>();
  return list.map((w) => {
    const n = (seen.get(w.name) ?? 0) + 1;
    seen.set(w.name, n);
    return n > 1 && !w.label ? { ...w, name: `${w.name} ${n}` } : w;
  });
}

export function useMemberWallets(): {
  wallets: MemberWallet[];
  active: MemberWallet | null;
  /** False until wagmi has restored connections (real mode), so "not connected" isn't shown too early. */
  ready: boolean;
  setActive: (address: string) => void;
} {
  const me = useMe().data;
  const config = useConfig().data;
  const externals = useExternalWallet((s) => s.wallets);
  const detected = useExternalWallet((s) => s.detected);
  const extReady = useExternalWallet((s) => s.ready);
  const keys = useKeyring((s) => s.v);
  const choice = useActiveChoice((s) => (me ? s.byUser[me.user.id] : undefined));
  // Logos load for signed-in members only; guests never fetch the wallet catalog.
  const apps = useWalletCatalog(!!me);
  return useMemo(() => {
    if (!me) return { wallets: [], active: null, ready: true, setActive: () => undefined };
    const wallets = memberWalletsOf(me, config, externals, (w) => walletName(w.connector, apps, detected, w.kind));
    const active = resolveActive(wallets, choice !== undefined ? choice : activeChoice(me.user.id));
    return {
      wallets,
      active,
      ready: MOCK || extReady || !wallets.some((w) => w.kind === 'external'),
      setActive: (address: string) => setActiveChoice(me.user.id, address),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, config, externals, detected, extReady, keys, choice, apps]);
}

/** The active wallet as a SwayWallet (null with why when it can't sign here). */
export function useSwayWallet(): { wallet: SwayWallet | null; status: WalletStatus; address: Address | null } {
  const me = useMe().data;
  const { active } = useMemberWallets();
  if (!me || !me.wallet || !active) return { wallet: null, status: 'none', address: null };
  return { wallet: active.wallet, status: active.status, address: active.address };
}

/** Onboarding "Create a Sway wallet": create (or load) the member's embedded account wallet. */
export async function createEmbeddedWallet(userId: string, config: ConfigDTO): Promise<SwayWallet> {
  if (MOCK) return mockWallet(privateKeyToAccount(generatePrivateKey()).address, 'embedded');
  switch (config.wallets.embedded) {
    case 'burner':
      return burnerWalletCached(loadOrCreateBurnerKey(userId), config);
    case 'privy':
      return privyWallet(userId, config);
    case 'cdp':
      return cdpWallet(userId, config);
    case 'off':
      throw new Error('Browser-made Sway wallets are off on this network: connect a wallet app instead');
  }
}

/** "Add wallet" → Sway wallet: a fresh embedded wallet kept in this browser. */
export async function createExtraSwayWallet(userId: string, config: ConfigDTO): Promise<SwayWallet> {
  if (!MOCK && config.wallets.embedded !== 'burner') return createEmbeddedWallet(userId, config);
  const pk = newBurnerKey(userId);
  keyringChanged();
  return MOCK ? mockWallet(privateKeyToAccount(pk).address, 'embedded') : burnerWalletCached(pk, config);
}

/**
 * Signs the link message with `sw` and links it: as the account wallet (onboarding) or as an extra wallet.
 * The API fills "Address: {address}" when it gets the address; we fill it ourselves otherwise.
 */
export async function linkWallet(sw: SwayWallet, opts: { as: 'account' | 'linked'; connector: string; label?: string }): Promise<MeDTO> {
  const api = getApi();
  const fill = (m: string) => m.split('{address}').join(sw.address);
  if (opts.as === 'account') {
    const { message } = await api.walletNonce({ address: sw.address });
    const signature = await sw.signMessage(fill(message));
    return api.walletLink({ address: sw.address, signature, kind: sw.kind, connector: opts.connector });
  }
  const { message } = await api.walletsNonce({ address: sw.address });
  const signature = await sw.signMessage(fill(message));
  return api.walletsLink({ address: sw.address, signature, kind: sw.kind, connector: opts.connector, label: opts.label });
}
