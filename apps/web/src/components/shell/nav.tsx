'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useRef, useState } from 'react';
import { getApi } from '@/lib/api';
import { MOCK } from '@/lib/env';
import { socket } from '@/lib/ws';
import { invalidateAll, qk, useMe } from '@/lib/queries';
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
      {/* [B] settings for members, admin for admins */}
      {me && (
        <Link className={`nv ${v === 'settings' ? 'on' : ''}`} href="/settings" title="Settings" onClick={close} aria-current={v === 'settings' ? 'page' : undefined}>
          <Icon name="gear" />
          <span className="nl">Settings</span>
        </Link>
      )}
      {me?.isAdmin && (
        <Link className={`nv ${v === 'admin' ? 'on' : ''}`} href="/admin" title="Admin" onClick={close} aria-current={v === 'admin' ? 'page' : undefined}>
          <Icon name="shield" />
          <span className="nl">Admin</span>
        </Link>
      )}
    </>
  );
}

export function MeChip({ menuDown = false }: { menuDown?: boolean }) {
  const me = useMe().data;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);
  if (!me)
    return (
      <button className="btn btn-glass btn-block" style={{ height: 48, borderRadius: 14 }} onClick={() => openModal({ type: 'connect' })}>
        <Icon name="x" />
        <span className="nl me-t">Connect X</span>
      </button>
    );
  const u = me.user;
  return (
    <Link
      className="me-chip"
      ref={ref}
      href={`/${u.handle}`}
      style={{ position: 'relative' }}
      onClick={(e) => {
        // The icon-only sidebar hides the "···": there the avatar opens the account menu, like on X.
        if (!menuDown && window.matchMedia(COMPACT_SIDEBAR).matches) {
          e.preventDefault();
          setOpen(!open);
          return;
        }
        close();
      }}
    >
      <Avatar u={u} size={42} />
      <div className="me-t" style={{ minWidth: 0, flex: 1 }}>
        <div className="nm">
          <b>{u.name}</b>
          <VB v={u.verified} />
        </div>
        <div className="hd">@{u.handle}</div>
      </div>
      <span
        className="dots"
        role="button"
        aria-label="Account menu"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        ···
      </span>
      {open && <AccountMenu handle={u.handle} down={menuDown} onDone={() => setOpen(false)} />}
    </Link>
  );
}

/** Widths where the sidebar shows icons only (globals.css: max-width 1280px, above the 700px mobile layout). */
const COMPACT_SIDEBAR = '(min-width: 701px) and (max-width: 1280px)';

/** X-style account menu of the me-chip: your profile and Log out @handle. */
function AccountMenu({ handle, down, onDone }: { handle: string; down: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const logout = async () => {
    onDone();
    try {
      await getApi().logout();
    } catch {
      /* already signed out */
    }
    qc.setQueryData(qk.me, null);
    await invalidateAll(qc);
    if (!MOCK) socket.restart();
    router.push('/');
  };
  const item = (label: string, icon: IconName, fn: () => void) => (
    <span
      className="it"
      role="menuitem"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      }}
    >
      <Icon name={icon} size={18} />
      {label}
    </span>
  );
  return (
    <span className="sres me-menu" role="menu" style={down ? { top: 'calc(100% + 8px)' } : { top: 'auto', bottom: 'calc(100% + 8px)' }}>
      {item('Your profile', 'user', () => {
        onDone();
        close();
        router.push(`/${handle}`);
      })}
      {item(`Log out @${handle}`, 'logout', logout)}
    </span>
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
