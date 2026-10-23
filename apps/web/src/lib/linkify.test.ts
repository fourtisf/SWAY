import { describe, expect, it } from 'vitest';
import { linkify } from './linkify';

describe('linkify', () => {
  it('keeps mentions and tags', () => {
    expect(linkify('gm @Mira #SwayDaily')).toEqual([
      { kind: 'text', text: 'gm ' },
      { kind: 'mention', text: '@Mira', handle: 'mira' },
      { kind: 'text', text: ' ' },
      { kind: 'tag', text: '#SwayDaily', tag: 'SwayDaily' },
    ]);
  });

  it('links URLs and bare t.me / x.com addresses, without trailing punctuation', () => {
    const s = linkify('Join t.me/swayfams. Read https://example.org/a?b=1#c, then x.com/swaydotfamily!');
    expect(s.filter((x) => x.kind === 'link')).toEqual([
      { kind: 'link', text: 't.me/swayfams', href: 'https://t.me/swayfams', path: null },
      { kind: 'link', text: 'https://example.org/a?b=1#c', href: 'https://example.org/a?b=1#c', path: null },
      { kind: 'link', text: 'x.com/swaydotfamily', href: 'https://x.com/swaydotfamily', path: null },
    ]);
    expect(s.map((x) => x.text).join('')).toBe('Join t.me/swayfams. Read https://example.org/a?b=1#c, then x.com/swaydotfamily!');
  });

  it('keeps swayfamily.com links inside the app', () => {
    expect(linkify('see swayfamily.com/model and https://swayfamily.com/launchpad').filter((x) => x.kind === 'link')).toEqual([
      { kind: 'link', text: 'swayfamily.com/model', href: 'https://swayfamily.com/model', path: '/model' },
      { kind: 'link', text: 'https://swayfamily.com/launchpad', href: 'https://swayfamily.com/launchpad', path: '/launchpad' },
    ]);
    expect(linkify('swayfamily.com')[0]).toMatchObject({ kind: 'link', path: '/' });
  });

  it("doesn't treat # inside a URL as a tag, and only links http(s)", () => {
    expect(linkify('https://x.com/a#top').map((x) => x.kind)).toEqual(['link']);
    expect(linkify('javascript:alert(1) ftp://x.org').every((x) => x.kind === 'text')).toBe(true);
  });

  it('keeps a closing parenthesis that belongs to the URL', () => {
    expect(linkify('(https://en.wikipedia.org/wiki/Key_(cryptography))')[1]).toMatchObject({ text: 'https://en.wikipedia.org/wiki/Key_(cryptography)' });
  });
});
