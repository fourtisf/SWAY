'use client';
import { unitsToKeys, weiToEth } from '@sway/curve';
import { frameOfScore, tierOf } from '@sway/scoring';
import { hueOf, minutesSince } from '@sway/shared';
import { useParams, useRouter } from 'next/navigation';
import { useState, type CSSProperties } from 'react';
import { Icon } from '@/components/icons';
import { Avatar, Empty, Loading, Tabs, VB, Voiceprint } from '@/components/ui';
import { RoomView } from '@/components/views/Chat';
import { BlockedNote, ChartCard, ProfileMenu } from '@/components/views/ProfileExtras'; // [B]
import { CreatorDrops } from '@/components/engage/Drops'; // [D]
import { WatchButton } from '@/components/engage/Engage'; // [D]
import { PostItem } from '@/components/views/Post';
import { useActions } from '@/lib/actions';
import { useFormat } from '@/lib/format';
import { useHolders, useMe, useProfile, useProfilePosts, useProfileTrades, useWallet } from '@/lib/queries';
import { openModal, type ProfileTab } from '@/lib/store';
import { useSocialActions } from '@/lib/social';

function Posts({ handle, isMe }: { handle: string; isMe: boolean }) {
  const { data } = useProfilePosts(handle);
  if (!data) return <Loading />;
  if (!data.length)
    return (
      <Empty icon="reply" title={isMe ? 'You haven’t posted yet' : 'No posts yet'}>
        {isMe ? 'Your first post shows up here and in your holders’ feeds.' : `When @${handle} posts, it lands here.`}
      </Empty>
    );
  return (
    <>
      {data.map((p) => (
        <PostItem key={p.id} p={p} />
      ))}
    </>
  );
}

function Holders({ handle }: { handle: string }) {
  const { data } = useHolders(handle);
  const F = useFormat();
  if (!data) return <Loading />;
  return (
    <>
      {data.map((x, i) => (
        <div key={x.handle + i} className="tr" style={{ gridTemplateColumns: '24px minmax(0,1fr) auto' }}>
          <span className="rk">{i + 1}</span>
          <div className="row" style={{ minWidth: 0 }}>
            <Avatar u={x} size={36} />
            <div style={{ minWidth: 0 }}>
              <div className="nm">
                <b>{x.name}</b>
                {x.you && <span className="tag">You</span>}
              </div>
              <div className="hd">@{x.handle}</div>
            </div>
          </div>
          <div className="num">
            <b>{F.keys(unitsToKeys(x.units))}</b>
            <small>keys</small>
          </div>
        </div>
      ))}
    </>
  );
}

function Trades({ handle }: { handle: string }) {
  const { data } = useProfileTrades(handle);
  const F = useFormat();
  if (!data) return <Loading />;
  return (
    <>
      {data.map((t, i) => {
        const k = unitsToKeys(t.units);
        return (
          <div key={`${t.txHash}:${t.logIndex}:${i}`} className="tr" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <div className="row" style={{ minWidth: 0 }}>
              <Avatar u={t.trader} size={34} />
              <div style={{ minWidth: 0, fontSize: 14 }}>
                <b>{t.trader.name}</b>{' '}
                <span className={t.isBuy ? 'up' : 'dn'} style={{ fontWeight: 600 }}>
                  {t.isBuy ? 'bought' : 'sold'}
                </span>{' '}
                {F.keys(k)} key{k === 1 ? '' : 's'}
              </div>
            </div>
            <div className="num">
              <b>{F.$(weiToEth(t.baseWei))}</b>
              <small>{F.ago(minutesSince(t.ts))}</small>
            </div>
          </div>
        );
      })}
    </>
  );
}

function Profile({ handle }: { handle: string }) {
  const { data: c, error, isPending } = useProfile(handle);
  const me = useMe().data;
  const wallet = useWallet(!!me?.wallet && !!c?.isMe).data;
  const F = useFormat();
  const router = useRouter();
  const a = useActions();
  const [tab, setTab] = useState<ProfileTab>('posts');
  if (isPending) return <Loading />;
  if (error || !c)
    return (
      <Empty icon="search" title="This account doesn’t exist">
        Try searching for another member.
      </Empty>
    );
  const isMe = c.isMe;
  const held = unitsToKeys(c.heldUnits);
  const price = weiToEth(c.priceWei);
  const up = c.change >= 0;
  const hue = hueOf(handle);
  const frame = isMe && me ? tierOf(me.points.total).frame : frameOfScore(c.score);
  const claimable = wallet ? weiToEth(wallet.earnings.totalWei) : 0;
  return (
    <>
      <div className="p-banner" style={{ '--hue': hue } as CSSProperties}>
        <Voiceprint seed={handle + 'b'} score={c.score} bars={90} id="pb" />
      </div>
      <div className="p-body">
        <div className="p-top">
          <span className="av-wrap" style={{ '--frame': frame } as CSSProperties}>
            <Avatar u={c} size={100} />
          </span>
          <div className="p-acts">
            {isMe ? (
              <button className="btn btn-glass btn-sm" onClick={a.shareCard}>
                <Icon name="share" />
                Share card
              </button>
            ) : c.deleted ? null : c.blocked ? (
              <>
                <ProfileMenu c={c} />
                <BlockedButton handle={handle} />
              </>
            ) : c.claimed ? (
              <>
                <ProfileMenu c={c} />
                <WatchButton handle={handle} />
                <button className="btn btn-glass btn-sm" aria-label="Message" onClick={() => a.dm(handle)}>
                  <Icon name="chat" size={16} />
                </button>
                <button className="btn btn-glass btn-sm" onClick={() => a.tip(handle)}>
                  Tip
                </button>
                <button className={`btn ${c.following ? 'btn-glass' : 'btn-white'} btn-sm`} onClick={() => a.follow(handle)}>
                  {c.following ? 'Following' : 'Follow'}
                </button>
              </>
            ) : (
              <>
                <WatchButton handle={handle} />
                <button className="btn btn-glass btn-sm" onClick={() => openModal({ type: 'claim', handle })}>
                  This is my account
                </button>
              </>
            )}
          </div>
        </div>
        <div className="p-name">
          <h2>{c.name}</h2>
          <VB v={c.verified} />
          {!c.claimed && <span className="tag warn">Unclaimed fan market</span>}
          {isMe && <span className="tag">You</span>}
        </div>
        <div className="hd" style={{ fontSize: 14.5 }}>
          @{handle}
          {c.claimed && c.memberNo ? `  Member #${c.memberNo}` : ''}
        </div>
        <p className="p-bio">{c.bio}</p>
        <div className="p-meta">
          <span>
            <b>{F.n(c.followers)}</b> on X
          </span>
          <span>
            <b>{c.score}</b> Sway score
          </span>
          <span>
            <b>{F.usd(c.reachValue)}</b> reach value
          </span>
          {held > 0 && !isMe && (
            <span>
              <b>{F.keys(held)}</b> keys held by you
            </span>
          )}
        </div>
      </div>
      <div className="glass price-bar">
        <div>
          <div className="t3" style={{ fontSize: 12.5, fontWeight: 600 }}>
            Key price
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
            <span className="pv">{F.$(price)}</span>
            {c.claimed && !isMe && (
              <span className={up ? 'up' : 'dn'} style={{ fontWeight: 650, fontSize: 13.5 }}>
                {F.pct(c.change)}
              </span>
            )}
          </div>
          <div className="t3" style={{ fontSize: 12 }}>
            {F.eth(price)} ETH
          </div>
        </div>
        <div className="acts">
          {isMe ? (
            <button className="btn btn-glass" onClick={() => router.push('/wallet')}>
              Earnings {F.$(claimable)}
            </button>
          ) : (
            <>
              <button className="btn btn-glass" disabled={!(held > 0)} onClick={() => a.openTrade(handle, 'sell')}>
                Sell
              </button>
              <button className="btn btn-buy" onClick={() => a.openTrade(handle, 'buy')}>
                Buy key
              </button>
            </>
          )}
        </div>
      </div>
      <div className="glass kst">
        <div>
          <small>Supply</small>
          <b>{F.keys(unitsToKeys(c.supplyUnits))}</b>
        </div>
        <div>
          <small>Holders</small>
          <b>{c.holders}</b>
        </div>
        <div>
          <small>{c.claimed ? 'Volume' : 'In escrow'}</small>
          <b>{F.$(weiToEth(c.claimed ? c.volumeWei : c.escrowWei))}</b>
        </div>
        <div>
          <small>Creator fee</small>
          <b>6%</b>
        </div>
      </div>
      <ChartCard c={c} />
      {c.creatorInactive && (
        <div className="note" id="bondNote" style={{ margin: '0 16px 16px' }}>
          {c.isMe
            ? 'You haven’t posted in your room for 7 days, so your 6% creator fee goes to your holders. Post in your room to get it back.'
            : `${c.name} hasn’t posted in their room for 7 days, so the 6% creator fee goes to holders until they do.`}
        </div>
      )}
      <CreatorDrops handle={handle} isMe={c.isMe} opened={c.claimed !== false && !c.deleted && BigInt(c.supplyUnits) >= 100n} />
      {c.blocked && <BlockedNote handle={handle} />}
      <div className="ptabs">
        <Tabs<ProfileTab>
          items={[
            ['posts', 'Posts'],
            ['room', 'Room'],
            ['holders', 'Holders'],
            ['trades', 'Trades'],
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'posts' &&
          (c.blocked ? (
            <Empty icon="block" title={`You blocked @${handle}`} action={<BlockedButton handle={handle} />}>
              Unblock to see their posts again.
            </Empty>
          ) : (
            <Posts handle={handle} isMe={isMe} />
          ))}
        {tab === 'room' && <RoomView handle={handle} />}
        {tab === 'holders' && <Holders handle={handle} />}
        {tab === 'trades' && <Trades handle={handle} />}
      </div>
    </>
  );
}

/** [B] */
function BlockedButton({ handle }: { handle: string }) {
  const s = useSocialActions();
  return (
    <button className="btn btn-glass btn-sm danger-t" onClick={() => s.block(handle)}>
      Unblock
    </button>
  );
}

export default function ProfilePage() {
  const params = useParams<{ handle: string }>();
  const handle = decodeURIComponent(params.handle).replace(/^@/, '').toLowerCase();
  return <Profile key={handle} handle={handle} />;
}
