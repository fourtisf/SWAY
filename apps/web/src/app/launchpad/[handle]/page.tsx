'use client';
/** [C] Any creator's token: /launchpad/<handle>. */
import { normalizeHandle } from '@sway/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { AirdropsCard } from '@/components/launch/Cards';
import { TokenBox } from '@/components/launch/TokenBox';
import { Avatar, Empty, Loading, VB } from '@/components/ui';
import { useLaunchToken, useMe } from '@/lib/queries';

export default function CreatorTokenPage() {
  const { handle: raw } = useParams<{ handle: string }>();
  const handle = normalizeHandle(decodeURIComponent(raw ?? ''));
  const { data, isError } = useLaunchToken(handle);
  const me = useMe().data;
  const router = useRouter();
  if (isError)
    return (
      <Empty icon="user" title="This account doesn’t exist">
        Try searching for another creator.
      </Empty>
    );
  if (!data) return <Loading />;
  const c = data.creator;
  const isMe = me?.user.handle === c.handle;
  return (
    <>
      <div className="tr clickable" style={{ gridTemplateColumns: 'minmax(0,1fr) auto', borderBottom: 0 }} onClick={() => router.push(`/${c.handle}`)}>
        <div className="row" style={{ minWidth: 0 }}>
          <Avatar u={c} size={44} />
          <div style={{ minWidth: 0 }}>
            <div className="nm">
              <b>{c.name}</b>
              <VB v={c.verified} off={c.official} />
            </div>
            <div className="hd">{`@${c.handle}, Sway score ${c.score}`}</div>
          </div>
        </div>
        <span className={`tag ${data.launched ? 'aqua' : 'line'}`}>{data.symbol}</span>
      </div>
      {data.token ? (
        <>
          <TokenBox t={data.token} />
          <AirdropsCard />
        </>
      ) : (
        <Empty
          icon="rocket"
          title={isMe ? 'You haven’t launched yet' : `@${c.handle} hasn’t launched a token yet`}
          action={
            isMe ? (
              <Link className="btn btn-white" href="/launchpad">
                <Icon name="rocket" />
                Open the launchpad
              </Link>
            ) : (
              <Link className="btn btn-glass" href={`/${c.handle}`}>
                Open profile
              </Link>
            )
          }
        >
          When they do, 10% goes to their key holders. Holding a key now is how you get an allocation.
        </Empty>
      )}
    </>
  );
}
