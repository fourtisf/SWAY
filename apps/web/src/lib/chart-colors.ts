/** Canvas charts read the theme from CSS variables and redraw on THEME_EVENT (fired by lib/theme.ts). */
export const THEME_EVENT = 'sway:theme';

export function chartColors(el: Element) {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    label: v('--tx2', '#536471'),
    grid: v('--line', '#EFF3F4'),
    ink: v('--tx', '#0F1419'),
    ring: v('--bg', '#FFFFFF'),
    guide: dark ? 'rgba(231,233,234,.3)' : 'rgba(15,20,25,.3)',
  };
}
