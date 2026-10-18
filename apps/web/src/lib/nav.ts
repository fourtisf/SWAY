'use client';
/** In-app history for the Back button (prototype lastView / 'back' action). */
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useUI } from './store';

let goingBack = false;

export function useNavHistory() {
  const pathname = usePathname();
  useEffect(() => {
    const h = useUI.getState().history;
    if (goingBack) {
      goingBack = false;
      return;
    }
    if (h[h.length - 1] !== pathname) useUI.setState({ history: [...h, pathname].slice(-50) });
  }, [pathname]);
}

export function useGoBack() {
  const router = useRouter();
  return (fallback = '/') => {
    const h = useUI.getState().history;
    if (h.length >= 2) {
      const prev = h[h.length - 2]!;
      useUI.setState({ history: h.slice(0, -1) });
      goingBack = true;
      router.push(prev);
    } else router.push(fallback);
  };
}
