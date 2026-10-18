'use client';
import { useMe } from '@/lib/queries';
import { openModal, useUI } from '@/lib/store';
import { Icon } from '../icons';
import { LogoLink, MeChip, NavItems } from './nav';

export function compose(signedIn: boolean) {
  openModal(signedIn ? { type: 'compose' } : { type: 'connect' });
}

export function Sidebar() {
  const me = useMe().data;
  return (
    <aside className="sb" id="sb" aria-label="Main navigation">
      <LogoLink />
      <nav className="sb-nav">
        <NavItems />
      </nav>
      <div className="sb-post">
        <button className="btn btn-white btn-lg btn-block" aria-label="Post" onClick={() => compose(!!me)}>
          <Icon name="feather" />
          <span className="nl">Post</span>
        </button>
      </div>
      <MeChip />
    </aside>
  );
}

export function Drawer() {
  const open = useUI((s) => s.drawer);
  const close = () => useUI.setState({ drawer: false });
  return (
    <>
      <div className={`dw-ov ${open ? 'open' : ''}`} onClick={close} />
      <nav className={`drawer ${open ? 'open' : ''}`} id="drawer" aria-label="Menu">
        <div className="between" style={{ marginBottom: 10 }}>
          <LogoLink style={{ padding: '4px 8px' }} wordmarkClass="" />
          <button className="x-btn" aria-label="Close menu" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <div style={{ padding: '4px 6px 14px' }}>
          <MeChip menuDown />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <NavItems />
        </div>
      </nav>
    </>
  );
}
