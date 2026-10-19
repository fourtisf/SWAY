import { priceWei, quoteWei, unitsToKeys, weiToEth } from '@sway/curve';
import { ENGAGE_ROUTES, LAUNCH_ROUTES, ROUTES, SOCIAL_ROUTES, WALLET_ROUTES, makeFormat } from '@sway/shared';
import { describe, expect, it } from 'vitest';
import { ENGAGE_ROUTE_METHODS, LAUNCH_ROUTE_METHODS, ROUTE_METHODS, SOCIAL_ROUTE_METHODS, WALLET_ROUTE_METHODS, createHttpApi } from '../api';
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
    // [B] SOCIAL_ROUTES
    for (const key of Object.keys(SOCIAL_ROUTES) as Array<keyof typeof SOCIAL_ROUTES>) {
      const m = SOCIAL_ROUTE_METHODS[key];
      expect(typeof http[m], `http.${m}`).toBe('function');
      expect(typeof mock[m], `mock.${m}`).toBe('function');
    }
    // [A] WALLET_ROUTES
    for (const key of Object.keys(WALLET_ROUTES) as Array<keyof typeof WALLET_ROUTES>) {
      const m = WALLET_ROUTE_METHODS[key];
      expect(typeof http[m], `http.${m}`).toBe('function');
      expect(typeof mock[m], `mock.${m}`).toBe('function');
    }
    // [C] LAUNCH_ROUTES
    for (const key of Object.keys(LAUNCH_ROUTES) as Array<keyof typeof LAUNCH_ROUTES>) {
      const m = LAUNCH_ROUTE_METHODS[key];
      expect(typeof http[m], `http.${m}`).toBe('function');
      expect(typeof mock[m], `mock.${m}`).toBe('function');
    }
    // [D] ENGAGE_ROUTES
    for (const key of Object.keys(ENGAGE_ROUTES) as Array<keyof typeof ENGAGE_ROUTES>) {
      const m = ENGAGE_ROUTE_METHODS[key];
      expect(typeof http[m], `http.${m}`).toBe('function');
      expect(typeof mock[m], `mock.${m}`).toBe('function');
    }
  });
});

describe('[B] mock social routes', () => {
  it('blocks, hides, threads, deletes and boosts like the API', async () => {
    const api = getMockApi();
    const w = getWorld();
    await api.devLogin({ handle: 'admin_mock', followers: 1000 });
    expect((await api.me())?.isAdmin).toBe(true);
    const root = await api.createPost({ text: 'root', visibility: 'public' });
    const reply = await api.createPost({ text: 'reply', visibility: 'public', parentId: root.id });
    const nested = await api.createPost({ text: 'nested', visibility: 'public', parentId: reply.id });
    const t = await api.post(root.id);
    expect(t.replies.map((r) => r.text)).toEqual(['reply']);
    expect(t.nested.map((r) => r.text)).toEqual(['nested']);
    expect((await api.post(nested.id)).parents.map((p) => p.text)).toEqual(['root', 'reply']);
    expect((await api.feed({ tab: 'latest' })).posts.some((p) => p.id === reply.id)).toBe(false);

    await api.block('novareyes');
    expect((await api.feed({ tab: 'latest' })).posts.some((p) => p.author.handle === 'novareyes')).toBe(false);
    expect((await api.profile('novareyes')).blocked).toBe(true);
    await api.block('novareyes');

    const reports = await api.adminReports();
    expect(reports.length).toBeGreaterThan(0);
    await api.adminHidePost(root.id, { hidden: true });
    expect((await api.feed({ tab: 'latest' })).posts.find((p) => p.id === root.id)?.hidden).toBe(true);

    const q = await api.boostQuote();
    const hash = await mockWallet(w.user!.wallet).sendEth(q.treasury!, BigInt(q.wei));
    expect((await api.boostPost(root.id, { txHash: hash })).post.boosted).toBe(true);
    await expect(api.boostPost(root.id, { txHash: hash })).rejects.toMatchObject({ code: 'tx_used' });

    await api.deletePost(reply.id);
    expect((await api.post(root.id)).replies).toEqual([]);
    await expect(api.deleteAccount({ confirm: 'delete @someone' })).rejects.toMatchObject({ code: 'confirm_mismatch' });
    await api.deleteAccount({ confirm: 'delete @admin_mock' });
    expect(await api.me()).toBeNull();
  });
});
