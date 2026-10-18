'use client';
import { weiToEth } from '@sway/curve';
import type { MarketCategory } from '@sway/shared';
import { useRouter } from 'next/navigation';
import { Loading, Tabs, Avatar, VB } from '@/components/ui';
import { useActions } from '@/lib/actions';
import { useFormat } from '@/lib/format';
import { useMarkets } from '@/lib/queries';
import { useUI } from '@/lib/store';

const COLS = { gridTemplateColumns: '24px minmax(0,1fr) 90px 92px 64px' };

export default function MarketsPage() {
  const tab = useUI((s) => s.mkTab);
  const { data } = useMarkets(tab);
  const F = useFormat();
  const router = useRouter();
  const { openTrade } = useActions();
  return (
    <>
      <Tabs<MarketCategory>
        items={[
          ['creators', 'Creators'],
          ['crypto', 'Crypto'],
          ['football', 'Football'],
          ['stocks', 'Stocks'],
          ['rwa', 'RWA'],
        ]}
        value={tab}
        onChange={(v) => useUI.setState({ mkTab: v })}
      />
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="grid3" style={{ padding: '16px 18px' }}>
            <div className="glass stat">
              <small>Markets</small>
              <b>{data.stats.markets}</b>
            </div>
            <div className="glass stat">
              <small>Traded</small>
              <b>{F.$(weiToEth(data.stats.volumeWei))}</b>
            </div>
            <div className="glass stat">
              <small>Holders</small>
              <b>{F.int(data.stats.holders)}</b>
            </div>
          </div>
          {tab !== 'creators' && (
            <div style={{ padding: '0 18px 14px' }}>
              <div className="note">
                Fan markets: these accounts haven’t joined Sway and don’t run, endorse or profit from them. The 6% creator fee waits in escrow until the owner signs in with X.
              </div>
            </div>
          )}
          <div className="tr th mk" style={{ ...COLS, borderTop: '1px solid var(--stroke)' }}>
            <span>#</span>
            <span>Account</span>
            <span className="num hm">Followers</span>
            <span className="num">Key</span>
            <span />
          </div>
          {data.markets.map((c, i) => {
            const price = weiToEth(c.priceWei);
            return (
              <div key={c.handle} className="tr clickable mk" style={COLS} onClick={() => router.push(`/${c.handle}`)}>
                <span className="rk">{i + 1}</span>
                <div className="row" style={{ minWidth: 0 }}>
                  <Avatar u={c} size={42} />
                  <div style={{ minWidth: 0 }}>
                    <div className="nm">
                      <b>{c.name}</b>
                      <VB v={c.verified} />
                    </div>
                    <div className="hd">
                      {c.claimed ? (
                        '@' + c.handle
                      ) : (
                        <>
                          <span style={{ color: 'var(--warn)' }}>Unclaimed</span>
                          {'  @' + c.handle}
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="num hm">
                  <b>{F.n(c.followers)}</b>
                </div>
                <div className="num">
                  <b>{F.$(price)}</b>
                  <small className={c.change >= 0 ? 'up' : 'dn'}>{c.claimed ? F.pct(c.change) : F.eth(price) + ' ETH'}</small>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <button
                    className="btn btn-buy btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      openTrade(c.handle, 'buy');
                    }}
                  >
                    Buy
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
