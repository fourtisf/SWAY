'use client';
import type { MessageDTO } from '@sway/shared';
import { useEffect, useRef, useState } from 'react';
import { weiToEth } from '@sway/curve';
import { Icon } from '../icons';
import { Avatar, Empty, Loading } from '../ui';
import { useActions } from '@/lib/actions';
import { useFormat } from '@/lib/format';
import { useRoomSubscription } from '@/lib/live';
import { useRoom } from '@/lib/queries';

/** Prototype chatHtml(): bubbles + input, Enter to send. */
export function Chat({ msgs, placeholder, onSend }: { msgs: MessageDTO[]; placeholder: string; onSend: (text: string) => Promise<void> | void }) {
  const [v, setV] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [msgs.length]);
  const send = async () => {
    const t = v.trim();
    if (!t) return;
    setV('');
    await onSend(t);
    inp.current?.focus();
  };
  return (
    <div className="room">
      <div className="room-msgs" id="msgs" ref={box}>
        {!msgs.length && (
          <div className="t3" style={{ margin: 'auto', fontSize: 14 }}>
            No messages yet. Say hi.
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`msg ${m.mine ? 'mine' : ''}`}>
            <Avatar u={m.from} size={28} />
            <div className="bub">
              <small>{m.mine ? 'You' : m.from.name}</small>
              {m.text}
            </div>
          </div>
        ))}
      </div>
      <div className="room-in">
        <input
          ref={inp}
          className="field"
          id="roomIn"
          placeholder={placeholder}
          aria-label="Message"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
        />
        <button className="btn btn-white" style={{ height: 44 }} aria-label="Send" onClick={send}>
          <Icon name="send" />
        </button>
      </div>
    </div>
  );
}

/** A creator's room: unclaimed / locked (buy 1 key) / open chat (prototype roomHtml()). */
export function RoomView({ handle }: { handle: string }) {
  const { data } = useRoom(handle);
  const F = useFormat();
  const { openTrade, sendRoom } = useActions();
  useRoomSubscription(handle, data?.access === 'open');
  if (!data) return <Loading />;
  if (data.access === 'unclaimed')
    return (
      <Empty icon="lock" title={`The room opens when @${handle} claims`}>
        Fan markets have no owner yet. Holders keep their keys when the account joins.
      </Empty>
    );
  if (data.access === 'locked')
    return (
      <Empty
        icon="lock"
        title="Hold 1 key to enter"
        action={
          <button className="btn btn-buy" onClick={() => openTrade(handle, 'buy')}>
            Buy 1 key for {F.$(weiToEth(data.oneKeyTotalWei))}
          </button>
        }
      >
        Access is checked onchain each time you open the room. Sell your last key and the door closes.
      </Empty>
    );
  return <Chat msgs={data.messages} placeholder={`Message holders of @${handle}`} onSend={(t) => sendRoom(handle, t)} />;
}
