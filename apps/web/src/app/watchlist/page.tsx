'use client';
/** [D] Watchlist: keys you follow the price of, with the alert threshold for each. */
import { weiToEth } from '@sway/curve';
import Link from 'next/link';
import { WatchButton } from '@/components/engage/Engage';
import { Avatar, Empty, Loading, NeedUser, VB } from '@/components/ui';
import { useWatchlist } from '@/lib/engage';
import { useFormat } from '@/lib/format';
import { useMe } from '@/lib/queries';

export default function WatchlistPage() {
  const me = useMe();
  const F = useFormat();
  const { data } = useWatchlist(!!me.data);
  if (me.isPending) return <Loading />;
  if (!me.data) return <NeedUser title="Connect X to keep a watchlist" text="Star any key to follow its price and get an alert when it moves." />;
  if (!data) return <Loading />;
  if (!data.items.length)
    return (
      <Empty
        icon="star"
        title="Nothing on your watchlist yet"
        action={
          <Link className="btn btn-white" href="/markets">
            Browse markets
          </Link>
        }
      >
        Tap the star on any profile to follow its key price and get an alert when it moves.
      </Empty>
    );
  return (
    <div id="watchlist">
      {data.items.map((w) => (
        <div key={w.handle} className="tr watch-r">
          <Link href={`/${w.handle}`} className="row" style={{ minWidth: 0 }}>
            <Avatar u={w} size={40} />
            <span style={{ minWidth: 0 }}>
              <span className="nm">
                <b>{w.name}</b>
                <VB v={w.verified} />
              </span>
              <span className="hd">
                @{w.handle} · {w.alertPct ? `alert at ±${w.alertPct}%` : 'no alert'}
              </span>
            </span>
          </Link>
          <span style={{ textAlign: 'right' }}>
            <b>{F.eth(weiToEth(BigInt(w.priceWei)))} ETH</b>
            <br />
            <span className={w.change >= 0 ? 'up' : 'dn'} style={{ fontSize: 13, fontWeight: 600 }}>
              {w.change >= 0 ? '+' : ''}
              {w.change.toFixed(1)}% since set
            </span>
          </span>
          <WatchButton handle={w.handle} />
        </div>
      ))}
    </div>
  );
}
