'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment } from 'react';
import { useMe } from '@/lib/queries';
import { openModal, useUI } from '@/lib/store';
import { routeOf } from '@/lib/util';
import { Icon, Logo, type IconName } from '../icons';
import { Avatar, VB } from '../ui';

type NavItem = [key: string, label: string, icon: IconName, href: string] | 'sep';

export const NAV: NavItem[] = [
  ['home', 'Home', 'home', '/'],
  ['explore', 'Explore', 'search', '/explore'],
  ['markets', 'Markets', 'market', '/markets'],
  ['notifications', 'Notifications', 'bell', '/notifications'],
  ['messages', 'Messages', 'chat', '/messages'],
  ['tasks', 'Tasks', 'tasks', '/tasks'],
  ['wallet', 'Wallet', 'wallet', '/wallet'],
  'sep',
  ['leaderboard', 'Leaderboard', 'trophy', '/leaderboard'],
  ['battles', 'Battles', 'swords', '/battles'],
  ['launchpad', 'Launchpad', 'rocket', '/launchpad'],
  ['genesis', 'Genesis pass', 'gem', '/genesis'],
  ['model', 'Open model', 'code', '/model'],
];

/** Which nav item is active: the view, or 'me' on your own profile (prototype navKey()). */
export function useNavKey(): string {
  const pathname = usePathname();
  const me = useMe().data;
  const { view, arg } = routeOf(pathname);
  if (view === 'profile') return arg === me?.user.handle ? 'me' : '';
  return view;
}

const close = () => useUI.setState({ drawer: false });

export function NavItems() {
  const v = useNavKey();
  const me = useMe().data;
  return (
    <>
      {NAV.map((n, i) => {
        if (n === 'sep') return <div key={'sep' + i} className="nv-sep" />;
        const [k, l, ic, href] = n;
        const b = k === 'notifications' ? me?.unreadNotifications : k === 'messages' ? me?.unreadMessages : 0;
        return (
          <Fragment key={k}>
            <Link className={`nv ${v === k ? 'on' : ''}`} href={href} title={l} onClick={close} aria-current={v === k ? 'page' : undefined}>
              <Icon name={ic} />
              <span className="nl">{l}</span>
              {b ? <span className="badge">{b}</span> : null}
            </Link>
          </Fragment>
        );
      })}
      {me && (
        <Link className={`nv ${v === 'me' ? 'on' : ''}`} href={`/${me.user.handle}`} title="Profile" onClick={close}>
          <Icon name="user" />
          <span className="nl">Profile</span>
        </Link>
      )}
    </>
  );
}

export function MeChip() {
  const me = useMe().data;
  if (!me)
    return (
      <button className="btn btn-glass btn-block" style={{ height: 48, borderRadius: 14 }} onClick={() => openModal({ type: 'connect' })}>
        <Icon name="x" />
        <span className="nl me-t">Connect X</span>
      </button>
    );
  const u = me.user;
  return (
    <Link className="me-chip" href={`/${u.handle}`} onClick={close}>
      <Avatar u={u} size={42} />
      <div className="me-t" style={{ minWidth: 0, flex: 1 }}>
        <div className="nm">
          <b>{u.name}</b>
          <VB v={u.verified} />
        </div>
        <div className="hd">@{u.handle}</div>
      </div>
      <span className="dots">···</span>
    </Link>
  );
}

export function LogoLink({ size = 20, style, wordmarkClass = 'wm' }: { size?: number; style?: React.CSSProperties; wordmarkClass?: string }) {
  return (
    <Link className="logo" href="/" aria-label="Sway home" style={style} onClick={close}>
      <span className="logo-mk">
        <Logo size={size} />
      </span>
      <span className={wordmarkClass}>Sway</span>
    </Link>
  );
}
