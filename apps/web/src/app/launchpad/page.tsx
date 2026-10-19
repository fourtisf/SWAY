'use client';
import { Icon } from '@/components/icons';
import { AirdropsCard, StakeCard } from '@/components/launch/Cards';
import { TokenBox } from '@/components/launch/TokenBox';
import { useFormat } from '@/lib/format';
import { useLaunchpad, useMe } from '@/lib/queries';
import { openModal, useUI } from '@/lib/store';

const POINTS: Array<[string, string]> = [
  ['Bonding curve, then a pool at $69K market cap', 'Standard graduation, no presale'],
  ['10% airdropped to your key holders', 'Pro rata to keys held at launch'],
  ['1% of every trade to you', 'Claimable onchain, same wallet as your keys'],
  ['No team allocation', 'What’s on the curve is the whole float'],
];

export default function LaunchpadPage() {
  const meQ = useMe();
  const me = meQ.data;
  const lp = useLaunchpad().data;
  const launch = useUI((s) => s.launch);
  const F = useFormat();
  const u = me?.user;
  const sym = lp?.symbol ?? (u ? '$' + u.handle.replace(/[^a-z0-9]/g, '').slice(0, 6).toUpperCase() : '$YOU');
  const token = lp?.token;
  const holders = lp?.terms ? (lp.terms.creatorOnly ? 0 : lp.terms.holders.length) : null;
  // Terms come with GET /api/launchpad once the member has a wallet and an opened market.
  const ready = !lp || !!lp.terms;
  const toggle = () => (meQ.isPending ? undefined : u ? useUI.setState({ launch: !launch }) : openModal({ type: 'connect' }));
  const main = () =>
    meQ.isPending
      ? undefined
      : !u
      ? openModal({ type: 'connect' })
      : !ready
        ? openModal({ type: 'onboard' })
        : launch
          ? openModal({ type: 'launch' })
          : useUI.setState({ launch: true });

  if (token)
    return (
      <>
        <div className="stage" style={{ paddingBottom: 8 }}>
          <div className="glow-orb" />
          <div style={{ position: 'relative', textAlign: 'center', maxWidth: 440 }}>
            <span className="tag aqua" style={{ height: 28, padding: '0 12px', fontSize: 12.5 }}>
              <Icon name="rocket" size={14} />
              Live on Robinhood Chain
            </span>
            <h2 className="big-h" style={{ marginTop: 16 }}>
              {`${sym} is live.`}
            </h2>
            <p className="t2" style={{ margin: '0 auto 6px', maxWidth: '40ch' }}>
              Your key holders can claim their 10%. You earn 1% of every trade on the curve.
            </p>
          </div>
        </div>
        <TokenBox t={token} />
        <AirdropsCard />
        <StakeCard level={me?.stakingLevel ?? 0} />
      </>
    );

  return (
    <>
      <div className="stage" style={{ paddingBottom: 8 }}>
        <div className="glow-orb" />
        <div style={{ position: 'relative', textAlign: 'center', maxWidth: 440 }}>
          <span className="tag aqua" style={{ height: 28, padding: '0 12px', fontSize: 12.5 }}>
            <Icon name="rocket" size={14} />
            Launchpad on Robinhood Chain
          </span>
          <h2 className="big-h" style={{ marginTop: 16 }}>
            Turn your reach into a token with one switch.
          </h2>
          <p className="t2" style={{ margin: '0 auto 18px', maxWidth: '40ch' }}>
            Your Sway score seeds the curve. Your key holders get an allocation. You keep earning on every trade.
          </p>
          <button
            className={`switch ${launch ? 'on' : ''}`}
            style={{ position: 'relative', right: 'auto', top: 'auto', width: 84, height: 46 }}
            role="switch"
            aria-checked={launch}
            aria-label="Launch your reach as a token"
            onClick={toggle}
          >
            <i style={{ width: 38, height: 38, ...(launch ? { transform: 'translateX(38px)' } : {}) }} />
          </button>
          <div className="t3" style={{ fontSize: 12, fontWeight: 700, marginTop: 8 }}>
            {launch ? 'Token preview on' : 'Flip to preview your token'}
          </div>
        </div>
      </div>
      <div className="glass tok" style={launch ? undefined : { opacity: 0.55 }}>
        <div className="tok-top">
          <span className="tok-sym">{sym.slice(1, 3)}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.03em' }}>{sym}</div>
            <div className="hd">{`${u ? u.name + ' token' : 'Your token'}  seeded by a Sway score of ${u ? u.score : '—'}`}</div>
          </div>
          <span className={`tag ${launch ? 'aqua' : 'line'}`}>{launch ? 'Ready' : 'Preview'}</span>
        </div>
        <div className="grid3" style={{ marginTop: 16 }}>
          <div className="glass stat">
            <small>Supply</small>
            <b>1B</b>
          </div>
          <div className="glass stat">
            <small>Start cap</small>
            <b>{u ? F.usd(lp?.terms?.startCapUsd ?? lp?.startCapUsd ?? 2000 + u.score * 60) : '—'}</b>
          </div>
          <div className="glass stat">
            <small>To key holders</small>
            <b>10%</b>
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          {POINTS.map(([a, b], i) => (
            <div key={a} className="earn-r">
              <span>
                <b style={{ color: 'var(--tx)' }}>{a}</b>
                <br />
                <span className="t3" style={{ fontSize: 12.5 }}>
                  {i === 1 && holders !== null ? `${b}. ${holders ? `${holders} holder${holders === 1 ? '' : 's'} today` : 'Nobody else yet, so it goes to you'}` : b}
                </span>
              </span>
            </div>
          ))}
        </div>
        <button className="btn btn-white btn-lg btn-block" style={{ marginTop: 16 }} onClick={main}>
          {!u ? (
            <>
              <Icon name="x" />
              Connect X to launch
            </>
          ) : !ready ? (
            me?.wallet ? 'Open your key market first' : 'Finish setting up your wallet'
          ) : launch ? (
            'Launch ' + sym
          ) : (
            'Turn on the switch first'
          )}
        </button>
        <p className="t3" style={{ fontSize: 12, textAlign: 'center', margin: '10px 0 0' }}>
          Launch terms are placeholders until the contract is audited.
        </p>
      </div>
      <AirdropsCard />
    </>
  );
}
