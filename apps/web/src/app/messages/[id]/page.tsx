'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { Loading, NeedUser } from '@/components/ui';
import { Chat, RoomView } from '@/components/views/Chat';
import { useActions } from '@/lib/actions';
import { useDmSubscription } from '@/lib/live';
import { qk, useDm, useMe } from '@/lib/queries';

function DmThread({ id }: { id: string }) {
  const { data } = useDm(id, true);
  const { sendDm } = useActions();
  const qc = useQueryClient();
  const loaded = !!data;
  useDmSubscription(id);
  useEffect(() => {
    // Opening a thread marks it read: refresh the Messages badge.
    if (loaded) {
      qc.invalidateQueries({ queryKey: qk.me });
      qc.invalidateQueries({ queryKey: qk.messages });
    }
  }, [loaded, qc]);
  if (!data) return <Loading />;
  return <Chat msgs={data.messages} placeholder={`Message @${data.thread.with.handle}`} onSend={(t) => sendDm(id, t)} />;
}

export default function ThreadPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const me = useMe();
  if (me.isPending) return <Loading />;
  if (!me.data) return <NeedUser title="Connect X to message" text="Key rooms you hold and direct messages live here." />;
  if (id.startsWith('room-')) return <RoomView handle={id.slice(5)} />;
  return <DmThread id={id} />;
}
