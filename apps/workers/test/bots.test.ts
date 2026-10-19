import { describe, expect, it } from 'vitest';
import { botHeuristic } from '../src/jobs/bots';

const now = new Date('2026-10-19T00:00:00Z');
const day = 86400e3;
const base = { xId: '12345', followers: 500, verified: false, official: false, xCreatedAt: new Date(now.getTime() - 400 * day), scoreInputs: { er: 0.02, ppw: 5 } };

describe('bot heuristics', () => {
  it('leaves normal, verified, official and dev accounts alone', () => {
    expect(botHeuristic(base, now)).toBeNull();
    expect(botHeuristic({ ...base, followers: 3, xCreatedAt: new Date(now.getTime() - 2 * day), verified: true }, now)).toBeNull();
    expect(botHeuristic({ ...base, followers: 3, official: true, scoreInputs: {} }, now)).toBeNull();
    expect(botHeuristic({ ...base, xId: '9000000000000000123', followers: 0, scoreInputs: {} }, now)).toBeNull();
  });
  it('flags brand-new accounts with no audience', () => {
    expect(botHeuristic({ ...base, followers: 12, xCreatedAt: new Date(now.getTime() - 5 * day) }, now)).toBe('new_account_no_audience');
    expect(botHeuristic({ ...base, followers: 25, xCreatedAt: new Date(now.getTime() - 5 * day) }, now)).toBeNull();
  });
  it('flags empty accounts that never post', () => {
    expect(botHeuristic({ ...base, followers: 4, scoreInputs: { er: 0, ppw: 0 } }, now)).toBe('inactive_empty_account');
    expect(botHeuristic({ ...base, followers: 4, scoreInputs: { er: 0, ppw: 2 } }, now)).toBeNull();
  });
});
