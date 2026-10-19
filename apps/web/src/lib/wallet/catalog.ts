'use client';
/**
 * Wallet apps the connect modal lists, with their logos. Names, logos, rdns and download links come from
 * RainbowKit's bundled wallet definitions (`@rainbow-me/rainbowkit/wallets`): we only read their metadata
 * (no RainbowKit UI or connectors), so logos are never hotlinked or redrawn. Browser wallets announced through
 * EIP-6963 bring their own icon.
 */
import { WALLET_APPS, type WalletApp, type WalletConnector } from '@sway/shared';
import { useEffect } from 'react';
import { create } from 'zustand';

export interface WalletMeta {
  id: WalletApp;
  name: string;
  rdns: string | null;
  /** Logo as a data: URL (null until RainbowKit's lazy icon chunk has loaded). */
  icon: string | null;
  iconBackground: string;
  downloadUrls: Partial<Record<'android' | 'ios' | 'mobile' | 'qrCode' | 'chrome' | 'edge' | 'firefox' | 'opera' | 'safari' | 'browserExtension' | 'desktop', string>>;
  /** WalletConnect deep link for this app on mobile (null: open the plain wc: URI). */
  mobileUri: ((uri: string) => string) | null;
  /** What to encode in the desktop QR for this app's mobile app. */
  qrUri: ((uri: string) => string) | null;
}

/** A browser wallet announced through EIP-6963 (wagmi's multiInjectedProviderDiscovery). */
export interface DetectedWallet {
  rdns: string;
  name: string;
  icon: string | null;
}

/** Display names as the wallets write them. */
const NAMES: Record<WalletApp, string> = {
  metaMask: 'MetaMask',
  coinbaseWallet: 'Coinbase Wallet',
  rabby: 'Rabby',
  rainbow: 'Rainbow',
  trust: 'Trust Wallet',
  okx: 'OKX Wallet',
  phantom: 'Phantom',
  zerion: 'Zerion',
  walletConnect: 'WalletConnect',
};

/** RainbowKit's own ids and other spellings we may have stored, mapped to ours. */
const ALIASES: Record<string, WalletApp> = {
  metamask: 'metaMask',
  coinbase: 'coinbaseWallet',
  coinbasewallet: 'coinbaseWallet',
  coinbasewalletsdk: 'coinbaseWallet',
  rabby: 'rabby',
  rainbow: 'rainbow',
  trust: 'trust',
  trustwallet: 'trust',
  okx: 'okx',
  okxwallet: 'okx',
  phantom: 'phantom',
  zerion: 'zerion',
  walletconnect: 'walletConnect',
};

export function appOf(connector: string | null | undefined, apps: Partial<Record<WalletApp, WalletMeta>> = {}): WalletApp | null {
  if (!connector) return null;
  const a = ALIASES[connector.toLowerCase()];
  if (a) return a;
  for (const m of Object.values(apps)) if (m?.rdns && m.rdns === connector) return m.id;
  return null;
}

/* ------------------------------------------------------------------ loading RainbowKit metadata */

type RkWallet = {
  name: string;
  rdns?: string;
  iconUrl: string | (() => Promise<string>);
  iconBackground: string;
  downloadUrls?: WalletMeta['downloadUrls'];
  mobile?: { getUri?: (uri: string) => string };
  qrCode?: { getUri: (uri: string) => string };
};

let loading: Promise<Record<WalletApp, WalletMeta>> | null = null;

/** Resolves every curated wallet's metadata and logo once per page. */
export function loadCatalog(): Promise<Record<WalletApp, WalletMeta>> {
  loading ??= (async () => {
    const rk = await import('@rainbow-me/rainbowkit/wallets');
    const make: Record<WalletApp, (o: never) => RkWallet> = {
      metaMask: rk.metaMaskWallet as never,
      coinbaseWallet: rk.coinbaseWallet as never,
      rabby: rk.rabbyWallet as never,
      rainbow: rk.rainbowWallet as never,
      trust: rk.trustWallet as never,
      okx: rk.okxWallet as never,
      phantom: rk.phantomWallet as never,
      zerion: rk.zerionWallet as never,
      walletConnect: rk.walletConnectWallet as never,
    };
    // Metadata only: the factories need a project id to describe their WalletConnect fallback, never used here.
    const opts = { projectId: 'sway-wallet-metadata', appName: 'Sway' } as never;
    const entries = await Promise.all(
      WALLET_APPS.map(async (id): Promise<[WalletApp, WalletMeta]> => {
        try {
          const w = make[id](opts);
          const icon = typeof w.iconUrl === 'function' ? await w.iconUrl() : w.iconUrl;
          return [
            id,
            {
              id,
              name: NAMES[id],
              rdns: w.rdns ?? null,
              icon: icon || null,
              iconBackground: w.iconBackground || '#fff',
              downloadUrls: w.downloadUrls ?? {},
              mobileUri: w.mobile?.getUri ?? null,
              qrUri: w.qrCode?.getUri ?? null,
            },
          ];
        } catch {
          return [id, { id, name: NAMES[id], rdns: null, icon: null, iconBackground: '#fff', downloadUrls: {}, mobileUri: null, qrUri: null }];
        }
      }),
    );
    return Object.fromEntries(entries) as Record<WalletApp, WalletMeta>;
  })();
  return loading;
}

const useCatalogStore = create<{ apps: Partial<Record<WalletApp, WalletMeta>>; loaded: boolean }>(() => ({ apps: {}, loaded: false }));

/** Curated wallet metadata (empty until loaded; components re-render when the logos arrive). */
export function useWalletCatalog(enabled = true): Partial<Record<WalletApp, WalletMeta>> {
  const apps = useCatalogStore((s) => s.apps);
  const loaded = useCatalogStore((s) => s.loaded);
  useEffect(() => {
    if (enabled && !loaded) loadCatalog().then((a) => useCatalogStore.setState({ apps: a, loaded: true }), () => useCatalogStore.setState({ loaded: true }));
  }, [enabled, loaded]);
  return apps;
}

/* ------------------------------------------------------------------ logos and names */

export type Logo = { kind: 'sway' } | { kind: 'img'; src: string; bg: string; name: string } | { kind: 'generic'; name: string };

/** The logo for a stored connector key: Sway's mark, a curated app, an EIP-6963 wallet seen here, or generic. */
export function logoFor(
  connector: WalletConnector | null | undefined,
  apps: Partial<Record<WalletApp, WalletMeta>>,
  detected: DetectedWallet[] = [],
  kind?: 'embedded' | 'external',
): Logo {
  if (connector === 'sway' || (!connector && kind === 'embedded')) return { kind: 'sway' };
  const app = appOf(connector, apps);
  const meta = app ? apps[app] : undefined;
  if (meta?.icon) return { kind: 'img', src: meta.icon, bg: meta.iconBackground, name: meta.name };
  const d = connector ? detected.find((x) => x.rdns === connector) : undefined;
  if (d?.icon) return { kind: 'img', src: d.icon, bg: '#fff', name: d.name };
  return { kind: 'generic', name: walletName(connector, apps, detected, kind) };
}

export function walletName(
  connector: WalletConnector | null | undefined,
  apps: Partial<Record<WalletApp, WalletMeta>> = {},
  detected: DetectedWallet[] = [],
  kind?: 'embedded' | 'external',
): string {
  if (connector === 'sway' || (!connector && kind === 'embedded')) return 'Sway wallet';
  const app = appOf(connector, apps);
  if (app) return NAMES[app];
  const d = connector ? detected.find((x) => x.rdns === connector) : undefined;
  if (d) return d.name;
  return 'Wallet';
}

/* ------------------------------------------------------------------ picker entries */

export type PickerAction =
  /** EIP-6963 / window.ethereum provider in this browser. */
  | { via: 'injected'; rdns: string | null }
  /** Coinbase Wallet SDK (extension, or the smart-wallet popup when there is none). */
  | { via: 'coinbaseWallet' }
  /** WalletConnect QR (desktop) or deep link into `app` (mobile). */
  | { via: 'walletConnect'; app: WalletApp | null }
  /** Not installed and no WalletConnect: send the member to the official download page. */
  | { via: 'install'; url: string }
  /** WalletConnect needs ConfigDTO.wallets.walletConnectProjectId. */
  | { via: 'disabled'; hint: string };

export interface PickerEntry {
  /** Connector key stored with the wallet. */
  connector: WalletConnector;
  name: string;
  icon: string | null;
  iconBackground: string;
  tag: 'Detected' | 'Install' | 'Recommended' | null;
  action: PickerAction;
  sub: string;
}

export interface PickerEnv {
  mobile: boolean;
  walletConnect: boolean;
  /** Browser name for the extension store link. */
  browser: 'chrome' | 'firefox' | 'edge' | 'opera' | 'safari' | 'other';
  /** A non-EIP-6963 window.ethereum exists. */
  legacyInjected: boolean;
}

export function installUrl(m: WalletMeta, env: Pick<PickerEnv, 'mobile' | 'browser'>, ua = ''): string | null {
  const d = m.downloadUrls;
  if (env.mobile) return (/android/i.test(ua) ? d.android : /iphone|ipad|ipod/i.test(ua) ? d.ios : null) ?? d.mobile ?? d.browserExtension ?? null;
  const store = env.browser !== 'other' ? d[env.browser] : undefined;
  return store ?? d.browserExtension ?? d.desktop ?? d.mobile ?? null;
}

/**
 * Detected browser wallets first (with their announced icon), then the curated list minus what was detected.
 * Coinbase Wallet always connects (its SDK opens a popup without the extension); WalletConnect needs a project id.
 */
export function pickerEntries(
  apps: Partial<Record<WalletApp, WalletMeta>>,
  detected: DetectedWallet[],
  env: PickerEnv,
  ua = '',
): PickerEntry[] {
  const out: PickerEntry[] = [];
  const seen = new Set<string>();
  for (const d of detected) {
    if (seen.has(d.rdns)) continue;
    seen.add(d.rdns);
    const app = appOf(d.rdns, apps);
    out.push({
      connector: app ?? d.rdns,
      name: app ? NAMES[app] : d.name,
      icon: d.icon ?? (app ? (apps[app]?.icon ?? null) : null),
      iconBackground: '#fff',
      tag: 'Detected',
      action: { via: 'injected', rdns: d.rdns },
      sub: 'In this browser',
    });
  }
  if (!detected.length && env.legacyInjected)
    out.push({ connector: 'injected', name: 'Browser wallet', icon: null, iconBackground: '#fff', tag: 'Detected', action: { via: 'injected', rdns: null }, sub: 'In this browser' });
  for (const id of WALLET_APPS) {
    const m = apps[id];
    const rdns = m?.rdns;
    if (rdns && seen.has(rdns)) continue;
    const base = { connector: id, name: NAMES[id], icon: m?.icon ?? null, iconBackground: m?.iconBackground ?? '#fff' };
    if (id === 'walletConnect') {
      out.push({
        ...base,
        tag: null,
        sub: 'Scan with any mobile wallet',
        action: env.walletConnect ? { via: 'walletConnect', app: null } : { via: 'disabled', hint: 'Not set up on this server yet' },
      });
      continue;
    }
    if (id === 'coinbaseWallet') {
      out.push({ ...base, tag: null, sub: env.mobile ? 'Open the Coinbase app' : 'Extension or passkey', action: { via: 'coinbaseWallet' } });
      continue;
    }
    if (env.mobile && env.walletConnect) {
      out.push({ ...base, tag: null, sub: `Open the ${NAMES[id]} app`, action: { via: 'walletConnect', app: id } });
      continue;
    }
    const url = m ? installUrl(m, env, ua) : null;
    out.push({
      ...base,
      tag: 'Install',
      sub: env.walletConnect && !env.mobile ? 'Scan with the app, or install' : env.mobile ? 'Get the app' : 'Get the extension',
      action: env.walletConnect && !env.mobile ? { via: 'walletConnect', app: id } : url ? { via: 'install', url } : { via: 'disabled', hint: 'Not available here' },
    });
  }
  return out;
}

export function pickerEnv(walletConnect: boolean): PickerEnv {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const browser = /Edg\//.test(ua) ? 'edge' : /OPR\//.test(ua) ? 'opera' : /Firefox\//.test(ua) ? 'firefox' : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
  const eth = typeof window !== 'undefined' ? (window as unknown as { ethereum?: unknown }).ethereum : undefined;
  return { mobile: /Android|iPhone|iPad|iPod/i.test(ua), walletConnect, browser, legacyInjected: !!eth };
}
