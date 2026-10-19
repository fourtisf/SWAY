'use client';
import { weiToEth } from '@sway/curve';
import { minutesSince, type TradeDTO } from '@sway/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { tradeKey } from '@/lib/live';
import { useFormat } from '@/lib/format';
import { useBattles, useConfig, useMe, useSearch, useTrades } from '@/lib/queries';
import { openModal, useClock, useUI } from '@/lib/store';
import { Icon } from '../icons';
import { Avatar, Countdown, CountdownBoxes, VB, Voiceprint } from '../ui';

export function goTag(router: ReturnType<typeof useRouter>, tag: string) {
  useUI.setState({ exploreQ: '#' + tag, exploreTab: 'tags' });
  router.push('/explore');
}

function RailSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const F = useFormat();
  const res = useSearch(q.trim().toLowerCase()).data;
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const s = q.trim().toLowerCase();
  const members = res?.members ?? [];
  const tags = res?.tags ?? [];
  return (
    <div className="search" ref={box}>
      <label className="sr" htmlFor="rs">
        Search members or tags
      </label>
      <Icon name="search" />
      <input
        className="field"
        id="rs"
        placeholder="Search members or #tags"
        autoComplete="off"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => q && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            useUI.setState({ exploreQ: q.replace(/^#/, ''), exploreTab: q.startsWith('#') ? 'tags' : 'creators' });
            go('/explore');
          }
        }}
      />
      <div id="sres">
        {open && s && res && (
          <div className="sres">
            {members.length > 0 && <div className="lab">Members</div>}
            {members.map((c) => (
              <div key={c.handle} className="it" onClick={() => go(`/${c.handle}`)}>
                <Avatar u={c} size={36} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="nm">
                    <b>{c.name}</b>
                    <VB v={c.verified} />
                  </div>
                  <div className="hd">
                    @{c.handle}
                    {c.claimed ? '' : '  Unclaimed'}
                  </div>
                </div>
                <b style={{ fontSize: 13.5 }}>{F.$(weiToEth(c.priceWei))}</b>
              </div>
            ))}
            {tags.length > 0 && <div className="lab">Tags</div>}
            {tags.map((t) => (
              <div
                key={t.tag}
                className="it"
                onClick={() => {
                  setOpen(false);
                  goTag(router, t.tag);
                }}
              >
                <span className="icon-btn" style={{ width: 36, height: 36, fontWeight: 800, color: 'var(--pink)' }}>
                  #
                </span>
                <div>
                  <b>#{t.tag}</b>
                  <div className="hd">{F.n(t.posts)} posts</div>
                </div>
              </div>
            ))}
            {!members.length && !tags.length && (
              <div className="lab" style={{ padding: 12 }}>
                No matches for “{s}”
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LaunchCard() {
  const slide = useUI((s) => s.slide);
  const launch = useUI((s) => s.launch);
  const me = useMe().data;
  const cfg = useConfig().data;
  const F = useFormat();
  const router = useRouter();
  if (slide === 1)
    return (
      <div className="lc">
        <div className="lc-in">
          <div className="lc-k">
            <span className="dot" />
            Genesis snapshot
          </div>
          <p className="lc-p" style={{ margin: '12px 0 14px', maxWidth: 'none' }}>
            Top 500 by points get a soulbound pass and a share of 5% of supply.
          </p>
          {cfg && <CountdownBoxes to={cfg.snapshotAt} />}
          <Link className="lnk" href="/genesis" style={{ display: 'inline-block', marginTop: 12, position: 'relative' }}>
            See the list
          </Link>
        </div>
      </div>
    );
  const toggle = () => {
    if (!me) return openModal({ type: 'connect' });
    const next = !launch;
    useUI.setState({ launch: next });
    if (next) router.push('/launchpad');
  };
  return (
    <div className="lc">
      <div className="lc-in">
        <div className="lc-k">
          <Icon name="rocket" size={15} />
          Sway launchpad
        </div>
        <div className="lc-k" style={{ marginTop: 14, color: 'var(--tx3)', fontWeight: 600 }}>
          {me ? 'Your reach value' : 'What is your reach worth?'}
        </div>
        <div className="lc-v">{me ? F.usd(me.user.reachValue) : '$?'}</div>
        <p className="lc-p">{me ? 'Launch it as a token with one switch.' : 'Connect X to see your number, then launch it as a token.'}</p>
        <button className={`switch ${launch ? 'on' : ''}`} role="switch" aria-checked={launch} aria-label="Launch your reach as a token" onClick={toggle}>
          <i />
        </button>
        <span className="switch-l">{launch ? 'ON' : 'OFF'}</span>
        <div className="lc-vp">
          <Voiceprint seed={me ? me.user.handle : 'lcard'} score={me ? me.user.score : 70} bars={22} id="lcv" />
        </div>
      </div>
    </div>
  );
}

function LtItem({ t, isNew }: { t: TradeDTO; isNew: boolean }) {
  const F = useFormat();
  const router = useRouter();
  useClock((s) => Math.floor(s.now / 30000)); // refresh "Xm" labels
  return (
    <div className={`lt ${isNew ? 'new' : ''}`} onClick={() => router.push(`/${t.market.handle}`)}>
      <Avatar u={t.market} size={44} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="nm">
          <b style={{ fontSize: 15.5 }}>{t.market.name}</b>
          <VB v={t.market.verified} />
        </div>
        <div className="sub">
          <span className={t.isBuy ? 'vb-b' : 'vb-s'}>{t.isBuy ? 'Bought' : 'Sold'}</span> by {t.trader.name} {' '}
          {F.ago(minutesSince(t.ts))}
        </div>
      </div>
      <span className="pr">{F.$(weiToEth(t.baseWei))}</span>
    </div>
  );
}

function LiveTrades() {
  const trades = (useTrades().data ?? []).slice(0, 6);
  const newKey = useUI((s) => s.newTrade);
  return (
    <div className="glass wd">
      <div className="wd-h">
        <h3>Live trades</h3>
        <span className="row t3" style={{ fontSize: 12.5, fontWeight: 600, gap: 7 }}>
          <span className="dot" />
          Live
        </span>
      </div>
      <div id="ltList">
        {trades.map((t, i) => (
          <LtItem key={tradeKey(t)} t={t} isNew={i === 0 && tradeKey(t) === newKey} />
        ))}
      </div>
    </div>
  );
}

function LiveBattle() {
  const b = useBattles().data?.battles.find((x) => x.b && x.status === 'live');
  const router = useRouter();
  if (!b || !b.b) return null;
  const tot = b.erA + b.erB || 1;
  const sides: Array<[typeof b.a, number, boolean]> = [
    [b.a, b.erA, b.erA >= b.erB],
    [b.b, b.erB, b.erB > b.erA],
  ];
  return (
    <div className="glass wd">
      <div className="wd-h">
        <h3>Live battle</h3>
        <span className="tag pink">
          <Countdown to={b.endsAt} />
        </span>
      </div>
      <div className="t2" style={{ fontSize: 13.5, margin: '4px 0 8px' }}>
        {b.theme}
      </div>
      {sides.map(([c, er, lead]) => (
        <div key={c.handle} className="mini" onClick={() => router.push(`/${c.handle}`)}>
          <Avatar u={c} size={34} />
          <div style={{ flex: 1, minWidth: 0 }} className="nm">
            <b>{c.name}</b>
          </div>
          <b className={lead ? 'up' : 't2'}>{(er * 100).toFixed(2)}%</b>
        </div>
      ))}
      <div className="erbar" style={{ margin: '10px 0 14px' }}>
        <i style={{ width: `${(b.erA / tot) * 100}%`, background: 'var(--vio)' }} />
        <i style={{ width: `${(b.erB / tot) * 100}%`, background: 'var(--pink)' }} />
      </div>
      <button className="btn btn-glass btn-sm btn-block" onClick={() => router.push('/battles')}>
        Back a side
      </button>
    </div>
  );
}

export function Rail() {
  const slide = useUI((s) => s.slide);
  return (
    <aside className="rail" id="rail">
      <RailSearch />
      <div>
        <div id="lcard">
          <LaunchCard />
        </div>
        <div className="lc-dots">
          {[0, 1].map((i) => (
            <button key={i} className={slide === i ? 'on' : ''} aria-label={`Slide ${i + 1}`} onClick={() => useUI.setState({ slide: i })} />
          ))}
        </div>
      </div>
      <LiveTrades />
      <LiveBattle />
      <nav className="rail-foot">
        <Link href="/model">Open model</Link>
        <Link href="/genesis">Genesis</Link>
        <Link href="/launchpad">Launchpad</Link>
        <Link href="/leaderboard">Leaderboard</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
        <span>Robinhood Chain</span>
      </nav>
    </aside>
  );
}
