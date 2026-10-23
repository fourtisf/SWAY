'use client';
/** [A] Wallet modals: connect/add, deposit (QR), withdraw, Sway wallet backup and import, rename, remove. */
import { usdToWei, weiToEth } from '@sway/curve';
import { LOCAL_CHAIN_ID, WALLET_LABEL_MAX, shortAddress, type Address } from '@sway/shared';
import { useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { isAddress } from 'viem';
import { errorMessage, getApi, isAuthRequired } from '@/lib/api';
import { MOCK } from '@/lib/env';
import { useEthUsd, useFormat } from '@/lib/format';
import { invalidateMoney, useConfig, useMe, useWallets } from '@/lib/queries';
import { closeModal, openModal, toast } from '@/lib/store';
import { useMemberWallets, type MemberWallet } from '@/lib/wallet';
import { burnerAddress, findBurnerKey, parsePrivateKey } from '@/lib/wallet/burner';
import { mockPrivateKey } from '@/lib/wallet/mock';
import { copyAddress, openConnectWallet, useWalletActions } from '@/lib/wallet-actions';
import { Icon } from '../icons';
import { Spinner } from '../ui';
import { WalletLogo } from './WalletLogo';
import { WalletPickerBody, type PickerResult } from './WalletPicker';

function Head({ title }: { title: string }) {
  return (
    <div className="m-h">
      <h3>{title}</h3>
      <button className="x-btn" aria-label="Close" onClick={closeModal}>
        <Icon name="close" />
      </button>
    </div>
  );
}

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Small wallet chooser (logo + name + short address) used by Deposit and Withdraw. */
export function WalletChips({ wallets, value, onChange }: { wallets: MemberWallet[]; value: string | null; onChange: (a: string) => void }) {
  return (
    <div className="wchips" role="radiogroup" aria-label="Wallet">
      {wallets.map((w) => (
        <button key={w.address} role="radio" aria-checked={same(w.address, value)} className={`wchip ${same(w.address, value) ? 'on' : ''}`} onClick={() => onChange(w.address)}>
          <WalletLogo connector={w.connector} kind={w.kind} size={20} />
          <span>{w.name}</span>
          <small>{shortAddress(w.address)}</small>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ connect / add */

export function ConnectWalletModal({ purpose, address }: { purpose: 'add' | 'reconnect'; address?: string }) {
  const actions = useWalletActions();
  const { setActive } = useMemberWallets();
  const done = async (r: PickerResult) => {
    closeModal();
    if (r.how === 'linked') await actions.linked(r.me, r.address, r.name);
    else {
      setActive(r.address);
      toast(`${r.name} connected`);
    }
  };
  return (
    <>
      <Head title={purpose === 'add' ? 'Add a wallet' : 'Connect a wallet'} />
      <div className="m-b">
        <WalletPickerBody purpose={purpose} focus={address} onDone={done} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ deposit */

function useQr(text: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    setSrc(null);
    if (text) QRCode.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: 'M' }).then((s) => !dead && setSrc(s), () => null);
    return () => {
      dead = true;
    };
  }, [text]);
  return src;
}

export function DepositModal() {
  const cfg = useConfig().data;
  const { wallets, active } = useMemberWallets();
  const balances = useWallets(wallets.length > 0).data;
  const F = useFormat();
  const actions = useWalletActions();
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const addr = pick ?? active?.address ?? null;
  const w = wallets.find((x) => same(x.address, addr));
  const qr = useQr(addr);
  const local = cfg?.chainId === LOCAL_CHAIN_ID;
  const cash = balances?.wallets.find((x) => same(x.address, addr))?.cashWei;
  const chainName = cfg?.chainName || 'Robinhood Chain';
  if (!addr) return null;
  return (
    <>
      <Head title="Deposit" />
      <div className="m-b">
        <p className="t2" style={{ margin: '0 0 14px' }}>
          Send ETH on {chainName} to {w ? `your ${w.name}` : 'your wallet'}. It shows up here in dollars once it lands.
        </p>
        {wallets.length > 1 && <WalletChips wallets={wallets} value={addr} onChange={setPick} />}
        <div className="dep">
          <div className="qr">{qr ? <img src={qr} alt={`QR code for ${addr}`} /> : <Spinner />}</div>
          <div className="dep-i">
            <div>
              <small>Network</small>
              <b>{chainName}</b>
            </div>
            <div>
              <small>Chain ID</small>
              <b>{cfg?.chainId ?? '…'}</b>
            </div>
            <div>
              <small>Balance</small>
              <b>{cash !== undefined ? F.$(weiToEth(cash)) : '…'}</b>
            </div>
          </div>
        </div>
        <div className="row">
          <input className="field mono" readOnly value={addr} aria-label="Wallet address" onFocus={(e) => e.currentTarget.select()} />
          <button className="btn btn-glass" style={{ height: 46 }} onClick={() => copyAddress(addr)}>
            <Icon name="copy" />
            Copy
          </button>
        </div>
        <p className="t3" style={{ fontSize: 12.5, margin: '10px 0 0' }}>
          Only send ETH on {chainName} (chain {cfg?.chainId}). Funds sent on another network don’t arrive here.
        </p>
        {cfg?.parentChain && (
          <button className="btn btn-glass btn-block" id="dep-eth" style={{ marginTop: 14 }} onClick={() => openModal({ type: 'bridgeIn' })}>
            <Icon name="down" />
            Have ETH on {cfg.parentChain.name}? Move it here
          </button>
        )}
        {(local || cfg?.faucetUrl) && (
          <div className="row" style={{ marginTop: 16 }}>
            {local && (
              <button
                className="btn btn-white btn-block"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await actions.testFunds(addr);
                  setBusy(false);
                }}
              >
                {busy ? <Spinner /> : <Icon name="down" />}
                Get test funds
              </button>
            )}
            {!local && cfg?.faucetUrl && (
              <a className="btn btn-white btn-block" href={cfg.faucetUrl} target="_blank" rel="noopener noreferrer">
                Open the testnet faucet
              </a>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ withdraw */

export function WithdrawModal() {
  const cfg = useConfig().data;
  const { wallets, active } = useMemberWallets();
  const balances = useWallets(wallets.length > 0).data;
  const F = useFormat();
  const ethUsd = useEthUsd();
  const qc = useQueryClient();
  const sway = wallets.filter((w) => w.kind === 'embedded');
  const [pick, setPick] = useState<string | null>(null);
  const [amt, setAmt] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const from = pick ?? (active?.kind === 'embedded' ? active.address : (sway.find((w) => w.usable) ?? sway[0])?.address ?? active?.address ?? null);
  const w = wallets.find((x) => same(x.address, from));
  const cash = BigInt(balances?.wallets.find((x) => same(x.address, from))?.cashWei ?? '0');
  const chainName = cfg?.chainName || 'Robinhood Chain';

  const send = async () => {
    if (!w) return;
    if (!w.wallet) return openConnectWallet(w.address);
    const usd = parseFloat(amt) || 0;
    const wei = usdToWei(usd, ethUsd);
    if (!(usd > 0) || wei > cash) return toast('Enter an amount up to this wallet’s balance');
    if (!MOCK && !isAddress(to)) return toast('Enter a valid wallet address');
    if (!MOCK && same(to, w.address)) return toast('That’s this wallet. Enter where the money should go.');
    setBusy(true);
    try {
      const dest = (isAddress(to) ? to : w.address) as Address;
      const hash = await w.wallet.sendEth(dest, wei);
      await w.wallet.waitForReceipt(hash);
      await getApi().withdrawLog({ label: 'Withdrawal to external wallet', amountWei: (-wei).toString(), txHash: hash });
      closeModal();
      toast(`Sent ${F.$(weiToEth(wei))} in ETH`);
      await invalidateMoney(qc);
    } catch (e) {
      if (!isAuthRequired(e)) toast(errorMessage(e));
    }
    setBusy(false);
  };

  return (
    <>
      <Head title="Withdraw in dollars" />
      <div className="m-b">
        {wallets.length > 1 && <WalletChips wallets={wallets} value={from} onChange={setPick} />}
        {w && w.kind === 'external' ? (
          <div className="note" style={{ marginBottom: 4 }}>
            <b style={{ color: 'var(--tx)' }}>{w.name} is your own wallet.</b> Send from the {w.name} app: Sway can only move money out of a Sway wallet.
          </div>
        ) : (
          <>
            <label className="lbl" htmlFor="wd-a">
              Amount (USD)
            </label>
            <div className="amt" style={{ marginBottom: 6 }}>
              <input id="wd-a" inputMode="decimal" placeholder="0.00" style={{ fontSize: 28 }} autoFocus value={amt} onChange={(e) => setAmt(e.target.value)} />
            </div>
            <div className="row t3" style={{ fontSize: 12.5, justifyContent: 'space-between', marginBottom: 14 }}>
              <span>Available {F.$(weiToEth(cash))}</span>
              <button className="lnk" onClick={() => setAmt((Math.floor(weiToEth(cash) * ethUsd * 100) / 100).toFixed(2))}>
                Max
              </button>
            </div>
            <label className="lbl" htmlFor="wd-to">
              Send to
            </label>
            <input className="field" id="wd-to" placeholder="0x… wallet address" style={{ marginBottom: 8 }} value={to} onChange={(e) => setTo(e.target.value.trim())} />
            <p className="t3" style={{ fontSize: 12.5, margin: '0 0 16px' }}>
              Sends ETH worth this amount on {chainName}; the network fee comes out of this wallet. Payouts in USDC arrive once the swap route is live.
            </p>
            <button className="btn btn-white btn-lg btn-block" disabled={busy || !w} onClick={send}>
              {busy ? <Spinner /> : null}
              {w && !w.wallet ? 'Connect this wallet' : 'Withdraw'}
            </button>
          </>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ Sway wallet backup / import */

export function BackupModal({ address }: { address: string }) {
  const me = useMe().data;
  const [ok, setOk] = useState(false);
  const [shown, setShown] = useState(false);
  const pk = useMemo(() => {
    if (!me) return null;
    const k = findBurnerKey(me.user.id, address);
    return k ?? (MOCK ? mockPrivateKey(address) : null);
  }, [me, address]);
  return (
    <>
      <Head title="Back up Sway wallet" />
      <div className="m-b">
        {!pk ? (
          <p className="t2">This wallet’s key isn’t in this browser, so it can only be backed up from the browser that made it.</p>
        ) : !shown ? (
          <>
            <div className="warnbox">
              <Icon name="lock" />
              <div>
                <b>Anyone with this key controls the wallet and everything in it.</b>
                <ul>
                  <li>It was made in this browser and never leaves it: Sway can’t see it or recover it for you.</li>
                  <li>Never share it, and never paste it into a site or chat you don’t trust.</li>
                  <li>Keep it offline or in a password manager.</li>
                </ul>
              </div>
            </div>
            <label className="chk">
              <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />I understand. Show the private key for {shortAddress(address)}.
            </label>
            <button className="btn btn-white btn-lg btn-block" disabled={!ok} onClick={() => setShown(true)}>
              Show private key
            </button>
          </>
        ) : (
          <>
            <label className="lbl">Private key of {shortAddress(address)}</label>
            <div className="pk mono" data-testid="private-key">
              {pk}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="btn btn-glass btn-block"
                onClick={() => {
                  navigator.clipboard?.writeText(pk).catch(() => null);
                  toast('Private key copied');
                }}
              >
                <Icon name="copy" />
                Copy key
              </button>
              <button className="btn btn-white btn-block" onClick={closeModal}>
                Done
              </button>
            </div>
            <p className="t3" style={{ fontSize: 12.5, margin: '12px 0 0' }}>
              To use this wallet in another browser, open Wallet → Import Sway wallet there and paste this key.
            </p>
          </>
        )}
      </div>
    </>
  );
}

export function ImportModal() {
  const { wallets } = useMemberWallets();
  const actions = useWalletActions();
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const pk = parsePrivateKey(raw);
  const address = pk ? burnerAddress(pk) : null;
  const mine = address ? wallets.find((w) => same(w.address, address)) : undefined;
  return (
    <>
      <Head title="Import Sway wallet" />
      <div className="m-b">
        <p className="t2" style={{ margin: '0 0 14px' }}>
          Paste the private key from your backup. It stays in this browser: Sway never receives it.
        </p>
        <label className="lbl" htmlFor="imp-k">
          Private key
        </label>
        <textarea
          id="imp-k"
          className="field mono pk-in"
          rows={3}
          spellCheck={false}
          autoComplete="off"
          placeholder="0x…"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
        <p className="t3" style={{ fontSize: 12.5, margin: '8px 0 16px', minHeight: 18 }}>
          {!raw.trim()
            ? '64 hexadecimal characters, with or without 0x.'
            : !address
              ? 'That doesn’t look like a private key.'
              : mine
                ? `${mine.name} ${shortAddress(address)}: one of your wallets. It will work in this browser.`
                : `Wallet ${shortAddress(address)}: it will be added to your wallets.`}
        </p>
        <button
          className="btn btn-white btn-lg btn-block"
          disabled={!pk || busy}
          onClick={async () => {
            setBusy(true);
            await actions.importKey(raw);
            setBusy(false);
          }}
        >
          {busy ? <Spinner /> : null}
          Import
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ rename / remove */

export function RenameModal({ address }: { address: string }) {
  const { wallets } = useMemberWallets();
  const actions = useWalletActions();
  const w = wallets.find((x) => same(x.address, address));
  const [label, setLabel] = useState(w?.label ?? '');
  const save = () => actions.rename(address, label);
  return (
    <>
      <Head title="Rename wallet" />
      <div className="m-b">
        <label className="lbl" htmlFor="wl-n">
          Name for {shortAddress(address)}
        </label>
        <input
          className="field"
          id="wl-n"
          autoFocus
          maxLength={WALLET_LABEL_MAX}
          placeholder={w ? w.name : 'e.g. Trading'}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          style={{ marginBottom: 16 }}
        />
        <button className="btn btn-white btn-lg btn-block" onClick={save}>
          Save
        </button>
      </div>
    </>
  );
}

export function RemoveModal({ address }: { address: string }) {
  const { wallets } = useMemberWallets();
  const actions = useWalletActions();
  const w = wallets.find((x) => same(x.address, address));
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Head title="Remove wallet?" />
      <div className="m-b">
        <p className="t2" style={{ margin: '0 0 16px' }}>
          {w ? `${w.name} ${shortAddress(address)}` : shortAddress(address)} stays yours and keeps its money and keys. They just stop counting toward your rooms, holder posts and
          points. You can add it again later.
        </p>
        <div className="row">
          <button className="btn btn-glass btn-block" onClick={closeModal}>
            Cancel
          </button>
          <button
            className="btn btn-sell btn-block"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await actions.remove(address);
              setBusy(false);
            }}
          >
            Remove
          </button>
        </div>
      </div>
    </>
  );
}

export function AccountWalletModal({ address }: { address: string }) {
  const { wallets } = useMemberWallets();
  const actions = useWalletActions();
  const w = wallets.find((x) => same(x.address, address));
  const current = wallets.find((x) => x.account);
  const [busy, setBusy] = useState(false);
  const name = (x: MemberWallet | undefined, a: string) => (x ? `${x.name} ${shortAddress(a)}` : shortAddress(a));
  return (
    <>
      <Head title="Make it your account wallet?" />
      <div className="m-b">
        <p className="t2" style={{ margin: '0 0 12px' }}>
          Your key market, token launch and creator earnings use your account wallet. {name(w, address)} takes that role
          {current ? `; ${name(current, current.address)} stays added, with its money and keys` : ''}.
        </p>
        <p className="t3" style={{ fontSize: 12.5, margin: '0 0 16px' }}>
          You can switch until your key market is onchain (its first buy or your launch). After that it stays with the
          wallet it opened at.
        </p>
        <div className="row">
          <button className="btn btn-glass btn-block" onClick={closeModal}>
            Cancel
          </button>
          <button
            className="btn btn-white btn-block"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await actions.makeAccount(address);
              setBusy(false);
            }}
          >
            Make account wallet
          </button>
        </div>
      </div>
    </>
  );
}
