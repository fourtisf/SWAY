import { priceWei, quoteWei, unitsToKeys, weiToEth } from '@sway/curve';
import { ROUTES, makeFormat } from '@sway/shared';
import { describe, expect, it } from 'vitest';
import { ROUTE_METHODS, createHttpApi } from '../api';
import { mockWallet } from '../wallet/mock';
import { getMockApi, getWorld } from './index';

const F = makeFormat(3420);

describe('mock seed matches the prototype', () => {
  it('reproduces the prototype numbers', async () => {
    const api = getMockApi();
    const nova = await api.profile('novareyes');
    expect(unitsToKeys(nova.supplyUnits)).toBe(6.72);
    expect(F.$(weiToEth(nova.priceWei))).toBe('$4.55');
    expect(nova.holders).toBe(4);
    expect(F.$(weiToEth(nova.volumeWei))).toBe('$45.56');
    const mako = await api.profile('makotrades');
    expect(F.$(weiToEth(mako.priceWei))).toBe('$53.51');
    const orbit = await api.profile('orbitlabs');
    expect(orbit.claimed).toBe(false);
    expect(F.$(weiToEth(orbit.escrowWei))).toBe('$3.23');
    const lb = await api.leaderboard({ tab: 'points' });
    expect(lb.rows.slice(0, 2).map((r) => [r.user.handle, r.points])).toEqual([
      ['solka', 3472334],
      ['fenri69.eth', 2084079],
    ]);
  });
});

describe('mock trades', () => {
  it('charges exactly the wei quote and moves supply, holdings and the room', async () => {
    const api = getMockApi();
    const w = getWorld();
    const me = await api.devLogin({ handle: 'tester', followers: 1000 });
    expect(me.user.handle).toBe('tester');
    expect((await api.room('novareyes')).access).toBe('locked');
    const before = await api.wallet();
    const p = await api.profile('novareyes');
    const q = quoteWei(BigInt(p.supplyUnits), 'buy', 100n, { level: me.stakingLevel });
    const wallet = mockWallet(me.wallet!.address);
    await wallet.waitForReceipt(await wallet.buy(p.subject, 100n, q.total + q.total / 100n));
    const after = await api.wallet();
    // The mock keeps balances as ETH floats like the prototype: equal to the quote within float precision.
    const paid = BigInt(before.cashWei) - BigInt(after.cashWei);
    expect(paid > q.total ? paid - q.total : q.total - paid).toBeLessThan(10_000n);
    const p2 = await api.profile('novareyes');
    expect(p2.supplyUnits).toBe((BigInt(p.supplyUnits) + 100n).toString());
    expect(p2.priceWei).toBe(priceWei(BigInt(p2.supplyUnits)).toString());
    expect(p2.heldUnits).toBe('100');
    expect((await api.room('novareyes')).access).toBe('open');
    expect(after.activity[0]?.label).toBe('Bought 1 key of Nova Reyes');
    // Sell it back: the room closes again.
    await wallet.sell(p.subject, 100n, 0n);
    expect((await api.room('novareyes')).access).toBe('locked');
    // Own market: the first key is locked.
    expect(() => w.execTrade('tester', 'sell', 100n)).toThrow();
  });
});

describe('client coverage', () => {
  it('has a method for every ROUTES entry, in both adapters', () => {
    const http = createHttpApi() as unknown as Record<string, unknown>;
    const mock = getMockApi() as unknown as Record<string, unknown>;
    for (const key of Object.keys(ROUTES) as Array<keyof typeof ROUTES>) {
      const m = ROUTE_METHODS[key];
      expect(typeof http[m], `http.${m}`).toBe('function');
      expect(typeof mock[m], `mock.${m}`).toBe('function');
    }
  });
});
