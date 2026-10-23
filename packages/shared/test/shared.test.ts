import { describe, expect, it } from 'vitest';
import { fanSubject, makeFormat, normalizeHandle, TASKS } from '../src';

describe('format (prototype F at ETH_USD = 3420)', () => {
  const F = makeFormat(3420);
  it('dollars from ETH', () => {
    expect(F.$(0.0001575)).toBe('$0.54');
    expect(F.$(0)).toBe('$0');
    expect(F.$(1)).toBe('$3,420');
    expect(F.$(10)).toBe('$34.2K');
    expect(F.$(1000)).toBe('$3.42M');
    expect(F.$(0.000001)).toBe('$0.003');
  });
  it('numbers', () => {
    expect(F.n(412000)).toBe('412K');
    expect(F.n(1500)).toBe('1.5K');
    expect(F.n(12_100_000)).toBe('12M');
    expect(F.n(2_400_000)).toBe('2.4M');
    expect(F.usd(1234)).toBe('$1.2K');
    // Cents below $10, so a small reach value doesn't show as $0.
    expect(F.usd(0.47)).toBe('$0.47');
    expect(F.usd(12.4)).toBe('$12');
    expect(F.usd(0)).toBe('$0');
    expect(F.pct(3.14)).toBe('+3.1%');
    expect(F.pct(-2)).toBe('-2.0%');
    expect(F.keys(1.005)).toBe('1');
    expect(F.ago(0.5)).toBe('now');
    expect(F.ago(90)).toBe('2h');
    expect(F.eth(0.0001575)).toBe('0.00016');
  });
});

describe('helpers', () => {
  it('normalizes handles', () => expect(normalizeHandle(' @Nova.Reyes! ')).toBe('novareyes'));
  it('fan subject is a checksummed address', () => {
    expect(fanSubject(44196397n)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(fanSubject(1n)).not.toBe(fanSubject(2n));
  });
  it('join checklist order', () => {
    expect(TASKS.filter((t) => t.group === 'Join checklist').map((t) => t.id)).toEqual(['follow', 'repost', 'tg', 'card']);
  });
});
