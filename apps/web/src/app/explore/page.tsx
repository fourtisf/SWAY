'use client';
import type { ExploreSort, ExploreTab } from '@sway/shared';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Icon } from '@/components/icons';
import { goTag } from '@/components/shell/Rail';
import { Empty, Loading, Tabs } from '@/components/ui';
import { HoloCard } from '@/components/views/Post';
import { useFormat } from '@/lib/format';
import { useExplore } from '@/lib/queries';
import { useUI } from '@/lib/store';

const TABS: ExploreTab[] = ['creators', 'launched', 'new', 'tags'];

export default function ExplorePage() {
  useEffect(() => {
    // Shared links can open a tab: swayfamily.com/explore?tab=launched
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && (TABS as string[]).includes(t)) useUI.setState({ exploreTab: t as ExploreTab });
  }, []);
  const tab = useUI((s) => s.exploreTab);
  const sort = useUI((s) => s.exploreSort);
  const q = useUI((s) => s.exploreQ);
  const F = useFormat();
  const router = useRouter();
  const { data } = useExplore(tab, sort, q.trim().replace(/^[@#]/, '').toLowerCase());
  const top = (
    <>
      <div className="pad" style={{ paddingBottom: 6 }}>
        <div className="search">
          <label className="sr" htmlFor="exq">
            Search
          </label>
          <Icon name="search" />
          <input
            className="field"
            id="exq"
            placeholder="Search members or #tags"
            autoComplete="off"
            value={q}
            onChange={(e) => {
              const v = e.target.value;
              useUI.setState(v.startsWith('#') ? { exploreQ: v, exploreTab: 'tags' } : { exploreQ: v });
            }}
          />
        </div>
      </div>
      <Tabs<ExploreTab>
        items={[
          ['creators', 'Creators'],
          ['launched', 'Just launched'],
          ['new', 'New members'],
          ['tags', 'Tags'],
        ]}
        value={tab}
        onChange={(v) => useUI.setState({ exploreTab: v })}
      />
    </>
  );
  if (tab === 'tags')
    return (
      <>
        {top}
        {(data?.tags ?? []).map((t, i) => (
          <div key={t.tag} className="tr clickable" style={{ gridTemplateColumns: '28px minmax(0,1fr) auto' }} onClick={() => goTag(router, t.tag)}>
            <span className="rk">{i + 1}</span>
            <div>
              <b style={{ fontSize: 15 }}>#{t.tag}</b>
              <div className="hd">{F.n(t.posts)} posts today</div>
            </div>
            <span className="tag line">Trending</span>
          </div>
        ))}
      </>
    );
  const sorts: Array<[ExploreSort, string]> = [
    ['trending', 'Trending'],
    ['volume', 'Volume'],
    ['price', 'Price'],
    ['score', 'Score'],
  ];
  const list = data?.creators;
  return (
    <>
      {top}
      {tab === 'creators' && (
        <div className="row" style={{ padding: '14px 18px 0', gap: 6, flexWrap: 'wrap' }}>
          {sorts.map(([k, l]) => (
            <button key={k} className={`chip ${sort === k ? 'on' : ''}`} onClick={() => useUI.setState({ exploreSort: k })}>
              {l}
            </button>
          ))}
        </div>
      )}
      {!list ? (
        <Loading />
      ) : list.length ? (
        <div className="cards">
          {list.map((c) => (
            <HoloCard key={c.handle} c={c} />
          ))}
        </div>
      ) : (
        tab === 'launched' && !q ? (
          <Empty icon="rocket" title="No keys launched yet">
            Be the first: open your profile and tap Launch my key.
          </Empty>
        ) : (
          <Empty icon="search" title={`No member matches “${q}”`}>
            Try a shorter name or handle.
          </Empty>
        )
      )}
    </>
  );
}
