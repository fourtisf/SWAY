'use client';
/** [C] A launched creator token: price, market cap, progress to graduation, buy/sell on the curve, creator fees. */
import { ethToWei, weiToEth } from '@sway/curve';
import {
  LAUNCH_CREATOR_FEE_BPS,
  launchMinOut,
  launchQuoteBuy,
  launchQuoteSell,
  type LaunchTokenDTO,
} from '@sway/shared';
import { useState } from 'react';
import { useFormat, useEthUsd } from '@/lib/format';
import { balanceOf, curveOf, fmtTokens, tokensInput, useLaunchActions } from '@/lib/launch-actions';
import { useMe, useWallet } from '@/lib/queries';
import { openModal } from '@/lib/store';
import { useSwayWallet } from '@/lib/wallet';
import { Icon } from '../icons';
import { Spinner } from '../ui';

/** Dollar price of one token: tiny numbers keep three significant digits. */
export function tokenUsd(priceWei: string, ethUsd: number): string {
  const v = weiToEth(priceWei) * ethUsd;
  if (v === 0) return '$0';
  if (v >= 0.01) return '$' + v.toFixed(v >= 1 ? 2 : 4);
  return '$' + v.toPrecision(3);
}

const ETH_CHIPS = ['0.01', '0.05', '0.1', '0.5'];

export function TokenBox({ t }: { t: LaunchTokenDTO }) {
  const F = useFormat();
  const ethUsd = useEthUsd();
  const me = useMe().data;
  const cash = useWallet(!!me?.wallet).data;
  const { wallet } = useSwayWallet();
  const act = useLaunchActions();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [text, setText] = useState('0.01');
  const [busy, setBusy] = useState<string | null>(null);

  const bal = balanceOf(t, wallet?.address);
  const held = bal ? BigInt(bal.balance) : 0n;
  const buy = side === 'buy';
  let amount = 0n;
  try {
    amount = ethToWei(text.replace(',', '.') || '0');
  } catch {
    amount = 0n;
  }
  const curve = curveOf(t);
  const qb = buy && amount > 0n ? launchQuoteBuy(curve, amount) : null;
  const qs = !buy && amount > 0n && amount <= held ? launchQuoteSell(curve, amount) : null;
  const cashWei = cash ? BigInt(cash.cashWei) : 0n;
  const tooMuch = buy ? amount > cashWei : amount > held;
  const bad = amount <= 0n || tooMuch || t.graduated;
  const capUsd = weiToEth(t.marketCapWei) * ethUsd;
  const gradUsd = weiToEth(t.graduationCapWei) * ethUsd;
  const fees = BigInt(t.creatorFeesWei);
  const price = tokenUsd(t.priceWei, ethUsd);

  const label = !me
    ? 'Connect X to trade'
    : t.graduated
      ? 'Graduated: trades on Uniswap now'
      : amount <= 0n
        ? 'Enter an amount'
        : tooMuch
          ? buy
            ? 'Not enough balance'
            : 'More than you hold'
          : buy
            ? `Buy $${t.symbol} for ${F.$(weiToEth(amount))}`
            : `Sell ${fmtTokens(amount)} $${t.symbol}`;

  const run = async (k: string, fn: () => Promise<boolean>) => {
    setBusy(k);
    const ok = await fn();
    setBusy(null);
    return ok;
  };
  const exec = () =>
    run('trade', async () => {
      const ok = buy ? await act.buy(t, amount) : await act.sell(t, amount);
      if (ok) setText(buy ? text : '');
      return ok;
    });
  const pick = (s: 'buy' | 'sell') => {
    setSide(s);
    setText(s === 'buy' ? '0.01' : held > 0n ? tokensInput(held / 2n) : '');
  };

  return (
    <div className="glass tok" id="tokenBox">
      <div className="tok-top">
        <span className="tok-sym">{t.symbol.slice(0, 2)}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.03em' }}>${t.symbol}</div>
          <div className="hd">{`${t.creator.name} token  on Robinhood Chain`}</div>
        </div>
        <span className={`tag ${t.graduated ? 'warn' : 'aqua'}`}>{t.graduated ? 'Graduated' : 'Live'}</span>
      </div>
      <div className="grid4" style={{ marginTop: 16 }}>
        <div className="glass stat">
          <small>{t.graduated ? 'Price at graduation' : 'Price'}</small>
          <b style={price.length > 8 ? { fontSize: 15, lineHeight: '24px' } : undefined}>{price}</b>
        </div>
        <div className="glass stat">
          <small>{t.graduated ? 'Cap at graduation' : 'Market cap'}</small>
          <b>{F.usd(capUsd)}</b>
        </div>
        <div className="glass stat">
          <small>Volume</small>
          <b>{F.$(weiToEth(t.volumeWei))}</b>
        </div>
        <div className="glass stat">
          <small>Holders</small>
          <b>{F.int(t.holders)}</b>
        </div>
      </div>
      {t.graduated ? (
        <div className="note" style={{ marginTop: 14 }} id="graduatedNote">
          {`$${t.symbol} graduated: the curve’s ETH and tokens moved into its Uniswap pool and the pool’s LP tokens were burned, so the liquidity can’t be pulled. It trades on Uniswap from here.`}
        </div>
      ) : (
        <div style={{ marginTop: 14 }}>
          <div className="between" style={{ fontSize: 13.5 }}>
            <span className="t2" style={{ fontWeight: 600 }}>
              Progress to graduation
            </span>
            <b>
              {F.usd(capUsd)} of {F.usd(gradUsd).replace('.0K', 'K')}
            </b>
          </div>
          <div className="track" style={{ margin: '8px 0 4px' }} aria-label="Progress to graduation">
            <i style={{ ['--w' as string]: `${Math.round(t.progress * 1000) / 10}%` }}>
              <b />
            </i>
          </div>
          <div className="t3" style={{ fontSize: 12.5 }}>
            {`${fmtTokens(t.tokenReserve)} left on the curve, ${F.$(weiToEth(t.ethReserveWei))} in reserve`}
          </div>
        </div>
      )}

      <div className="trade" style={{ padding: '18px 0 0' }}>
        {!t.graduated && (
          <>
            <div className="tside">
              <button className={`b ${buy ? 'on' : ''}`} onClick={() => pick('buy')}>
                Buy
              </button>
              <button className={`s ${!buy ? 'on' : ''}`} onClick={() => pick('sell')}>
                Sell
              </button>
            </div>
            <div className="amt-l">
              <span>{buy ? 'ETH to spend' : `$${t.symbol} to sell`}</span>
              <span>{buy ? `${F.$(weiToEth(amount))}` : `You hold ${fmtTokens(held)}`}</span>
            </div>
            <div className="amt">
              <input
                id="tokAmt"
                inputMode="decimal"
                aria-label={buy ? 'ETH to spend' : 'Tokens to sell'}
                value={text}
                placeholder="0"
                onChange={(e) => setText(e.target.value)}
              />
            </div>
            <div className="quick">
              {buy
                ? ETH_CHIPS.map((v) => (
                    <button key={v} className={`chip ${text === v ? 'on' : ''}`} onClick={() => setText(v)}>
                      {v} ETH
                    </button>
                  ))
                : (['25', '50', '100'] as const).map((p) => (
                    <button
                      key={p}
                      className="chip"
                      disabled={held === 0n}
                      onClick={() => setText(tokensInput((held * BigInt(p)) / 100n))}
                    >
                      {p === '100' ? 'Max' : `${p}%`}
                    </button>
                  ))}
            </div>
            <div className="sum">
              <div className="sum-r tot">
                <span>{buy ? 'You get' : 'You receive'}</span>
                <span>
                  {buy ? (
                    <>
                      <b>{qb ? fmtTokens(qb.tokensOut) : '0'}</b>
                      <small>${t.symbol}</small>
                    </>
                  ) : (
                    <>
                      <b>{F.$(qs ? weiToEth(qs.ethOut) : 0)}</b>
                      <small>{F.eth(qs ? weiToEth(qs.ethOut) : 0)} ETH</small>
                    </>
                  )}
                </span>
              </div>
              <div className="sum-r">
                <span>At least, with 1% slippage</span>
                <span>
                  {buy
                    ? `${qb ? fmtTokens(launchMinOut(qb.tokensOut)) : '0'} $${t.symbol}`
                    : F.$(qs ? weiToEth(launchMinOut(qs.ethOut)) : 0)}
                </span>
              </div>
              <div className="sum-r">
                <span>Creator fee {Number(LAUNCH_CREATOR_FEE_BPS) / 100}%</span>
                <span>{F.$(weiToEth(qb?.fee ?? qs?.fee ?? 0n))}</span>
              </div>
              {qb?.graduates && (
                <div className="sum-r" id="gradNote">
                  <span>Graduates the curve: spends</span>
                  <span>{`${F.$(weiToEth(qb.spent))}, refunds ${F.$(weiToEth(amount - qb.spent))}`}</span>
                </div>
              )}
            </div>
            <div className="wallet-r">
              <span>Balance</span>
              <span>{F.$(weiToEth(cashWei))}</span>
            </div>
          </>
        )}
        {t.graduated && t.pool ? (
          // The curve's liquidity is in the Uniswap V2 pool now; the LP tokens were burned at graduation.
          <a
            className="btn btn-lg btn-block btn-white"
            href={`https://app.uniswap.org/swap?outputCurrency=${t.address}`}
            target="_blank"
            rel="noreferrer"
          >
            {`Trade $${t.symbol} on Uniswap`}
          </a>
        ) : me ? (
          <button
            className={`btn btn-lg btn-block ${buy ? 'btn-buy' : 'btn-sell'}`}
            disabled={bad || !!busy}
            onClick={exec}
          >
            {busy === 'trade' ? (
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
        <div className="disc">
          Creator tokens are not shares and can lose value. Launch terms are placeholders until the contract
          is audited.
        </div>
      </div>

      {t.isMine && (
        <div
          className="earn-r"
          style={{ marginTop: 14, borderTop: '1px solid var(--line)', alignItems: 'center' }}
        >
          <span>
            <b style={{ color: 'var(--tx)' }}>Creator fees to claim</b>
            <br />
            <span className="t3" style={{ fontSize: 12.5 }}>
              1% of every trade, paid to {`${t.creatorAddress.slice(0, 6)}…${t.creatorAddress.slice(-4)}`}
            </span>
          </span>
          <span className="row">
            <b>{F.$(weiToEth(fees))}</b>
            <button
              className="btn btn-buy btn-sm"
              disabled={fees === 0n || !!busy}
              onClick={() => run('fees', () => act.claimCreatorFees(t))}
            >
              {busy === 'fees' ? <Spinner /> : 'Claim creator fees'}
            </button>
          </span>
        </div>
      )}
      {t.explorer && (
        <a
          className="lnk"
          href={t.explorer}
          target="_blank"
          rel="noreferrer"
          style={{ display: 'inline-block', fontSize: 13, marginTop: 10 }}
        >
          View on explorer
        </a>
      )}
      {t.explorer && t.pool && (
        <a
          className="lnk"
          href={t.explorer.replace(/\/token\/[^/]+$/, `/address/${t.pool}`)}
          target="_blank"
          rel="noreferrer"
          style={{ display: 'inline-block', fontSize: 13, marginTop: 10, marginLeft: 14 }}
        >
          Uniswap pool
        </a>
      )}
    </div>
  );
}
