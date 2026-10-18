'use client';
import { Composer } from '@/components/modals/Composer';
import { Icon } from '@/components/icons';
import { Empty, Loading } from '@/components/ui';
import { PostItem } from '@/components/views/Post';
import Link from 'next/link';
import { useFeed, useMe } from '@/lib/queries';
import { openModal, useUI } from '@/lib/store';

export default function HomePage() {
  const tab = useUI((s) => s.feedTab);
  const me = useMe();
  const feed = useFeed(tab);
  const head = me.isPending ? null : me.data ? (
    <Composer />
  ) : (
    <div className="guest">
      <p>
        You’re browsing as a guest. <b>Connect X</b> to post, trade keys and start earning points.
      </p>
      <button className="btn btn-white btn-sm" onClick={() => openModal({ type: 'connect' })}>
        <Icon name="x" size={14} />
        Connect X
      </button>
    </div>
  );
  const d = feed.data;
  return (
    <>
      {head}
      {(tab === 'foryou' || tab === 'latest') && d?.pinned && <PostItem p={d.pinned} pinned />}
      {!d ? (
        <Loading />
      ) : d.posts.length ? (
        d.posts.map((p) => <PostItem key={p.id} p={p} />)
      ) : (
        <Empty
          icon="users"
          title="Your Following tab is empty"
          action={
            <Link className="btn btn-white btn-sm" href="/explore">
              Find creators
            </Link>
          }
        >
          Buy a key or follow a creator and their posts land here.
        </Empty>
      )}
    </>
  );
}
