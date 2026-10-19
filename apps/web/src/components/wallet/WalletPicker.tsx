'use client';
/**
 * [A] "Connect a wallet": the Sway wallet, browser wallets announced through EIP-6963 (with their own icon),
 * then a curated list whose logos come from RainbowKit's wallet definitions. Connecting goes through wagmi
 * connectors (lib/wallet/external), then the member signs a free message to link the wallet: as the account
 * wallet (onboarding) or as an extra one. Mock mode simulates every wallet app.
 */
import type { Address, MeDTO, WalletApp } from '@sway/shared';
import { shortAddress } from '@sway/shared';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState } from 'react';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ApiRequestError, errorMessage } from '@/lib/api';
import { MOCK } from '@/lib/env';
import { useConfig, useMe } from '@/lib/queries';
import { openModal } from '@/lib/store';
import { createExtraSwayWallet, linkWallet, useExternalWallet, useMemberWallets, type SwayWallet } from '@/lib/wallet';
import { pickerEntries, pickerEnv, useWalletCatalog, type DetectedWallet, type Logo, type PickerEntry } from '@/lib/wallet/catalog';
import { mockWallet } from '@/lib/wallet/mock';
import { Icon } from '../icons';
import { Spinner } from '../ui';
import { LogoBox } from './WalletLogo';

export type PickerPurpose = 'account' | 'add' | 'reconnect';
export type PickerResult = { how: 'linked'; me: MeDTO; address: Address; name: string } | { how: 'connected'; address: Address; name: string };

type Phase =
  | { t: 'list' }
  | { t: 'connecting'; e: PickerEntry }
  | { t: 'qr'; e: PickerEntry; uri: string }
  | { t: 'network'; e: PickerEntry; sw: SwayWallet; chainId: number }
  | { t: 'signing'; e: PickerEntry }
  | { t: 'error'; e: PickerEntry | null; msg: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const SWAY_ENTRY: PickerEntry = {
  connector: 'sway',
  name: 'Sway wallet',
  icon: null,
  iconBackground: '#0F1419',
  tag: null,
  action: { via: 'disabled', hint: '' },
  sub: 'A new wallet made in this browser. No extension.',
};

const logoOf = (e: PickerEntry): Logo =>
  e.connector === 'sway' ? { kind: 'sway' } : e.icon ? { kind: 'img', src: e.icon, bg: e.iconBackground, name: e.name } : { kind: 'generic', name: e.name };

function rejected(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && i < 6; x = (x as { cause?: unknown }).cause, i++) {
    const o = x as { name?: string; code?: number; message?: string };
    if (o.name === 'UserRejectedRequestError' || o.code === 4001 || /user rejected|user denied|rejected the request/i.test(o.message ?? '')) return true;
  }
  return false;
}

function friendly(e: unknown, entry: PickerEntry | null): string {
  const n = entry?.name ?? 'your wallet';
  if (rejected(e)) return `You cancelled in ${n}. Nothing was linked.`;
  if (e instanceof ApiRequestError) return e.message;
  const m = errorMessage(e);
  if (/provider not found|connector not found/i.test(m)) return `${n} isn’t available in this browser.`;
  return m;
}

/** The picker's body; the onboarding modal embeds it, ConnectWalletModal wraps it with a header. */
export function WalletPickerBody({
  purpose,
  focus,
  onDone,
  onBack,
}: {
  purpose: PickerPurpose;
  /** Reconnect this wallet of the member (shown first). */
  focus?: string;
  onDone: (r: PickerResult) => void;
  onBack?: () => void;
}) {
  const me = useMe().data;
  const cfg = useConfig().data;
  const apps = useWalletCatalog();
  const realDetected = useExternalWallet((s) => s.detected);
  const { wallets } = useMemberWallets();
  const [phase, setPhase] = useState<Phase>({ t: 'list' });
  const run = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    // Set on every mount: React's strict mode mounts, unmounts and mounts again in dev.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const wc = MOCK || !!cfg?.wallets.walletConnectProjectId;
  const env = useMemo(() => (MOCK ? { mobile: false, walletConnect: true, browser: 'chrome' as const, legacyInjected: false } : pickerEnv(wc)), [wc]);
  // Mock mode: pretend MetaMask and Rabby are installed so the list looks like a real browser's.
  const detected: DetectedWallet[] = useMemo(
    () =>
      MOCK
        ? [
            { rdns: 'io.metamask', name: 'MetaMask', icon: apps.metaMask?.icon ?? null },
            { rdns: 'io.rabby', name: 'Rabby Wallet', icon: apps.rabby?.icon ?? null },
          ]
        : realDetected,
    [apps, realDetected],
  );
  const focusWallet = focus ? wallets.find((w) => same(w.address, focus)) : undefined;
  const entries = useMemo(() => {
    const list = pickerEntries(apps, detected, env, typeof navigator !== 'undefined' ? navigator.userAgent : '');
    const swayOk = MOCK || cfg?.wallets.embedded === 'burner';
    const sway: PickerEntry[] =
      purpose === 'account' || !swayOk
        ? []
        : [{ ...SWAY_ENTRY, tag: wallets.some((w) => w.usable) ? null : 'Recommended' }];
    const all = [...sway, ...list];
    if (focusWallet?.connector) all.sort((a, b) => Number(b.connector === focusWallet.connector) - Number(a.connector === focusWallet.connector));
    return all;
  }, [apps, detected, env, purpose, cfg, wallets, focusWallet]);

  const start = async (e: PickerEntry) => {
    const token = ++run.current;
    const live = () => alive.current && token === run.current;
    if (!me || !cfg) return;
    try {
      let sw: SwayWallet;
      let chainId: number | null = null;
      if (e.connector === 'sway') {
        setPhase({ t: 'signing', e });
        sw = await createExtraSwayWallet(me.user.id, cfg);
      } else if (MOCK) {
        setPhase({ t: 'connecting', e });
        await sleep(650);
        if (e.action.via === 'walletConnect' && live()) {
          setPhase({ t: 'qr', e, uri: `wc:${generatePrivateKey().slice(2, 34)}@2?relay-protocol=irn&symKey=demo` });
          await sleep(1400);
        }
        sw = mockWallet(privateKeyToAccount(generatePrivateKey()).address, 'external');
      } else {
        const a = e.action;
        if (a.via === 'install') {
          window.open(a.url, '_blank', 'noopener');
          return;
        }
        if (a.via === 'disabled') return;
        const ext = useExternalWallet.getState().api;
        if (!ext) throw new Error('Wallet apps are still loading. Try again in a second.');
        setPhase({ t: 'connecting', e });
        const app = a.via === 'walletConnect' ? a.app : null;
        const meta = app ? apps[app as WalletApp] : undefined;
        const r = await ext.connect(a.via === 'walletConnect' ? { via: 'walletConnect' } : a, (uri) => {
          if (!live()) return;
          if (env.mobile) window.location.href = meta?.mobileUri?.(uri) ?? uri;
          else setPhase({ t: 'qr', e, uri: meta?.qrUri?.(uri) ?? uri });
        });
        sw = r.wallet;
        chainId = r.chainId;
      }
      if (!live()) return;
      const known = wallets.find((w) => same(w.address, sw.address));
      if (known && purpose !== 'account') return onDone({ how: 'connected', address: known.address, name: known.name });
      if (chainId !== null && chainId !== cfg.chainId) return setPhase({ t: 'network', e, sw, chainId });
      await sign(e, sw, live);
    } catch (err) {
      if (live()) setPhase({ t: 'error', e, msg: friendly(err, e) });
    }
  };

  const sign = async (e: PickerEntry, sw: SwayWallet, live: () => boolean) => {
    setPhase({ t: 'signing', e });
    if (MOCK) await sleep(400);
    const next = await linkWallet(sw, { as: purpose === 'account' ? 'account' : 'linked', connector: e.connector });
    if (live()) onDone({ how: 'linked', me: next, address: sw.address, name: e.name });
  };

  const switchThenSign = async (e: PickerEntry, sw: SwayWallet, doSwitch: boolean) => {
    const token = run.current;
    const live = () => alive.current && token === run.current;
    try {
      if (doSwitch) await useExternalWallet.getState().api?.switchChain(sw.address);
      if (live()) await sign(e, sw, live);
    } catch (err) {
      if (live()) setPhase({ t: 'error', e, msg: friendly(err, e) });
    }
  };

  const back = () => {
    run.current++;
    setPhase({ t: 'list' });
  };

  if (phase.t !== 'list') return <PhaseView phase={phase} chainName={cfg?.chainName ?? 'Robinhood Chain'} chainId={cfg?.chainId ?? 0} onBack={back} onRetry={(e) => (e ? start(e) : back())} onNetwork={switchThenSign} />;

  return (
    <div className="wpick">
      {purpose === 'add' && <p className="t2 wpick-p">Add another wallet. Keys in every wallet you add count toward your rooms, holder posts and points.</p>}
      {purpose === 'reconnect' && (
        <p className="t2 wpick-p">
          {focusWallet
            ? focusWallet.kind === 'embedded'
              ? `${focusWallet.name} ${shortAddress(focusWallet.address)} was made in another browser. Import its backup key to use it here, or connect another wallet.`
              : `Connect ${focusWallet.name} ${shortAddress(focusWallet.address)} to trade with it in this browser, or add another wallet.`
            : 'Connect one of your wallets to trade here, or add another one.'}
        </p>
      )}
      {purpose === 'account' && <p className="t2 wpick-p">This becomes your account wallet: it owns your key market and receives tips. You can add more wallets later.</p>}
      <div className="wlist" role="list">
        {entries.map((e) => {
          const off = e.action.via === 'disabled' && e.connector !== 'sway';
          return (
            <button key={e.connector} role="listitem" className="wopt" disabled={off} onClick={() => start(e)} data-wallet={e.connector}>
              <LogoBox logo={logoOf(e)} size={38} />
              <span className="wopt-t">
                <b>{e.name}</b>
                <small>{off && e.action.via === 'disabled' ? e.action.hint : e.sub}</small>
              </span>
              {e.tag && <span className={`tag ${e.tag === 'Detected' ? 'aqua' : e.tag === 'Install' ? 'line' : ''}`}>{e.tag}</span>}
            </button>
          );
        })}
      </div>
      {purpose !== 'account' && (MOCK || cfg?.wallets.embedded === 'burner') && (
        <p className="t3 wpick-f">
          Have a Sway wallet backup?{' '}
          <button className="lnk" style={{ fontSize: 13 }} onClick={() => openModal({ type: 'walletImport' })}>
            Import Sway wallet
          </button>
        </p>
      )}
      <p className="t3 wpick-f">Linking asks you to sign a free message that proves the wallet is yours. No transaction, no fee.</p>
      {onBack && (
        <button className="btn btn-glass btn-block" style={{ marginTop: 12 }} onClick={onBack}>
          Back
        </button>
      )}
    </div>
  );
}

function PhaseView({
  phase,
  chainName,
  chainId,
  onBack,
  onRetry,
  onNetwork,
}: {
  phase: Exclude<Phase, { t: 'list' }>;
  chainName: string;
  chainId: number;
  onBack: () => void;
  onRetry: (e: PickerEntry | null) => void;
  onNetwork: (e: PickerEntry, sw: SwayWallet, doSwitch: boolean) => void;
}) {
  const e = phase.e;
  const name = e?.name ?? 'your wallet';
  return (
    <div className="wphase">
      {e && <LogoBox logo={logoOf(e)} size={64} />}
      {phase.t === 'connecting' && (
        <>
          <h4>Opening {name}…</h4>
          <p className="t2">Confirm in {name} to continue.</p>
          <Spinner />
        </>
      )}
      {phase.t === 'qr' && <QrPanel uri={phase.uri} name={e!.connector === 'walletConnect' ? null : name} />}
      {phase.t === 'signing' && (
        <>
          <h4>{e?.connector === 'sway' ? 'Creating your Sway wallet…' : `Sign in ${name}`}</h4>
          <p className="t2">{e?.connector === 'sway' ? 'Its key stays in this browser. Back it up from the Wallet page.' : 'A free signature proves the wallet is yours. No transaction.'}</p>
          <Spinner />
        </>
      )}
      {phase.t === 'network' && (
        <>
          <h4>Switch to {chainName}</h4>
          <p className="t2">
            {name} is on another network (chain {phase.chainId}). Sway runs on {chainName} (chain {chainId}). Switch now, or later when you trade.
          </p>
          <div className="row" style={{ width: '100%' }}>
            <button className="btn btn-glass btn-block" onClick={() => onNetwork(phase.e, phase.sw, false)}>
              Not now
            </button>
            <button className="btn btn-white btn-block" onClick={() => onNetwork(phase.e, phase.sw, true)}>
              Switch network
            </button>
          </div>
        </>
      )}
      {phase.t === 'error' && (
        <>
          <h4>Couldn’t connect</h4>
          <p className="t2" style={{ color: 'var(--red)' }}>
            {phase.msg}
          </p>
          <div className="row" style={{ width: '100%' }}>
            <button className="btn btn-glass btn-block" onClick={onBack}>
              Back
            </button>
            <button className="btn btn-white btn-block" onClick={() => onRetry(phase.e)}>
              Try again
            </button>
          </div>
        </>
      )}
      {phase.t !== 'error' && phase.t !== 'network' && (
        <button className="lnk" style={{ fontSize: 14 }} onClick={onBack}>
          {phase.t === 'qr' ? 'Back to wallets' : 'Cancel'}
        </button>
      )}
    </div>
  );
}

function QrPanel({ uri, name }: { uri: string; name: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    QRCode.toDataURL(uri, { margin: 1, width: 440, errorCorrectionLevel: 'M' }).then((s) => !dead && setSrc(s), () => null);
    return () => {
      dead = true;
    };
  }, [uri]);
  return (
    <>
      <h4>{name ? `Scan with ${name}` : 'Scan with your phone'}</h4>
      <p className="t2">{name ? `Open ${name} on your phone and scan this code.` : 'Any WalletConnect wallet works: open it and scan.'}</p>
      <div className="qr">{src ? <img src={src} alt="WalletConnect QR code" /> : <Spinner />}</div>
      <button
        className="btn btn-glass btn-sm"
        onClick={() => {
          navigator.clipboard?.writeText(uri).catch(() => null);
        }}
      >
        <Icon name="copy" />
        Copy link
      </button>
    </>
  );
}
