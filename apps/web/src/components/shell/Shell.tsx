'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { setAuthRequiredHandler } from '@/lib/api';
import { MOCK } from '@/lib/env';
import { useLive } from '@/lib/live';
import { useNavHistory } from '@/lib/nav';
import { openModal, useUI } from '@/lib/store';
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

  // The API sends people back to /?onboard=1 after X sign-in.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('onboard') === '1') {
      openModal({ type: 'onboard' });
      sp.delete('onboard');
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
          <main id="main">{children}</main>
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
