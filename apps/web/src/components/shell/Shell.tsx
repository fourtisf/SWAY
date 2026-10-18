'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { setAuthRequiredHandler } from '@/lib/api';
import { MOCK } from '@/lib/env';
import { useLive } from '@/lib/live';
import { useNavHistory } from '@/lib/nav';
import { useConfig } from '@/lib/queries';
import { saveRef } from '@/lib/referral';
import { openModal, toast, useUI } from '@/lib/store';
import { Toasts, ModalHost } from '../modals/Modals';
import { CenterHeader } from './CenterHeader';
import { Rail } from './Rail';
import { Drawer, Sidebar } from './Sidebar';
import { TabBar } from './TabBar';

/** The prototype's 3-column shell: sidebar, center column (header + page), rail; plus mobile chrome. */
export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const first = useRef(true);
  useLive();
  useNavHistory();
  const apiDown = useConfig().isError;

  useEffect(() => {
    setAuthRequiredHandler(() => openModal({ type: 'connect' }));
    return () => setAuthRequiredHandler(null);
  }, []);

  // Mock mode: let design-review scripts navigate client-side without losing in-memory state.
  useEffect(() => {
    if (MOCK) (window as unknown as { __router: typeof router }).__router = router;
  }, [router]);

  // Prototype go(): navigating closes the drawer, any open modal and the search dropdown.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const m = useUI.getState().modal;
    useUI.setState({ drawer: false, modal: m && (m.type === 'onboard' || m.type === 'card') ? m : null });
  }, [pathname]);

  // X sign-in comes back to <path>?onboard=1 (or ?auth_error=<code>); invites may carry ?ref=<handle>.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    let changed = false;
    if (sp.get('ref')) {
      saveRef(sp.get('ref')!);
      sp.delete('ref');
      changed = true;
    }
    if (sp.get('auth_error')) {
      toast('Couldn’t sign in with X. Please try again.');
      sp.delete('auth_error');
      changed = true;
    }
    if (sp.get('onboard') === '1') {
      openModal({ type: 'onboard' });
      sp.delete('onboard');
      changed = true;
    }
    if (changed) {
      const q = sp.toString();
      router.replace(window.location.pathname + (q ? `?${q}` : ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="app">
        <Sidebar />
        <div className="col">
          <div id="ch">
            <CenterHeader />
          </div>
          <main id="main">
            {apiDown && <div className="app-err">Can’t reach the Sway API right now. Retrying…</div>}
            {children}
          </main>
        </div>
        <Rail />
      </div>
      <TabBar />
      <Drawer />
      <ModalHost />
      <Toasts />
    </>
  );
}
