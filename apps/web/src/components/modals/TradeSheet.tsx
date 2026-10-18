'use client';
import { CURVE, LEVEL_CUT, feePercent, keysToUnits, quoteWei, unitsToKeys, weiToEth, type QuoteWei } from '@sway/curve';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useActions } from '@/lib/actions';
import { useFormat } from '@/lib/format';
import { useMe, useProfile, useWallet } from '@/lib/queries';
import { closeModal, openModal } from '@/lib/store';
import { stepAmount } from '@/lib/util';
import { Icon } from '../icons';
import { Avatar, Loading, Spinner, VB } from '../ui';

const r2 = (v: number) => Math.round(v * 100) / 100;

export function TradeSheet({ handle, side: side0 }: { handle: string; side: 'buy' | 'sell' }) {
  const { data: p } = useProfile(handle);
  const me = useMe().data;
  const wallet = useWallet(!!me?.wallet).data;
  const F = useFormat();
  const actions = useActions();
  const pathname = usePathname();
  const router = useRouter();
  const [side, setSide] = useState(side0);
  const [amt, setAmt] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [showFees, setShowFees] = useState(false);
  const [busy, setBusy] = useState(false);

  const head = p && (
    <div className="m-h">
      <div className="row" style={{ minWidth: 0 }}>
        <Avatar u={p} size={44} />
        <div style={{ minWidth: 0 }}>
          <div className="nm">
            <b style={{ fontSize: 16 }}>{p.name}</b>
            <VB v={p.verified} />
          </div>
          <div className="hd">{`${F.$(weiToEth(p.priceWei))} per key  ${p.holders} holders`}</div>
        </div>
      </div>
      <button className="x-btn" aria-label="Close" onClick={closeModal}>
        <Icon name="close" />
      </button>
    </div>
  );
  if (!p) return <Loading />;

  const supply = BigInt(p.supplyUnits);
  const held = BigInt(p.heldUnits);
  const level = me?.stakingLevel ?? 0;
  const locked = 100n;
  let maxSellU = (p.isMe ? held - locked : held) < supply - locked ? (p.isMe ? held - locked : held) : supply - locked;
  if (maxSellU < 0n) maxSellU = 0n;
  const maxSell = unitsToKeys(maxSellU);
  const buy = side === 'buy';
  const base0 = amt ?? (buy ? 1 : Math.min(1, maxSell));
  const a = !buy && base0 > maxSell ? r2(maxSell) : base0;
  const units = keysToUnits(a);
  let q: QuoteWei | null = null;
  try {
    if (units >= 1n && (buy || units <= supply - locked)) q = quoteWei(supply, side, units, { level });
  } catch {
    q = null;
  }
  const now = weiToEth(p.priceWei);
  const total = q ? weiToEth(q.total) : 0;
  const after = q ? weiToEth(q.priceAfter) : now;
  const cash = wallet ? BigInt(wallet.cashWei) : 0n;
  const tooMuch = buy && !!q && q.total > cash;
  const bad = a < CURVE.MIN || (buy ? tooMuch : a > maxSell);
  const label = !me
    ? 'Connect X to trade'
    : bad
      ? buy
        ? tooMuch
          ? 'Not enough balance'
          : 'Minimum is 0.01 key'
        : maxSell < CURVE.MIN
          ? 'You have no keys to sell'
          : 'More than you hold'
      : `${buy ? 'Buy' : 'Sell'} ${F.keys(a)} key${a === 1 ? '' : 's'} for ${F.$(total)}`;
  const chg = (after / now - 1) * 100;
  const set = (v: number) => {
    setAmt(v);
    setText(null);
  };
  const exec = async () => {
    if (!q || bad) return;
    setBusy(true);
    await actions.execTrade(p, side, q);
    setBusy(false);
  };
  const sum = (l: string, v: number) => (
    <div className="sum-r">
      <span>{l}</span>
      <span>{F.$(v)}</span>
    </div>
  );

  return (
    <>
      {head}
      <div id="tradeSheet">
        <div className="trade">
          <div className="tside">
            <button
              className={`b ${buy ? 'on' : ''}`}
              onClick={() => {
                setSide('buy');
                set(1);
              }}
            >
              Buy
            </button>
            <button
              className={`s ${!buy ? 'on' : ''}`}
              onClick={() => {
                setSide('sell');
                set(Math.min(1, maxSell));
              }}
            >
              Sell
            </button>
          </div>
          <div className="amt-l">
            <span>Keys</span>
            <span>{buy ? `${F.$(now)} each` : `You hold ${F.keys(unitsToKeys(held))}`}</span>
          </div>
          <div className="amt">
            <button aria-label="Fewer keys" onClick={() => set(stepAmount(a, -1))}>
              <Icon name="minus" />
            </button>
            <input
              id="tamt"
              inputMode="decimal"
              aria-label="Number of keys"
              value={text ?? F.keys(a)}
              onChange={(e) => {
                const v = parseFloat(e.target.value.replace(',', '.'));
                setText(e.target.value);
                setAmt(isNaN(v) ? 0 : r2(v));
              }}
            />
            <button aria-label="More keys" onClick={() => set(stepAmount(a, 1))}>
              <Icon name="plus" />
            </button>
          </div>
          <div className="quick">
            {(buy ? [0.1, 0.5, 1, 5] : [0.1, 0.5, 1]).map((v) => (
              <button key={v} className={`chip ${a === v ? 'on' : ''}`} onClick={() => set(v)}>
                {v}
              </button>
            ))}
            {!buy && (
              <button className={`chip ${maxSell > 0 && a === +maxSell.toFixed(2) ? 'on' : ''}`} onClick={() => set(+maxSell.toFixed(2))}>
                Max
              </button>
            )}
          </div>
          <div className="sum">
            <div className="sum-r tot">
              <span>{buy ? 'You pay' : 'You receive'}</span>
              <span>
                <b>{F.$(total)}</b>
                <small>{F.eth(total)} ETH</small>
              </span>
            </div>
            <div className="sum-r">
              <span>Price after</span>
              <span>
                {F.$(after)} <span className={chg >= 0 ? 'up' : 'dn'}>{F.pct(chg)}</span>
              </span>
            </div>
            <button className={`fees-t ${showFees ? 'open' : ''}`} aria-expanded={showFees} onClick={() => setShowFees(!showFees)}>
              Includes {feePercent(LEVEL_CUT[level] ?? 0)}% in fees
              <Icon name="chev" />
            </button>
            <div className={`fees ${showFees ? 'open' : ''}`}>
              {sum('Curve price', q ? weiToEth(q.base) : 0)}
              {sum('Creator 6%', q ? weiToEth(q.creatorFee) : 0)}
              {sum('Protocol 2%', q ? weiToEth(q.protocolFee) : 0)}
              {sum('Holders 1%', q ? weiToEth(q.holderFee) : 0)}
              {sum('Referral 1%', q ? weiToEth(q.referralFee) : 0)}
            </div>
          </div>
          <div className="wallet-r">
            <span>Balance</span>
            <span>{F.$(weiToEth(cash))}</span>
          </div>
          {me ? (
            <button className={`btn btn-lg btn-block ${buy ? 'btn-buy' : 'btn-sell'}`} disabled={bad || busy} onClick={exec}>
              {busy ? (
                <>
                  <Spinner />
                  Confirming…
                </>
              ) : (
                label
              )}
            </button>
          ) : (
            <button className="btn btn-lg btn-block btn-white" onClick={() => openModal({ type: 'connect' })}>
              <Icon name="x" />
              {label}
            </button>
          )}
          <div className="disc">Keys open a creator’s room and holder posts. They are not shares and can lose value.</div>
        </div>
      </div>
      {pathname !== `/${handle}` && (
        <div style={{ padding: '0 20px 20px', marginTop: -8 }}>
          <button
            className="btn btn-glass btn-sm btn-block"
            onClick={() => {
              closeModal();
              router.push(`/${handle}`);
            }}
          >
            Open profile
          </button>
        </div>
      )}
    </>
  );
}
