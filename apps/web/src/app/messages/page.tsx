'use client';
import type { ThreadDTO } from '@sway/shared';
import { useRouter } from 'next/navigation';
import { Avatar, Loading, NeedUser, VB } from '@/components/ui';
import { useMe, useMessages } from '@/lib/queries';

function Row({ t }: { t: ThreadDTO }) {
  const router = useRouter();
  const w = t.with;
  return (
    <div className="thr" onClick={() => router.push(`/messages/${t.kind === 'room' ? `room-${w.handle}` : encodeURIComponent(t.id)}`)}>
      <Avatar u={w} size={46} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="nm">
          <b>{t.kind === 'room' ? `${w.name}’s room` : w.name}</b>
          <VB v={w.verified} off={w.official} />
        </div>
        <div className="last">{t.last ?? ''}</div>
      </div>
      {t.unread && <span className="ud" />}
    </div>
  );
}

export default function MessagesPage() {
  const me = useMe();
  const { data } = useMessages(!!me.data);
  if (me.isPending) return <Loading />;
  if (!me.data) return <NeedUser title="Connect X to message" text="Key rooms you hold and direct messages live here." />;
  if (!data) return <Loading />;
  return (
    <>
      <div className="grp">Key rooms</div>
      {data.rooms.length ? (
        data.rooms.map((t) => <Row key={t.id} t={t} />)
      ) : (
        <div className="t3" style={{ padding: '4px 18px 14px', fontSize: 13.5 }}>
          Hold 1 key of a creator to join their room.
        </div>
      )}
      <div className="grp">Direct messages</div>
      {data.dms.map((t) => (
        <Row key={t.id} t={t} />
      ))}
    </>
  );
}
