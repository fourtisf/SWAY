'use client';
import { unitsToKeys, weiToEth } from '@sway/curve';
import { minutesSince, shortAddress } from '@sway/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/icons';
import { Avatar, Empty, Loading, NeedUser, VB } from '@/components/ui';
import { useActions } from '@/lib/actions';
import { useFormat } from '@/lib/format';
import { useMe, useWallet } from '@/lib/queries';
import { openModal } from '@/lib/store';

export default function WalletPage() {
  const me = useMe();
  const { data: w } = useWallet(!!me.data?.wallet);
  const F = useFormat();
  const router = useRouter();
  const { claimEarnings, deposit, openTrade } = useActions();
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
            Create my Sway wallet
          </button>
        }
      >
        Your Sway wallet on Robinhood Chain holds your keys and earnings.
      </Empty>
    );
  if (!w) return <Loading />;
  const cash = weiToEth(w.cashWei),
    pv = weiToEth(w.keysValueWei),
    e = w.earnings,
    cl = weiToEth(e.totalWei);
  const kh = unitsToKeys(w.keys.units);
  return (
    <>
      <div className="bal">
        <div className="bal-in">
          <div className="between">
            <span className="t2" style={{ fontWeight: 600, fontSize: 13.5 }}>
              Sway wallet
            </span>
            <span className="tag line">{shortAddress(w.address)}</span>
          </div>
          <div className="bal-v">{F.$(cash + pv)}</div>
          <div className="t3" style={{ fontSize: 13 }}>
            {`${F.$(cash)} cash  +  ${F.$(pv)} in keys  on Robinhood Chain`}
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
          Claimed so far {F.$(weiToEth(e.claimedWei))}. Earnings are claimed from the contract, never held by the app.
        </div>
      </div>
      <div className="sec-h">
        <h2>Your keys</h2>
        <span className="t3" style={{ fontSize: 13 }}>
          {F.keys(kh)} keys across {w.keys.markets} creator{w.keys.markets === 1 ? '' : 's'}
        </span>
      </div>
      {w.holdings.length ? (
        w.holdings.map((h) => {
          const c = h.market;
          return (
            <div key={c.handle} className="tr clickable" style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto' }} onClick={() => router.push(`/${c.handle}`)}>
              <div className="row" style={{ minWidth: 0 }}>
                <Avatar u={c} size={40} />
                <div style={{ minWidth: 0 }}>
                  <div className="nm">
                    <b>{c.name}</b>
                    <VB v={c.verified} />
                  </div>
                  <div className="hd">{F.keys(unitsToKeys(h.units))} keys</div>
                </div>
              </div>
              <div className="num">
                <b>{F.$(weiToEth(h.valueWei))}</b>
                <small className={c.change >= 0 ? 'up' : 'dn'}>{F.pct(c.change)}</small>
              </div>
              <button
                className="btn btn-glass btn-sm"
                onClick={(ev) => {
                  ev.stopPropagation();
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
