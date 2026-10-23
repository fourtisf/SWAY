/**
 * Post text → plain text, @mentions, #tags and links. Links are http(s) URLs plus bare t.me / x.com / twitter.com /
 * swayfamily.com addresses; swayfamily.com links stay in the app (`path`), the rest open in a new tab (`href`).
 * Trailing punctuation isn't part of a link ("see t.me/swayfams." links t.me/swayfams).
 */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; handle: string }
  | { kind: 'tag'; text: string; tag: string }
  | { kind: 'link'; text: string; href: string; path: string | null };

const SITE_HOSTS = new Set(['swayfamily.com', 'www.swayfamily.com']);
const RE =
  /(https?:\/\/[^\s<>"]+)|\b((?:t\.me|x\.com|twitter\.com|swayfamily\.com)(?:\/[^\s<>"]*)?)|@([a-z0-9_]{1,30})|#(\w+)/gi;

function link(raw: string): Segment | null {
  const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const path = SITE_HOSTS.has(u.hostname.toLowerCase()) ? `${u.pathname}${u.search}${u.hash}` || '/' : null;
  return { kind: 'link', text: raw, href: u.toString(), path };
}

export function linkify(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  const push = (s: string) => {
    if (!s) return;
    const prev = out[out.length - 1];
    if (prev?.kind === 'text') prev.text += s;
    else out.push({ kind: 'text', text: s });
  };
  for (const m of text.matchAll(RE)) {
    const at = m.index ?? 0;
    push(text.slice(last, at));
    let tok = m[0];
    if (m[1] || m[2]) {
      // "(see t.me/x)." → the link stops before ")."; a ")" stays when the URL opened one.
      let trail = '';
      const opens = (x: string) => x.split('(').length - x.split(')').length;
      while (/[.,!?;:'")\]]$/.test(tok) && !(tok.endsWith(')') && opens(tok) >= 0)) {
        trail = tok.slice(-1) + trail;
        tok = tok.slice(0, -1);
      }
      const seg = link(tok);
      if (seg) out.push(seg);
      else push(tok);
      push(trail);
      last = at + m[0].length;
      continue;
    }
    if (m[3]) out.push({ kind: 'mention', text: tok, handle: m[3].toLowerCase() });
    else out.push({ kind: 'tag', text: tok, tag: m[4]! });
    last = at + tok.length;
  }
  push(text.slice(last));
  return out;
}
