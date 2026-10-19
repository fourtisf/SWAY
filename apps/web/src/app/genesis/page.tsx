'use client';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Icon } from '@/components/icons';
import { Avatar, CountdownBoxes, Loading, Voiceprint } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useGenesis, useMe } from '@/lib/queries';
import { openModal } from '@/lib/store';

function snapshotLabel(iso: string) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `Snapshot on ${date} at ${time} UTC`;
}

export default function GenesisPage() {
  const me = useMe().data;
  const { data } = useGenesis();
  const F = useFormat();
  const stage = useRef<HTMLDivElement>(null);
  const pass = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const s = stage.current,
      p = pass.current;
    if (!s || !p || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const move = (e: PointerEvent) => {
      const r = s.getBoundingClientRect(),
        px = (e.clientX - r.left) / r.width - 0.5,
        py = (e.clientY - r.top) / r.height - 0.5;
      p.style.transform = `rotateY(${px * 24}deg) rotateX(${-py * 24}deg)`;
      p.style.setProperty('--sh', px * 130 + '%');
    };
    const leave = () => {
      p.style.transform = '';
    };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerleave', leave);
    return () => {
      s.removeEventListener('pointermove', move);
      s.removeEventListener('pointerleave', leave);
    };
  }, [data]);
  if (!data) return <Loading />;
  const g = data.me;
  const inCut = !!g && g.inCut;
  return (
    <>
      <div className="stage" id="stage" ref={stage}>
        <div className="glow-orb" />
        <div className="pass" id="pass" ref={pass}>
          <div className="pass-in">
            <div className="between">
              <b style={{ fontSize: 16, letterSpacing: '-.02em' }}>Sway</b>
              <span className="tag" style={{ background: 'rgba(255,255,255,.12)', color: '#fff' }}>
                Genesis
              </span>
            </div>
            <div className="t3" style={{ fontSize: 12, marginTop: 4 }}>
              Soulbound on Robinhood Chain
            </div>
            <Voiceprint seed={me ? me.user.handle : 'genesis'} score={85} bars={40} id="pass" />
            <div className="pass-no">{inCut ? '#' + String(g!.rank).padStart(4, '0') : me ? '#----' : '#0001'}</div>
            <div className="t2" style={{ fontSize: 13, marginTop: 4 }}>
              {me ? (inCut ? '@' + me.user.handle : 'Reach the top 500 to mint') : 'Founding member'}
            </div>
          </div>
        </div>
      </div>
      <div style={{ padding: '0 18px 16px', textAlign: 'center' }}>
        <h2 className="big-h">Minted once to the top 500. Never sold.</h2>
        <p className="t2" style={{ margin: '0 auto 16px', maxWidth: '46ch' }}>
          At the snapshot the 500 members with the most points get a soulbound pass in their Sway wallet. No claim, no gas. The pass number is your rank.
        </p>
        {data.frozen && data.snapshotId ? (
          <Link className="btn btn-white btn-lg" href={`/genesis/list/${data.snapshotId}`} style={{ maxWidth: 400, width: '100%' }}>
            <Icon name="gem" />
            See the full list
          </Link>
        ) : (
          <CountdownBoxes to={data.snapshotAt} style={{ maxWidth: 400, margin: '0 auto' }} />
        )}
        <div className="t3" style={{ fontSize: 12.5, marginTop: 8 }}>
          {snapshotLabel(data.snapshotAt)}
        </div>
      </div>
      {me && g ? (
        <div className="glass" style={{ margin: '0 18px 16px', padding: '16px 18px' }}>
          <div className="between">
            <span className="t2" style={{ fontWeight: 600 }}>
              Your projected rank
            </span>
            <b style={{ fontSize: 22, letterSpacing: '-.03em' }}>#{F.int(g.rank)}</b>
          </div>
          <div className="t3" style={{ fontSize: 13, marginTop: 2 }}>
            {inCut
              ? `Inside the cut. Projected pool share ${g.sharePct.toFixed(4)}%.`
              : `About ${F.int(Math.max(0, g.toCut))} points to the top-500 cut. Holding keys is the fastest route at 400K points per ETH held.`}
          </div>
        </div>
      ) : !me ? (
        <div style={{ padding: '0 18px 16px' }}>
          <button className="btn btn-white btn-lg btn-block" onClick={() => openModal({ type: 'connect' })}>
            <Icon name="x" />
            Connect X to get ranked
          </button>
        </div>
      ) : null}
      <div className="perks">
        <div className="glass perk">
          <b>Soulbound</b>
          <span>Can’t be transferred, approved or listed.</span>
        </div>
        <div className="glass perk">
          <b>Founder badge</b>
          <span>Next to your name across Sway.</span>
        </div>
        <div className="glass perk">
          <b>Nothing to claim</b>
          <span>Sent within 24 hours of the snapshot.</span>
        </div>
        <div className="glass perk">
          <b>Share by rank</b>
          <span>5% of supply, weight 1/√rank.</span>
        </div>
      </div>
      <div className="sec-h">
        <h2>How the pool splits</h2>
      </div>
      <div className="split">
        {data.split.map((r) => (
          <div key={r.rank} className="glass">
            <small>Rank {r.rank}</small>
            <b>{r.sharePct.toFixed(3)}%</b>
          </div>
        ))}
      </div>
      <div className="sec-h">
        <h2>{data.snapshotId ? 'Top 30 at the snapshot' : 'Current top 30'}</h2>
        {data.snapshotId ? (
          <Link className="lnk" href={`/genesis/list/${data.snapshotId}`} style={{ fontSize: 13 }}>
            See the full list
          </Link>
        ) : (
          <span className="t3" style={{ fontSize: 13 }}>
            {data.frozen ? 'Frozen at the snapshot' : 'Live until the freeze'}
          </span>
        )}
      </div>
      {data.top.map((r) => (
        <div key={r.rank} className="tr" style={{ gridTemplateColumns: '64px minmax(0,1fr) auto' }}>
          <span className="rk">#{String(r.rank).padStart(4, '0')}</span>
          <div className="row" style={{ minWidth: 0 }}>
            <Avatar u={r.user} size={36} />
            <div style={{ minWidth: 0 }}>
              <div className="nm">
                <b>{r.user.name}</b>
              </div>
              <div className="hd">@{r.user.handle}</div>
            </div>
          </div>
          <div className="num">
            <b>{r.sharePct.toFixed(4)}%</b>
            <small>{F.n(r.points)} pts</small>
          </div>
        </div>
      ))}
    </>
  );
}
