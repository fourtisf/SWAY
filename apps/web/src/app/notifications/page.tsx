'use client';
import { minutesSince, type NotificationTab, type NotificationType } from '@sway/shared';
import { Icon, type IconName } from '@/components/icons';
import { Avatar, Empty, Loading, NeedUser, Tabs } from '@/components/ui';
import { useActions } from '@/lib/actions';
import { useFormat } from '@/lib/format';
import { useMe, useNotifications } from '@/lib/queries';
import { useUI } from '@/lib/store';

const ICON: Record<NotificationType, [IconName, string]> = {
  trade: ['key', 'buy'],
  battle: ['swords', 'fight'],
  points: ['bolt', 'pts'],
  mention: ['chat', 'men'],
};
const OFFICIAL = { handle: 'swaydotfamily', name: 'Sway', official: true, avatarUrl: null };

export default function NotificationsPage() {
  const me = useMe();
  const tab = useUI((s) => s.ntTab);
  const { data } = useNotifications(tab, !!me.data);
  const F = useFormat();
  const { openNotification } = useActions();
  if (me.isPending) return <Loading />;
  if (!me.data) return <NeedUser title="Connect X to get notified" text="You’ll see trades in your keys, mentions, battle challenges and verified tasks here." />;
  return (
    <>
      <Tabs<NotificationTab>
        items={[
          ['all', 'All'],
          ['trades', 'Trades'],
          ['mentions', 'Mentions'],
        ]}
        value={tab}
        onChange={(v) => useUI.setState({ ntTab: v })}
      />
      {!data ? (
        <Loading />
      ) : data.length ? (
        data.map((n) => {
          const [ic, cls] = ICON[n.type];
          const w = n.from ?? OFFICIAL;
          return (
            <div key={n.id} className={`nt ${n.read ? '' : 'unread'} ${n.link ? 'clickable' : ''}`} onClick={() => n.link && openNotification(n)}>
              <span className={`nt-ic ${cls}`}>
                <Icon name={ic} />
              </span>
              <div className="nt-b">
                <div className="row" style={{ gap: 8 }}>
                  <Avatar u={w} size={30} />
                  <span className="t3" style={{ fontSize: 12.5, marginLeft: 'auto' }}>
                    {F.ago(minutesSince(n.createdAt))}
                  </span>
                </div>
                <p>{n.body.map((s, i) => (s.b ? <b key={i}>{s.t}</b> : <span key={i}>{s.t}</span>))}</p>
              </div>
            </div>
          );
        })
      ) : (
        <Empty icon="bell" title="Nothing here yet">
          Trades in your keys and mentions show up as they happen.
        </Empty>
      )}
    </>
  );
}
