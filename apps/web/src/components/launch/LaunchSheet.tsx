'use client';
/** [C] The "Launch $SYM?" confirm sheet: the terms the operator will sign, then attest → launch → wait. */
import { weiToEth } from '@sway/curve';
import { useState } from 'react';
import { MOCK } from '@/lib/env';
import { useFormat } from '@/lib/format';
import { fmtTokens, useLaunchActions } from '@/lib/launch-actions';
import { useConfig, useLaunchpad } from '@/lib/queries';
import { closeModal } from '@/lib/store';
import { Icon } from '../icons';
import { Avatar, Loading, Spinner } from '../ui';

const STEP = { attest: 'Signing the launch terms…', sign: 'Confirm in your wallet…', mine: 'Launching onchain…', index: 'Opening the curve…' } as const;

export function LaunchSheet() {
  const lp = useLaunchpad().data;
  const cfg = useConfig().data;
  const F = useFormat();
  const act = useLaunchActions();
  const [step, setStep] = useState<keyof typeof STEP | null>(null);
  const head = (
    <div className="m-h">
      <h3>{`Launch ${lp?.symbol ?? 'your token'}?`}</h3>
      <button className="x-btn" aria-label="Close" onClick={closeModal}>
        <Icon name="close" />
      </button>
    </div>
  );
  if (!lp || (!MOCK && !cfg)) return <Loading />;
  // Mainnet deploys without the launchpad until its migration is fixed and audited (docs/SECURITY_REVIEW.md, L-1).
  if (!MOCK && !cfg?.contracts.launchpad)
    return (
      <>
        {head}
        <div className="m-b">
          <p className="t2" style={{ margin: '0 0 16px' }}>
            Token launches aren’t open on this network yet. They open once the launchpad contract has been audited.
          </p>
          <button className="btn btn-white btn-lg btn-block" onClick={closeModal}>
            Got it
          </button>
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
          This signs one transaction from your Sway wallet and ${t.symbol} goes live on Robinhood Chain.
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
          disabled={!!step}
          onClick={async () => {
            await act.launch((s) => setStep(s));
            setStep(null);
          }}
        >
          {step ? (
            <>
              <Spinner />
              {STEP[step]}
            </>
          ) : (
            `Launch $${t.symbol}`
          )}
        </button>
        <p className="t3" style={{ fontSize: 12, textAlign: 'center', margin: '10px 0 0' }}>
          Launch terms are placeholders until the contract is audited.
        </p>
      </div>
    </>
  );
}
