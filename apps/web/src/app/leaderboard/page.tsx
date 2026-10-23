'use client';
import { weiToEth } from '@sway/curve';
import { TIERS } from '@sway/scoring';
import { hueOf, type LeaderboardRow, type LeaderboardTab } from '@sway/shared';
import { useRouter } from 'next/navigation';
import type { CSSProperties } from 'react';
import { Avatar, Loading, Tabs } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useLeaderboard, useMe } from '@/lib/queries';
import { openModal, useUI } from '@/lib/store';
import { TOKEN } from '@/lib/token';

const COLS = { gridTemplateColumns: '46px minmax(0,1fr) auto 96px' };

export default function LeaderboardPage() {
  const tab = useUI((s) => s.lbTab);
  const { data } = useLeaderboard(tab);
  const me = useMe().data;
  const F = useFormat();
  const router = useRouter();
  const val: Record<LeaderboardTab, (r: LeaderboardRow) => [string, string]> = {
    points: (r) => [F.int(r.points), 'points'],
    creators: (r) => [F.$(weiToEth(r.feesWei)), 'fees earned'],
    stakers: (r) => [F.int(r.staked), `${TOKEN.unit} staked`],
    fighters: (r) => [F.int(r.won), 'points won'],
  };
  const v = val[tab];
  const tabs = (
    <Tabs<LeaderboardTab>
      items={[
        ['points', 'Points'],
        ['creators', 'Creators'],
        ['stakers', 'Stakers'],
        ['fighters', 'Fighters'],
      ]}
      value={tab}
      onChange={(t) => useUI.setState({ lbTab: t })}
    />
  );
  if (!data)
    return (
      <>
        {tabs}
        <Loading />
      </>
    );
  const rows = data.rows;
  const pod = rows.slice(0, 3);
  const order = [pod[1], pod[0], pod[2]].filter(Boolean) as LeaderboardRow[];
  const frames = [TIERS[2]!.frame, TIERS[4]!.frame, TIERS[3]!.frame];
  const rest = rows.slice(3, 40);
  if (data.me && !rows.slice(0, 40).some((r) => r.me)) rest.push(data.me);
  const go = (h: string) => router.push(`/${h}`);
  return (
    <>
      {tabs}
      <div className="podium">
        {order.map((r, i) => (
          <div key={r.user.handle} className={`pod ${r.rank === 1 ? 'first' : ''}`} style={{ '--frame': frames[i], '--h': hueOf(r.user.handle) } as CSSProperties}>
            <div className="pod-in clickable" onClick={() => go(r.user.handle)}>
              <span className="pod-rk">{r.rank}</span>
              <Avatar u={r.user} size={r.rank === 1 ? 68 : 54} />
              <div className="nm">
                <b>{r.user.name}</b>
              </div>
              <div className="hd">@{r.user.handle}</div>
              <div className="pod-v">{v(r)[0]}</div>
              <div className="t3" style={{ fontSize: 12 }}>
                {v(r)[1]}
              </div>
            </div>
          </div>
        ))}
      </div>
      {rest.map((r) => (
        <div key={r.user.handle + (r.me ? ':me' : '')} className={`tr ${r.me ? 'me' : ''}`} style={COLS}>
          <span className="rk">{F.int(r.rank)}</span>
          <div className="row clickable" style={{ minWidth: 0 }} onClick={() => go(r.user.handle)}>
            <Avatar u={r.user} size={38} />
            <div style={{ minWidth: 0 }}>
              <div className="nm">
                <b>{r.user.name}</b>
                {r.me && <span className="tag">You</span>}
              </div>
              <div className="hd">
                @{r.user.handle} {' '}
                {r.tier}
              </div>
            </div>
          </div>
          <div className="num">
            <b>{v(r)[0]}</b>
          </div>
          <div style={{ textAlign: 'right' }}>
            {!r.me && (
              <button className="btn btn-glass btn-sm" onClick={() => openModal(me ? { type: 'challenge', handle: r.user.handle } : { type: 'connect' })}>
                Challenge
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
