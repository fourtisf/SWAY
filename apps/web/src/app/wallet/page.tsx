'use client';
import { unitsToKeys, weiToEth } from '@sway/curve';
import { minutesSince, shortAddress, type HoldingDTO, type WalletBalanceDTO } from '@sway/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/icons';
import { AirdropsCard, StakeCard } from '@/components/launch/Cards'; // [C]
import { Avatar, Empty, Loading, NeedUser, Spinner, VB } from '@/components/ui';
import { WalletLogo } from '@/components/wallet/WalletLogo';
import { useActions } from '@/lib/actions';
import { MOCK } from '@/lib/env';
import { useFormat } from '@/lib/format';
import { useConfig, useMe, useWallet } from '@/lib/queries';
import { openModal } from '@/lib/store';
import { useMemberWallets, type MemberWallet } from '@/lib/wallet';
import { copyAddress, openConnectWallet, useWalletActions } from '@/lib/wallet-actions';

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** PnL in percent of what was paid, written +x% / −x%. */
function pnl(h: HoldingDTO): { pct: number; text: string } | null {
  if (h.costBasisWei === undefined || h.unrealizedPnlWei === undefined) return null;
  const basis = weiToEth(h.costBasisWei);
  if (!(basis > 0)) return null;
  const pct = (weiToEth(h.unrealizedPnlWei) / basis) * 100;
  return { pct, text: `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%` };
}

const STATUS: Record<string, string> = {
  'needs-external': 'not connected here',
  'missing-key': 'key not in this browser',
  unsupported: 'not available yet',
};

function WalletMenu({ mw, active }: { mw: MemberWallet; active: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const actions = useWalletActions();
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);
  const item = (label: string, fn: () => void, danger = false) => (
    <span
      className="it"
      role="menuitem"
      style={danger ? { color: 'var(--red)' } : undefined}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
        fn();
      }}
    >
      {label}
    </span>
  );
  return (
    <span
      ref={ref}
      className="icon-btn wl-menu"
      role="button"
      aria-label={`Wallet menu for ${mw.name}`}
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(!open);
      }}
    >
      <Icon name="dots" />
      {open && (
        <span className="sres" role="menu">
          {mw.usable && !active && item('Use for trading', () => actions.activate(mw))}
          {!mw.usable && mw.kind === 'external' && item('Connect in this browser', () => openConnectWallet(mw.address))}
          {!mw.usable && mw.kind === 'embedded' && item('Import its key', () => openModal({ type: 'walletImport' }))}
          {item('Copy address', () => copyAddress(mw.address))}
          {mw.kind === 'embedded' && mw.usable && item('Back up Sway wallet', () => openModal({ type: 'walletBackup', address: mw.address }))}
          {!mw.account && item('Rename', () => openModal({ type: 'walletRename', address: mw.address }))}
          {!mw.account && item('Remove', () => openModal({ type: 'walletRemove', address: mw.address }), true)}
        </span>
      )}
    </span>
  );
}

function WalletRow({ mw, bal, active, ready }: { mw: MemberWallet; bal: WalletBalanceDTO | undefined; active: boolean; ready: boolean }) {
  const F = useFormat();
  const actions = useWalletActions();
  const [busy, setBusy] = useState(false);
  const earn = bal ? BigInt(bal.earnings.totalWei) : 0n;
  const total = bal ? weiToEth(bal.cashWei) + weiToEth(bal.keysValueWei) : 0;
  return (
    <div className={`tr wl clickable ${active ? 'me' : ''}`} data-wallet={mw.connector ?? ''} onClick={() => actions.activate(mw)}>
      <WalletLogo connector={mw.connector} kind={mw.kind} size={40} />
      <div style={{ minWidth: 0 }}>
        <div className="nm wl-nm">
          <b>{mw.name}</b>
          {mw.account ? <span className="tag">Account</span> : <span className="tag line">Linked</span>}
          {active && <span className="tag aqua">Active</span>}
        </div>
        <div className="hd wl-sub">
          {shortAddress(mw.address)}
          {!mw.usable && ready && STATUS[mw.status] ? ` · ${STATUS[mw.status]}` : ''}
        </div>
      </div>
      <div className="num">
        <b>{bal ? F.$(total) : '…'}</b>
        <small>{bal ? (BigInt(bal.keysValueWei) > 0n ? `${F.$(weiToEth(bal.keysValueWei))} in keys` : 'cash') : ''}</small>
      </div>
      <div className="row" style={{ gap: 6 }}>
        {earn > 0n && bal && (
          <button
            className="btn btn-buy btn-sm"
            disabled={busy}
            onClick={async (e) => {
              e.stopPropagation();
              setBusy(true);
              await actions.claim(mw, bal.earnings);
              setBusy(false);
            }}
          >
            {busy ? <Spinner size={12} /> : null}
            Claim<span className="hm">{F.$(weiToEth(earn))}</span>
          </button>
        )}
        <WalletMenu mw={mw} active={active} />
      </div>
    </div>
  );
}

export default function WalletPage() {
  const me = useMe();
  const { data: w } = useWallet(!!me.data?.wallet);
  const cfg = useConfig().data;
  const F = useFormat();
  const router = useRouter();
  const { claimEarnings, deposit, openTrade } = useActions();
  const { wallets, active, ready, setActive } = useMemberWallets();
  const [busy, setBusy] = useState(false);
  if (me.isPending) return <Loading />;
  if (!me.data) return <NeedUser title="Connect X to open your wallet" text="A Sway wallet on Robinhood Chain is created when you sign in. Balances and earnings show in dollars." />;
  if (!me.data.wallet)
    return (
      <Empty
        icon="wallet"
        title="Finish setting up your wallet"
        action={
          <button className="btn btn-white" onClick={() => openModal({ type: 'onboard' })}>
            Set up my wallet
          </button>
        }
      >
        Create a Sway wallet on Robinhood Chain or connect your own. It holds your keys and earnings.
      </Empty>
    );
  if (!w) return <Loading />;
  const cash = weiToEth(w.cashWei),
    pv = weiToEth(w.keysValueWei),
    e = w.earnings,
    cl = weiToEth(e.totalWei);
  const kh = unitsToKeys(w.keys.units);
  const many = wallets.length > 1;
  const bal = (a: string) => w.wallets?.find((x) => same(x.address, a));
  const byAddr = (a?: string) => wallets.find((x) => same(x.address, a));
  const swayOk = MOCK || cfg?.wallets.embedded === 'burner';
  return (
    <>
      <div className="bal">
        <div className="bal-in">
          <div className="between">
            <span className="t2" style={{ fontWeight: 600, fontSize: 13.5 }}>
              {many ? `All wallets` : (active?.name ?? 'Sway wallet')}
            </span>
            <span className="tag line">{many ? `${wallets.length} wallets` : shortAddress(w.address)}</span>
          </div>
          <div className="bal-v">{F.$(cash + pv)}</div>
          <div className="t3" style={{ fontSize: 13 }}>
            {`${F.$(cash)} cash  +  ${F.$(pv)} in keys  on Robinhood Chain`}
          </div>
          <div className="bal-acts">
            <button className="btn btn-white" style={{ flex: 1 }} onClick={() => deposit()}>
              <Icon name="down" />
              Deposit
            </button>
            <button className="btn btn-glass" style={{ flex: 1 }} onClick={() => openModal({ type: 'withdraw' })}>
              <Icon name="upA" />
              Withdraw
            </button>
          </div>
        </div>
      </div>

      {/* [A] every wallet of the member */}
      <div className="sec-h">
        <h2>Your wallets</h2>
        <button className="btn btn-glass btn-sm" onClick={() => openModal({ type: 'wallets', purpose: 'add' })}>
          <Icon name="plus" />
          Add wallet
        </button>
      </div>
      <div className="wl-list">
        {wallets.map((mw) => (
          <WalletRow key={mw.address} mw={mw} bal={bal(mw.address)} active={same(active?.address, mw.address)} ready={ready} />
        ))}
      </div>
      <div className="t3 wl-foot">
        {many ? 'Keys in every wallet count together for rooms, holder posts and points. ' : 'Add MetaMask, Coinbase, Rabby or any wallet: their keys count toward your rooms. '}
        {swayOk && (
          <>
            Sway wallet keys never leave this browser.{' '}
            <button className="lnk" style={{ fontSize: 13 }} onClick={() => openModal({ type: 'walletImport' })}>
              Import Sway wallet
            </button>
          </>
        )}
      </div>

      <div className="glass earn">
        <div className="between">
          <div>
            <div className="t3" style={{ fontSize: 12.5, fontWeight: 600 }}>
              Earnings to claim
            </div>
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.04em' }}>{F.$(cl)}</div>
          </div>
          <button
            className="btn btn-buy"
            disabled={!(BigInt(e.totalWei) > 0n) || busy}
            onClick={async () => {
              setBusy(true);
              await claimEarnings(w);
              setBusy(false);
            }}
          >
            Claim
          </button>
        </div>
        <div style={{ marginTop: 10 }}>
          <div className="earn-r">
            <span>Creator fees from your keys</span>
            <b>{F.$(weiToEth(e.creatorWei))}</b>
          </div>
          <div className="earn-r">
            <span>Holder rewards</span>
            <b>{F.$(weiToEth(e.holderWei))}</b>
          </div>
          <div className="earn-r">
            <span>Referral share</span>
            <b>{F.$(weiToEth(e.referralWei))}</b>
          </div>
        </div>
        <div className="t3" style={{ fontSize: 12.5, marginTop: 6 }}>
          Claimed so far {F.$(weiToEth(e.claimedWei))}. Earnings are claimed from the contract, never held by the app{many ? ', one claim per wallet' : ''}.
        </div>
      </div>
      {/* [C] token airdrops and staking */}
      <AirdropsCard />
      <StakeCard level={me.data.stakingLevel} />
      <div className="sec-h">
        <h2>Your keys</h2>
        <span className="t3" style={{ fontSize: 13 }}>
          {F.keys(kh)} keys across {w.keys.markets} creator{w.keys.markets === 1 ? '' : 's'}
        </span>
      </div>
      {w.holdings.length ? (
        w.holdings.map((h) => {
          const c = h.market;
          const hw = byAddr(h.address);
          const pl = pnl(h);
          return (
            <div key={`${c.handle}:${h.address ?? ''}`} className="tr clickable" style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto' }} onClick={() => router.push(`/${c.handle}`)}>
              <div className="row" style={{ minWidth: 0 }}>
                <Avatar u={c} size={40} />
                <div style={{ minWidth: 0 }}>
                  <div className="nm">
                    <b>{c.name}</b>
                    <VB v={c.verified} />
                  </div>
                  <div className="hd row" style={{ gap: 5 }}>
                    {F.keys(unitsToKeys(h.units))} keys
                    {many && hw && (
                      <span className="wl-in" title={`In ${hw.name} ${shortAddress(hw.address)}`}>
                        <WalletLogo connector={hw.connector} kind={hw.kind} size={16} />
                        {hw.name}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="num">
                <b>{F.$(weiToEth(h.valueWei))}</b>
                {pl ? (
                  <small className={`pnl ${pl.pct >= 0 ? 'up' : 'dn'}`} title={`Profit or loss on ${F.$(weiToEth(h.costBasisWei ?? '0'))} paid`}>
                    {pl.text}
                  </small>
                ) : (
                  <small className={c.change >= 0 ? 'up' : 'dn'}>{F.pct(c.change)}</small>
                )}
              </div>
              <button
                className="btn btn-glass btn-sm"
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (hw?.usable) setActive(hw.address);
                  openTrade(c.handle, 'sell');
                }}
              >
                Sell
              </button>
            </div>
          );
        })
      ) : (
        <div className="t3" style={{ padding: '0 18px 10px', fontSize: 13.5 }}>
          No keys yet.{' '}
          <Link className="lnk" href="/explore" style={{ textDecoration: 'underline' }}>
            Find creators
          </Link>
        </div>
      )}
      <div className="sec-h">
        <h2>Activity</h2>
      </div>
      {w.activity.length ? (
        w.activity.map((a) => {
          const amt = weiToEth(a.amountWei);
          return (
            <div key={a.id} className="tr" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
              <div style={{ minWidth: 0 }}>
                <b style={{ fontSize: 14 }}>{a.label}</b>
                <div className="hd">{minutesSince(a.createdAt) < 1 ? 'now' : `${F.ago(minutesSince(a.createdAt))} ago`}</div>
              </div>
              <b className={amt >= 0 ? 'up' : ''}>
                {amt >= 0 ? '+' : '−'}
                {F.$(Math.abs(amt))}
              </b>
            </div>
          );
        })
      ) : (
        <div className="t3" style={{ padding: '0 18px', fontSize: 13.5 }}>
          Trades, claims and withdrawals show up here.
        </div>
      )}
    </>
  );
}
