'use client';
import { useRouter } from 'next/navigation';
import { useMe } from '@/lib/queries';
import { Icon, type IconName } from '../icons';
import { useNavKey } from './nav';
import { compose } from './Sidebar';

const TB: Array<[string, string, IconName, string]> = [
  ['home', 'Home', 'home', '/'],
  ['explore', 'Explore', 'search', '/explore'],
  ['markets', 'Markets', 'market', '/markets'],
  ['notifications', 'Alerts', 'bell', '/notifications'],
  ['wallet', 'Wallet', 'wallet', '/wallet'],
];

export function TabBar() {
  const v = useNavKey();
  const me = useMe().data;
  const router = useRouter();
  return (
    <>
      <nav className="tabbar" id="tabbar" aria-label="Sections">
        {TB.map(([k, l, ic, href]) => (
          <button key={k} className={v === k ? 'on' : ''} aria-label={l} onClick={() => router.push(href)}>
            <Icon name={ic} />
            <span className="tl">{l}</span>
            {k === 'notifications' && me?.unreadNotifications ? <span className="badge-dot" /> : null}
          </button>
        ))}
      </nav>
      <button className="fab" id="fab" aria-label="New post" onClick={() => compose(!!me)}>
        <Icon name="feather" />
      </button>
    </>
  );
}
