'use client';
import { weiToEth } from '@sway/curve';
import { hueOf, isVideoUrl, minutesSince, type MarketDTO, type PostDTO } from '@sway/shared';
import { frameOfScore } from '@sway/scoring';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { useActions } from '@/lib/actions';
import { useFormat } from '@/lib/format';
import { Icon } from '../icons';
import { goTag } from '../shell/Rail';
import { Avatar, Spark, VB } from '../ui';
import { PostMenu } from './PostMenu';

/** Mentions → profiles, #tags → Explore, swayfamily.com/model → /model (prototype linkify()). */
export function Linkify({ text }: { text: string }) {
  const router = useRouter();
  const out: ReactNode[] = [];
  const re = /@([a-z0-9_]+)|#(\w+)|swayfamily\.com\/model/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) {
      const h = m[1].toLowerCase();
      out.push(
        <span key={i++} className="mn" onClick={() => router.push(`/${h}`)}>
          {tok}
        </span>,
      );
    } else if (m[2]) {
      const t = m[2];
      out.push(
        <span key={i++} className="ht" onClick={() => goTag(router, t)}>
          {tok}
        </span>,
      );
    } else
      out.push(
        <span key={i++} className="lk" onClick={() => router.push('/model')}>
          {tok}
        </span>,
      );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** X-style image grid: 1 wide, 2 side by side, 3 = one tall + two stacked, 4 = 2×2. A video plays inline. */
export function MediaGrid({ media }: { media: string[] }) {
  if (!media.length) return null;
  if (isVideoUrl(media[0]!))
    return (
      <div className="pm pm1 pmv">
        <video src={media[0]} controls playsInline preload="metadata" />
      </div>
    );
  return (
    <div className={`pm pm${Math.min(4, media.length)}`}>
      {media.slice(0, 4).map((u, i) => (
        <a key={u + i} href={u} target="_blank" rel="noopener noreferrer" aria-label={`Image ${i + 1} of ${media.length}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={u} alt="" loading="lazy" decoding="async" />
        </a>
      ))}
    </div>
  );
}

/** Clicks on these never open the post page. */
const INTERACTIVE = 'a,button,input,textarea,select,label,video,.mn,.ht,.lk,.pmenu,.lockbox';

export function PostItem({ p, pinned = false, focus = false, thread = false }: { p: PostDTO; pinned?: boolean; focus?: boolean; thread?: boolean }) {
  const F = useFormat();
  const a = useActions();
  const router = useRouter();
  const c = p.author;
  const prof = c.official ? '/' : `/${c.handle}`;
  const href = `/post/${p.id}`;
  const visTag =
    p.visibility === 'holders' ? <span className="tag">Holders</span> : p.visibility === 'subs' ? <span className="tag pink">Subscribers</span> : null;
  const open = (e: MouseEvent) => {
    if (focus || (e.target as HTMLElement).closest(INTERACTIVE) || window.getSelection()?.toString()) return;
    router.push(href);
  };
  return (
    <article className={`post ${focus ? 'focus' : ''} ${thread ? 'thread' : ''} ${focus ? '' : 'clickable'}`} style={{ flexDirection: 'column', gap: 0 }} data-post={p.id} onClick={open}>
      {pinned && (
        <div className="pin">
          <Icon name="pin" />
          Pinned
        </div>
      )}
      <div style={{ display: 'flex', gap: 13 }}>
        <div className="post-av">
          <Link href={prof} aria-label={c.name}>
            <Avatar u={c} size={44} />
          </Link>
        </div>
        <div className="post-b">
          {p.boosted && (
            <div className="boost">
              <Icon name="rocket" />
              Boosted
            </div>
          )}
          <div className="post-h">
            <Link className="nm" href={prof}>
              <b>{c.name}</b>
              <VB v={c.verified} off={c.official} />
            </Link>
            <span className="hd">
              @{c.handle} ·{' '}
              <Link href={href} className="pt-time" title={new Date(p.createdAt).toLocaleString()}>
                {F.ago(minutesSince(p.createdAt))}
              </Link>
            </span>
            {visTag}
            {p.hidden && <span className="tag warn">Hidden</span>}
            <PostMenu p={p} />
          </div>
          {p.locked ? (
            <div className="lockbox">
              <div className="blur">{p.teaser ?? ''}</div>
              <div className="over">
                <span className="row">
                  <Icon name="lock" />
                  {p.visibility === 'holders' ? `Hold 1 key of @${c.handle} to read` : `For @${c.handle}’s subscribers`}
                </span>
                {p.visibility === 'holders' ? (
                  <button className="btn btn-white btn-sm" onClick={() => a.openTrade(c.handle, 'buy')}>
                    Unlock
                  </button>
                ) : (
                  <button className="btn btn-white btn-sm" onClick={() => a.subscribe(c.handle)}>
                    Subscribe
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {p.text ? (
                <div className="post-t">
                  <Linkify text={p.text} />
                </div>
              ) : null}
              <MediaGrid media={p.media ?? []} />
            </>
          )}
          <div className="post-a">
            <button
              className="pa"
              data-act="reply"
              aria-label="Reply"
              onClick={() => (focus ? document.getElementById('reply-box')?.focus() : router.push(href))}
            >
              <Icon name="reply" />
              {F.n(p.replies)}
            </button>
            <button className={`pa ${p.reposted ? 'rped' : ''}`} data-act="repost" aria-label="Repost" onClick={() => a.repost(p)}>
              <Icon name="repeat" />
              {F.n(p.reposts)}
            </button>
            <button className={`pa ${p.liked ? 'liked' : ''}`} data-act="like" aria-label="Like" aria-pressed={p.liked} onClick={() => a.like(p)}>
              <Icon name={p.liked ? 'heartF' : 'heart'} />
              {F.n(p.likes)}
            </button>
            {!p.mine && !c.official && c.priceWei && (
              <button className="kchip" aria-label={`Buy a key of ${c.name}`} onClick={() => a.openTrade(c.handle, 'buy')}>
                <span className="k-l">Key</span>
                <b>{F.$(weiToEth(c.priceWei))}</b>
                <span className={`k-c ${c.change >= 0 ? 'up' : 'dn'}`}>{F.pct(c.change)}</span>
                <em>Buy</em>
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/** Explore card (prototype holoCard()). */
export function HoloCard({ c }: { c: MarketDTO }) {
  const F = useFormat();
  const router = useRouter();
  const { openTrade } = useActions();
  const up = c.change >= 0;
  return (
    <div className="hc" style={{ '--h': hueOf(c.handle), '--frame': frameOfScore(c.score) } as CSSProperties} onClick={() => router.push(`/${c.handle}`)}>
      <div className="hc-in">
        <div className="hc-top">
          <span className="hc-score" title="Sway score">
            <i />
            {c.score}
          </span>
          {c.claimed ? <span className={`hc-chg ${up ? 'up' : 'dn'}`}>{F.pct(c.change)}</span> : <span className="tag warn">Unclaimed</span>}
        </div>
        <div className="hc-av">
          <Avatar u={c} size={72} />
        </div>
        <div className="hc-name">
          <div className="nm">
            <b>{c.name}</b>
            <VB v={c.verified} />
          </div>
          <div className="hd">@{c.handle}</div>
        </div>
        <div className="hc-spark">
          <Spark arr={c.spark} up={up} />
        </div>
        <div className="hc-foot">
          <div>
            <small>Key</small>
            <b>{F.$(weiToEth(c.priceWei))}</b>
          </div>
          <div>
            <small>Holders</small>
            <b>{c.holders}</b>
          </div>
        </div>
        <button
          className="btn btn-glass btn-sm btn-block"
          onClick={(e) => {
            e.stopPropagation();
            openTrade(c.handle, 'buy');
          }}
        >
          <Icon name="key" size={15} />
          Buy key
        </button>
      </div>
      <div className="hc-sheen" />
    </div>
  );
}
