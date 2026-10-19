import { describe, expect, it } from 'vitest';
import {
  allocateGenesis,
  battleOutcome,
  battleScore,
  genesisSharePercent,
  genesisWeight,
  inputsFromX,
  isqrt,
  rankGenesis,
  score,
  scorePoints,
  nextStreak,
  streakPoints,
  utcDay,
  settleBackings,
  settleStakes,
  tierOf,
  tierProgress,
  weeklyPrizes,
} from '../src';

describe('score()', () => {
  it('matches the prototype Open model default (41K followers, 2.2% ER, 10 ppw, 3 yrs, verified)', () => {
    const r = score({ followers: 41000, er: 0.022, ppw: 10, age: 3, verified: true });
    const reach = Math.log10(41001) / Math.log10(5e7);
    const eng = 1 - Math.exp(-0.022 * 40);
    const raw = 0.35 * reach + 0.35 * eng + 0.1 * (10 / 21) + 0.2 * (0.6 * 0.5 + 0.4);
    expect(r.raw).toBeCloseTo(raw, 12);
    expect(r.score).toBe(Math.round(raw * 100));
    expect(r.value).toBeCloseTo(0.42 * 41000 * Math.pow(raw, 1.6) * (0.6 + eng), 9);
    expect(r.score).toBe(60);
  });

  it('caps reach at 50M followers and never returns 0', () => {
    expect(score({ followers: 9e9, er: 0, ppw: 0, age: 0, verified: false }).parts.reach).toBe(1);
    expect(score({ followers: 0, er: 0, ppw: 0, age: 0, verified: false }).score).toBe(1);
  });

  it('builds inputs from X posts', () => {
    const now = new Date('2026-10-18T00:00:00Z');
    const day = 86400e3;
    const posts = [
      ...Array.from({ length: 14 }, (_, i) => ({ createdAt: new Date(now.getTime() - i * day), likes: 100, reposts: 10, replies: 5 })),
      { createdAt: new Date(now.getTime() - 3 * day), likes: 10, reposts: 0, replies: 0, isReply: true },
      { createdAt: new Date(now.getTime() - 2 * day), likes: 0, reposts: 0, replies: 0, isRepost: true },
    ];
    const inp = inputsFromX({ followers: 1000, createdAt: '2020-10-18T00:00:00Z', verified: true }, posts, now);
    expect(inp.er).toBeCloseTo((14 * 0.135 + 0.01) / 15, 12);
    expect(inp.ppw).toBeCloseTo(14 / (13 / 7), 9);
    expect(inp.age).toBeCloseTo(6, 1);
  });
});

describe('points and tiers', () => {
  it('score points cap at 10,000', () => {
    expect(scorePoints(67)).toBe(6700);
    expect(scorePoints(100)).toBe(10000);
  });
  it('tiers', () => {
    expect(tierOf(0).name).toBe('Murmur');
    expect(tierOf(49_999).name).toBe('Murmur');
    expect(tierOf(50_000).name).toBe('Voice');
    expect(tierOf(100_000).name).toBe('Echo');
    expect(tierOf(500_000).name).toBe('Chorus');
    expect(tierOf(2_000_000).name).toBe('Anthem');
    expect(tierProgress(75_000).progress).toBeCloseTo(0.5);
    expect(tierProgress(3_000_000).next).toBeNull();
  });
});

describe('genesis', () => {
  it('isqrt is exact', () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 40n, 10n ** 40n / 3n, 2n ** 200n + 12345n]) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
    expect(genesisWeight(1)).toBe(10n ** 20n);
    expect(genesisWeight(4)).toBe(5n * 10n ** 19n);
  });

  it('allocation sums to the pool exactly and is monotone by rank', () => {
    const pool = 50_000_000n * 10n ** 18n + 7n;
    const a = allocateGenesis(pool);
    expect(a).toHaveLength(500);
    expect(a.reduce((s, r) => s + r.units, 0n)).toBe(pool);
    for (let i = 1; i < a.length; i++) expect(a[i]!.units <= a[i - 1]!.units).toBe(true);
    const small = allocateGenesis(1001n, 10);
    expect(small.reduce((s, r) => s + r.units, 0n)).toBe(1001n);
  });

  it('rank 50 gets about 14% of rank 1', () => {
    expect(genesisSharePercent(50) / genesisSharePercent(1)).toBeCloseTo(0.1414, 3);
    let sum = 0;
    for (let r = 1; r <= 500; r++) sum += genesisSharePercent(r);
    expect(sum).toBeCloseTo(100, 9);
  });

  it('ranks only eligible members', () => {
    const base = { wallet: '0x1', tasksVerified: 1, botFlag: false, score: 50 };
    const ranked = rankGenesis(
      [
        { ...base, userId: 'a', points: 10, memberNo: 2 },
        { ...base, userId: 'b', points: 10, memberNo: 1 },
        { ...base, userId: 'c', points: 99, memberNo: 3, botFlag: true },
        { ...base, userId: 'd', points: 50, memberNo: 4, wallet: null },
        { ...base, userId: 'e', points: 5, memberNo: 5, tasksVerified: 0 },
      ],
      10,
    );
    expect(ranked.map((r) => r.userId)).toEqual(['b', 'a']);
  });
});

describe('battles', () => {
  it('engagement score formula', () => {
    expect(battleScore({ likes: 100, reposts: 10, replies: 5, quotes: 2, bookmarks: 3 }, 1000)).toBeCloseTo(
      (100 + 20 + 15 + 6 + 6) / 1000,
    );
  });
  it('outcomes', () => {
    expect(battleOutcome({ posted: false, score: 0 }, { posted: false, score: 0 })).toBe('draw');
    expect(battleOutcome({ posted: false, score: 0 }, { posted: true, score: 0 })).toBe('b');
    expect(battleOutcome({ posted: true, score: 0.02 }, { posted: true, score: 0.02 })).toBe('draw');
    expect(battleOutcome({ posted: true, score: 0.03 }, { posted: true, score: 0.02 })).toBe('a');
  });
  it('stakes: winner takes both minus 5%', () => {
    expect(settleStakes('a', 12000, 12000)).toEqual({ outcome: 'a', payoutA: 22800, payoutB: 0, treasury: 1200 });
    expect(settleStakes('draw', 500, 500)).toEqual({ outcome: 'draw', payoutA: 500, payoutB: 500, treasury: 0 });
  });
  it('backings split the losing pool pro rata', () => {
    const r = settleBackings('a', [
      { userId: 'w1', side: 'a', amount: 100 },
      { userId: 'w2', side: 'a', amount: 300 },
      { userId: 'l1', side: 'b', amount: 1000 },
    ]);
    const paid = Object.fromEntries(r.payouts.map((p) => [p.userId, p.payout]));
    expect(paid).toEqual({ w1: 100 + 237, w2: 300 + 712, l1: 0 });
    expect(r.treasury).toBe(50 + 1);
    const total = r.payouts.reduce((s, p) => s + p.payout, 0) + r.treasury;
    expect(total).toBe(1400);
  });
  it('weekly prizes 50/30/20 of half the treasury', () => {
    expect(weeklyPrizes(10_000, ['a', 'b', 'c', 'd'])).toEqual([
      { userId: 'a', prize: 2500 },
      { userId: 'b', prize: 1500 },
      { userId: 'c', prize: 1000 },
    ]);
  });
});

describe('daily streak', () => {
  it('pays n × 100 up to day 7', () => {
    expect([0, 1, 2, 7, 8, 30].map(streakPoints)).toEqual([0, 100, 200, 700, 700, 700]);
  });
  it('continues, holds or restarts by UTC day', () => {
    expect(nextStreak(null, 0, '2026-10-19')).toEqual({ days: 1, already: false });
    expect(nextStreak('2026-10-18', 4, '2026-10-19')).toEqual({ days: 5, already: false });
    expect(nextStreak('2026-10-19', 5, '2026-10-19')).toEqual({ days: 5, already: true });
    expect(nextStreak('2026-10-16', 9, '2026-10-19')).toEqual({ days: 1, already: false });
    expect(nextStreak('2026-02-28', 2, '2026-03-01')).toEqual({ days: 3, already: false });
    expect(utcDay(Date.parse('2026-10-19T23:59:59Z'))).toBe('2026-10-19');
  });
});
