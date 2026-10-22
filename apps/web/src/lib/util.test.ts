import { describe, expect, it } from 'vitest';
import { routeOf, samples, stepAmount } from './util';

describe('stepAmount (prototype tstep rules)', () => {
  it('steps by 0.1 below one key and by whole keys above', () => {
    expect(stepAmount(0.5, 1)).toBe(0.6);
    expect(stepAmount(0.95, 1)).toBe(1.05);
    expect(stepAmount(1, 1)).toBe(2);
    expect(stepAmount(2.4, 1)).toBe(3);
    expect(stepAmount(2.4, -1)).toBe(2);
    expect(stepAmount(1, -1)).toBe(0.9);
    expect(stepAmount(0.1, -1)).toBe(0.01);
    expect(stepAmount(0.01, -1)).toBe(0.01);
  });
});

describe('samples', () => {
  it('spaces points evenly and ends when the range is empty', () => {
    expect(samples(10, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
    // A member with no keys yet: the curve chart used to loop forever here (supply 0).
    expect(samples(0, 60)).toHaveLength(61);
    expect(samples(0, 60).every((s) => s === 0)).toBe(true);
  });
});

describe('routeOf', () => {
  it('treats unknown single segments as profiles', () => {
    expect(routeOf('/')).toEqual({ view: 'home', arg: null });
    expect(routeOf('/markets')).toEqual({ view: 'markets', arg: null });
    expect(routeOf('/messages/room-novareyes')).toEqual({ view: 'messages', arg: 'room-novareyes' });
    expect(routeOf('/NovaReyes')).toEqual({ view: 'profile', arg: 'novareyes' });
  });
});
