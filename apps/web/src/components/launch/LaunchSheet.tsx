'use client';
/**
 * [C] The "Launch $SYM?" confirm sheet: the creator picks the token's name and ticker (suggested from their display
 * name), sees the terms the operator will sign, then attest → launch → wait.
 */
import { weiToEth } from '@sway/curve';
import { LAUNCH_NAME_MAX, symbolProblem, tokenNameProblem } from '@sway/shared';
import Link from 'next/link';
import { useState } from 'react';
import { MOCK } from '@/lib/env';
import { useFormat } from '@/lib/format';
import { fmtTokens, useLaunchActions } from '@/lib/launch-actions';
import { useConfig, useLaunchpad, useMe } from '@/lib/queries';
import { closeModal } from '@/lib/store';
import { useMemberWallets } from '@/lib/wallet';
import { Icon } from '../icons';
import { Avatar, Loading, Spinner } from '../ui';

const STEP = { attest: 'Signing the launch terms…', sign: 'Confirm in your wallet…', mine: 'Launching onchain…', index: 'Opening the curve…' } as const;

export function LaunchSheet() {
  const lp = useLaunchpad().data;
  const cfg = useConfig().data;
  const official = !!useMe().data?.user.official;
  const F = useFormat();
  const act = useLaunchActions();
  const account = useMemberWallets().wallets.find((w) => w.account);
  const [step, setStep] = useState<keyof typeof STEP | null>(null);
  // null until edited: the suggested name and ticker from the terms.
  const [picked, setPicked] = useState<{ name: string; symbol: string } | null>(null);
  const pick = picked ?? (lp?.terms ? { name: lp.terms.name, symbol: lp.terms.symbol } : null);
  const head = (
    <div className="m-h">
      <h3>{`Launch ${pick ? `$${pick.symbol || '…'}` : (lp?.symbol ?? 'your token')}?`}</h3>
      <button className="x-btn" aria-label="Close" onClick={closeModal}>
        <Icon name="close" />
      </button>
    </div>
  );
  if (!lp || (!MOCK && !cfg)) return <Loading />;
  // Mainnet deploys without the launchpad; deploy/setup-launchpad.sh adds it.
  if (!MOCK && !cfg?.contracts.launchpad)
    return (
      <>
        {head}
        <div className="m-b">
          <p className="t2" style={{ margin: '0 0 16px' }}>
            Token launches aren’t open on this network yet.
          </p>
          <button className="btn btn-white btn-lg btn-block" onClick={closeModal}>
            Got it
          </button>
        </div>
      </>
    );
  // The token is launched from the account wallet; a browser-made Sway wallet can't sign on mainnet.
  if (account?.status === 'unsupported' && !lp.launched)
    return (
      <>
        {head}
        <div className="m-b">
          <p className="t2" style={{ margin: '0 0 12px' }}>
            Your account wallet is a Sway wallet made in the browser, and those don’t work on this network yet.
          </p>
          <p className="t3" style={{ fontSize: 12.5, margin: '0 0 16px' }}>
            On the Wallet page, add your wallet app (MetaMask, Rabby, Coinbase…), then pick ⋯ → Make account wallet.
            Keep a little ETH in it for gas, then launch from there.
          </p>
          <Link href="/wallet" className="btn btn-white btn-lg btn-block" onClick={closeModal}>
            Open Wallet
          </Link>
        </div>
      </>
    );
  const t = lp.terms;
  if (!t)
    return (
      <>
        {head}
        <div className="m-b">
          <p className="t2" style={{ margin: '0 0 16px' }}>
            {lp.launched ? 'Your token is already live.' : 'Open your key market first: your key holders get 10% of the token.'}
          </p>
          <button className="btn btn-white btn-lg btn-block" onClick={closeModal}>
            Got it
          </button>
        </div>
      </>
    );
  const p = pick!;
  const problem = tokenNameProblem(p.name) ?? symbolProblem(p.symbol, official);
  const row = (a: string, b: string) => (
    <div className="sum-r">
      <span>{a}</span>
      <span>{b}</span>
    </div>
  );
  return (
    <>
      {head}
      <div className="m-b" id="launchSheet">
        <p className="t2" style={{ margin: '0 0 14px' }}>
          Pick a name and ticker. This signs one transaction from your Sway wallet and ${p.symbol || '…'} goes live on Robinhood
          Chain; neither can change after launch.
        </p>
        <div className="grid2" style={{ marginBottom: 6 }}>
          <div>
            <label className="lbl" htmlFor="lt-name">
              Token name
            </label>
            <input
              className="field"
              id="lt-name"
              maxLength={LAUNCH_NAME_MAX}
              value={p.name}
              disabled={!!step}
              onChange={(e) => setPicked({ ...p, name: e.target.value })}
            />
          </div>
          <div>
            <label className="lbl" htmlFor="lt-symbol">
              Ticker
            </label>
            <input
              className="field"
              id="lt-symbol"
              autoCapitalize="characters"
              spellCheck={false}
              value={p.symbol}
              disabled={!!step}
              // Letters and digits only, so the ticker can't be made to look like another one.
              onChange={(e) => setPicked({ ...p, symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) })}
            />
          </div>
        </div>
        <p className={problem ? 'dn' : 't3'} style={{ fontSize: 12.5, margin: '0 0 14px' }} id="lt-hint">
          {problem ?? '2 to 10 letters or digits. Shown with a $ everywhere.'}
        </p>
        <div className="sum">
          <div className="sum-r tot">
            <span>Start cap</span>
            <span>
              <b>{F.usd(t.startCapUsd)}</b>
              <small>{F.eth(weiToEth(t.startCapWei))} ETH</small>
            </span>
          </div>
          {row('Supply', '1B')}
          {row('Graduates to a pool at', t.graduationCapUsd % 1000 === 0 ? `$${t.graduationCapUsd / 1000}K` : F.usd(t.graduationCapUsd))}
          {row('To your key holders', `10% to ${t.creatorOnly ? 'you' : `${t.holders.length} holder${t.holders.length === 1 ? '' : 's'}`}`)}
          {row('Creator fee', '1% of every trade')}
        </div>
        {t.creatorOnly ? (
          <p className="t3" style={{ fontSize: 13, margin: '0 0 14px' }}>
            Nobody else holds your keys yet, so the whole 10% goes to your wallet.
          </p>
        ) : (
          <div style={{ margin: '0 0 14px' }}>
            {t.holders.slice(0, 5).map((h) => (
              <div key={h.address} className="between" style={{ padding: '6px 0', fontSize: 14 }}>
                <span className="row" style={{ minWidth: 0 }}>
                  {h.user ? <Avatar u={h.user} size={26} /> : null}
                  <span className="hd" style={{ fontSize: 14, color: 'var(--tx)' }}>
                    {h.user ? h.user.name : `${h.address.slice(0, 6)}…${h.address.slice(-4)}`}
                  </span>
                </span>
                <span className="t2">
                  {fmtTokens(h.amount)} <span className="t3">({h.sharePct.toFixed(2)}%)</span>
                </span>
              </div>
            ))}
            {t.holders.length > 5 && (
              <div className="t3" style={{ fontSize: 12.5 }}>
                and {t.holders.length - 5} more, pro rata to keys held at launch
              </div>
            )}
          </div>
        )}
        <button
          className="btn btn-white btn-lg btn-block"
          disabled={!!step || !!problem}
          onClick={async () => {
            await act.launch((s) => setStep(s), { name: p.name.trim(), symbol: p.symbol });
            setStep(null);
          }}
        >
          {step ? (
            <>
              <Spinner />
              {STEP[step]}
            </>
          ) : (
            `Launch $${p.symbol}`
          )}
        </button>
        <p className="t3" style={{ fontSize: 12, textAlign: 'center', margin: '10px 0 0' }}>
          Launch terms are placeholders until the contract is audited.
        </p>
      </div>
    </>
  );
}
