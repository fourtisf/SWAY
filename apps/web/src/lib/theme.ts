'use client';
/** Light / dark / system theme: `data-theme` on <html>, remembered per browser. */
import { useEffect, useState } from 'react';
import { THEME_EVENT } from './chart-colors';
import { THEME_KEY } from './theme-boot';

export type ThemePref = 'light' | 'dark' | 'system';

const read = (): ThemePref => {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'dark' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
};

function apply(p: ThemePref) {
  const dark = p === 'dark' || (p === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#000000' : '#FFFFFF');
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>('light');
  useEffect(() => {
    setPref(read());
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => read() === 'system' && apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return [
    pref,
    (p) => {
      try {
        localStorage.setItem(THEME_KEY, p);
      } catch {
        /* storage blocked: still switch for this visit */
      }
      setPref(p);
      apply(p);
    },
  ];
}
