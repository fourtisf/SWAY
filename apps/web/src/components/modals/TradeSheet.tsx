'use client';
import { ANTI_DUMP_BPS, CURVE, LEVEL_CUT, feePercent, inAntiDumpWindow, keysToUnits, maxBuyUnits, quoteWei, unitsToKeys, weiToEth, type QuoteWei } from '@sway/curve';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useActions } from '@/lib/actions';
import { useFormat } from '@/lib/format';
import { MOCK } from '@/lib/env';
import { useConfig, useMe, useProfile, useWallets } from '@/lib/queries';
import { useMemberWallets } from '@/lib/wallet';
import { openConnectWallet } from '@/lib/wallet-actions';
import { WalletSwitch } from '../wallet/WalletSwitch';
import { closeModal, openModal, toast } from '@/lib/store';
import { GAS_RESERVE_WEI, stepAmount } from '@/lib/util';
import { Icon } from '../icons';
import { Avatar, Loading, Spinner, VB } from '../ui';

const r2 = (v: number) => Math.round(v * 100) / 100;

export function TradeSheet({ handle, side: side0 }: { handle: string; side: 'buy' | 'sell' }) {
  const { data: p } = useProfile(handle);
  const me = useMe().data;
  // [A] the active wallet pays (buy) or sells its own keys; the member can switch between their wallets.
  const { wallets, active, ready, setActive } = useMemberWallets();
  const balances = useWallets(!!me?.wallet).data?.wallets;
  const F = useFormat();
  const actions = useActions();
  const pathname = usePathname();
  const router = useRouter();
  const [side, setSide] = useState(side0);
  const [amt, setAmt] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [showFees, setShowFees] = useState(false);
  const cfg = useConfig().data;
  // Until SwayKeys is deployed the markets exist only in the database: say so instead of failing at the wallet.
  const live = MOCK || !cfg || !!cfg.contracts.swayKeys;
  const [busy, setBusy] = useState(false);
  // Selling: start from a wallet that actually holds this market's keys (once, when the sheet opens).
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current || !p || !active || side0 !== 'sell') return;
    picked.current = true;
    const units = (a: string) => BigInt(p.heldBy?.find((x) => x.address.toLowerCase() === a.toLowerCase())?.units ?? '0');
    if (p.heldBy && units(active.address) === 0n) {
      const holder = wallets.find((w) => w.usable && units(w.address) > 0n);
      if (holder) setActive(holder.address);
    }
  }, [p, active, wallets, side0, setActive]);

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
  const unitsIn = (address: string): bigint => {
    const row = p.heldBy?.find((x) => x.address.toLowerCase() === address.toLowerCase());
    if (row) return BigInt(row.units);
    return p.heldBy ? 0n : held; // older API: everything sits in the account wallet
  };
  const inWallet = active ? unitsIn(active.address) : held;
  // The creator's first key sits in their account wallet and can never be sold.
  const ownLocked = p.isMe && (!active || active.account);
  const sellableHere = ownLocked ? inWallet - locked : inWallet;
  let maxSellU = sellableHere < supply - locked ? sellableHere : supply - locked;
  if (maxSellU < 0n) maxSellU = 0n;
  const maxSell = unitsToKeys(maxSellU);
  const buy = side === 'buy';
  const base0 = amt ?? (buy ? 1 : Math.min(1, maxSell));
  const a = !buy && base0 > maxSell ? r2(maxSell) : base0;
  const units = keysToUnits(a);
  // [D] Phase 4 rules the contract applies: the activity bond moves the creator's 6% to holders, and selling
  // within 24h of this wallet's last buy here adds 5% for holders.
  const creatorInactive = !!p.creatorInactive;
  const dump = !buy && !!active && inAntiDumpWindow(p.lastBuyAt?.[active.address.toLowerCase()]);
  const dumpPct = Number(ANTI_DUMP_BPS) / 100;
  let q: QuoteWei | null = null;
  try {
    if (units >= 1n && (buy || units <= supply - locked)) q = quoteWei(supply, side, units, { level, creatorInactive, antiDump: dump });
  } catch {
    q = null;
  }
  const now = weiToEth(p.priceWei);
  const total = q ? weiToEth(q.total) : 0;
  const after = q ? weiToEth(q.priceAfter) : now;
  const cashRow = active ? balances?.find((x) => x.address.toLowerCase() === active.address.toLowerCase()) : undefined;
  const cash = cashRow ? BigInt(cashRow.cashWei) : 0n;
  // Buy Max: the most keys this wallet's balance pays for, fees included (same quote as the contract), keeping a
  // little ETH for gas.
  const budget = cash > GAS_RESERVE_WEI ? cash - GAS_RESERVE_WEI : 0n;
  const maxBuy = buy ? unitsToKeys(maxBuyUnits(supply, budget, { level, creatorInactive })) : 0;
  const needConnect = !!me && !!me.wallet && ready && !!active && !active.usable;
  const tooMuch = buy && !!q && q.total > cash;
  const bad = !live || a < CURVE.MIN || (buy ? tooMuch : a > maxSell);
  const label = !me
    ? 'Connect X to trade'
    : !live
      ? 'Trading opens soon'
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
            <span>
              {buy ? `${F.$(now)} each` : wallets.length > 1 ? `This wallet holds ${F.keys(unitsToKeys(inWallet))} of your ${F.keys(unitsToKeys(held))}` : `You hold ${F.keys(unitsToKeys(held))}`}
            </span>
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
            {buy ? (
              <button
                className={`chip ${maxBuy >= CURVE.MIN && a === maxBuy ? 'on' : ''}`}
                title="As many keys as your balance buys"
                onClick={() =>
                  maxBuy >= CURVE.MIN
                    ? set(maxBuy)
                    : toast(cash > 0n ? 'Your balance buys less than 0.01 key. Deposit ETH to buy more.' : 'Your balance is $0. Deposit ETH to buy keys.')
                }
              >
                Max
              </button>
            ) : (
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
              Includes {feePercent(LEVEL_CUT[level] ?? 0) + (dump ? dumpPct : 0)}% in fees
              <Icon name="chev" />
            </button>
            <div className={`fees ${showFees ? 'open' : ''}`}>
              {sum('Curve price', q ? weiToEth(q.base) : 0)}
              {sum(creatorInactive ? 'Creator 6% (to holders)' : 'Creator 6%', q ? weiToEth(q.creatorFee) : 0)}
              {sum('Protocol 2%', q ? weiToEth(q.protocolFee) : 0)}
              {sum(creatorInactive ? 'Holders 1% + 6%' : 'Holders 1%', q ? weiToEth(q.holderFee - q.antiDumpFee) : 0)}
              {dump && sum(`Early-sell fee ${dumpPct}% (to holders)`, q ? weiToEth(q.antiDumpFee) : 0)}
              {sum('Referral 1%', q ? weiToEth(q.referralFee) : 0)}
            </div>
            {!live && (
              <div className="fee-note" id="liveNote">
                <p>
                  <b>Trading opens soon.</b> Key markets go onchain when Sway’s contracts launch; follow @swaydotfamily for the date.
                </p>
              </div>
            )}
            {(dump || creatorInactive) && (
              <div className="fee-note" id="feeNote">
                {dump && <p>This wallet bought this key less than 24 hours ago, so selling now adds a {dumpPct}% fee that goes to holders.</p>}
                {creatorInactive && <p>{p.name} hasn’t posted in their room for 7 days, so the 6% creator fee goes to holders until they do.</p>}
              </div>
            )}
          </div>
          {me && active && (
            <WalletSwitch
              label={buy ? 'Pay with' : 'Sell from'}
              wallets={wallets}
              active={active}
              balances={balances}
              unitsOf={buy ? null : unitsIn}
              onPick={(a) => {
                setActive(a);
                if (!buy) set(Math.min(1, unitsToKeys(unitsIn(a))));
              }}
            />
          )}
          <div className="wallet-r">
            <span>Balance</span>
            <span>{F.$(weiToEth(cash))}</span>
          </div>
          {needConnect ? (
            <button className="btn btn-lg btn-block btn-white" onClick={() => openConnectWallet(active!.address)}>
              <Icon name="wallet" />
              Connect a wallet
            </button>
          ) : me && buy && tooMuch && !busy ? (
            // Short of ETH: the way forward is a deposit, not a dead button.
            <button className="btn btn-lg btn-block btn-white" onClick={() => openModal({ type: 'deposit' })}>
              <Icon name="wallet" />
              Not enough balance: deposit ETH
            </button>
          ) : me ? (
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
