'use client';
/** [B] Public share card: score, reach value, voiceprint and tier, with a way in. */
import { weiToEth } from '@sway/curve';
import { TIERS } from '@sway/scoring';
import type { CSSProperties } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { Avatar, Empty, Loading, VB, Voiceprint } from '@/components/ui';
import { useActions } from '@/lib/actions';
import { useFormat } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { useCard } from '@/lib/social';
import { openModal } from '@/lib/store';

export default function CardPage() {
  const { handle: raw } = useParams<{ handle: string }>();
  const handle = decodeURIComponent(raw).replace(/^@/, '').toLowerCase();
  const { data: c, isPending } = useCard(handle);
  const me = useMe().data;
  const F = useFormat();
  const a = useActions();
  const router = useRouter();
  if (isPending) return <Loading />;
  if (!c)
    return (
      <Empty icon="search" title="This card doesn’t exist">
        Try searching for another member.
      </Empty>
    );
  const tier = TIERS.find((t) => t.name === c.tier) ?? TIERS[0]!;
  const mine = me?.user.handle === c.handle;
  return (
    <div className="card-page">
      <div className="ic live" style={{ '--frame': tier.frame } as CSSProperties}>
        <div className="ic-in">
          <div className="ic-top">
            <div className="row" style={{ minWidth: 0 }}>
              <Avatar u={c} size={52} />
              <div style={{ minWidth: 0 }}>
                <div className="nm">
                  <b style={{ fontSize: 17 }}>{c.name}</b>
                  <VB v={c.verified} off={c.official} />
                </div>
                <div className="hd">@{c.handle}</div>
              </div>
            </div>
            <span className="tag">{c.tier}</span>
          </div>
          <div className="ic-score">
            <div className="big">{c.score}</div>
            <div className="of">
              /100
              <br />
              Sway score
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <div style={{ fontSize: 26, fontWeight: 750, letterSpacing: '-.03em' }}>{F.usd(c.reachValue)}</div>
              <div className="t3" style={{ fontSize: 12, fontWeight: 600 }}>
                reach value
              </div>
            </div>
          </div>
          <div className="ic-vp" style={{ height: 56 }}>
            <Voiceprint seed={c.handle} score={c.score} bars={60} id="cardvp" />
          </div>
          <div className="ic-grid">
            <div>
              <small>Followers</small>
              <b>{F.n(c.followers)}</b>
            </div>
            <div>
              <small>Key</small>
              <b>{c.priceWei ? F.$(weiToEth(c.priceWei)) : '–'}</b>
            </div>
            <div>
              <small>{c.memberNo ? 'Member' : 'Market'}</small>
              <b>{c.memberNo ? `#${c.memberNo}` : c.claimed ? '–' : 'Fan'}</b>
            </div>
          </div>
        </div>
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn btn-glass btn-block" onClick={() => router.push(`/${c.handle}`)}>
          View profile
        </button>
        {mine ? (
          <button className="btn btn-white btn-block" onClick={a.shareCard}>
            <Icon name="x" />
            Share on X
          </button>
        ) : c.priceWei ? (
          <button className="btn btn-buy btn-block" onClick={() => a.openTrade(c.handle, 'buy')}>
            <Icon name="key" />
            Buy key
          </button>
        ) : null}
      </div>
      {!me && (
        <p className="t2" style={{ fontSize: 14, textAlign: 'center', margin: '18px 0 0' }}>
          What is your reach worth?{' '}
          <button className="lnk" onClick={() => openModal({ type: 'connect' })}>
            Get your Sway card
          </button>
        </p>
      )}
      <p className="disc">Reach value is an in-app estimate from public X metrics, not a valuation. Keys are access, not investments.</p>
    </div>
  );
}
