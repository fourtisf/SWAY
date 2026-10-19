/** Theme bootstrap, inlined in <head> by the root layout so the first paint already has the right theme. */
export const THEME_KEY = 'sway.theme';

export const THEME_BOOT = `(function(){try{var p=localStorage.getItem('${THEME_KEY}')||'light';var d=p==='dark'||(p==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';var m=document.querySelector('meta[name=theme-color]');if(m)m.setAttribute('content',d?'#000000':'#FFFFFF')}catch(e){}})()`;
