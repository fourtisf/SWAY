import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { airdropLeaf, verifyMerkleProof, type DropPlanDTO, type NotificationPrefs, type ReferralsResponse, type StreakDTO, type WatchlistResponse } from '@sway/shared';
import { dec } from '@sway/db';
import { utcDayKey } from '@sway/scoring';
import { fakeHash, json, login, makeApp, member, openMarketRow, prisma, resetState, type TestCtx } from './helpers';

const DROPS = '0x0165878a594ca255338adfa4d48449f69242eb8f';
let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp({ env: { DROPS_ADDRESS: DROPS, VAPID_PUBLIC_KEY: 'BPub' + 'A'.repeat(83) } });
});
beforeEach(async () => {
  await resetState(ctx.redis);
  await prisma.creatorDrop.deleteMany();
});
afterAll(() => ctx.close());

const req = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, cookie?: string, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: cookie ? { cookie } : {}, payload: payload as never });

describe('watchlist', () => {
  it('watches a key from its current price, validates the threshold, unwatches', async () => {
    const me = await login(ctx, 'watcher');
    const ana = await member(ctx, 'ana');
    await openMarketRow(ana);
    await prisma.keyMarket.update({ where: { subject: ana.address }, data: { priceWei: dec(157_500_000_000_000n) } });

    expect((await req('PUT', '/api/users/ana/watch', me.cookie, { alertPct: 3 })).statusCode).toBe(400);
    expect((await req('PUT', '/api/users/watcher/watch', me.cookie, {})).statusCode).toBe(400);
    const w = await req('PUT', '/api/users/ana/watch', me.cookie, { alertPct: 15 });
    expect(w.statusCode).toBe(200);
    expect(json(w)).toMatchObject({ handle: 'ana', alertPct: 15, baselineWei: '157500000000000', change: 0 });

    await prisma.keyMarket.update({ where: { subject: ana.address }, data: { priceWei: dec(173_250_000_000_000n) } });
    const list = json<WatchlistResponse>(await req('GET', '/api/watchlist', me.cookie));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.change).toBe(10);

    expect(json(await req('DELETE', '/api/users/ana/watch', me.cookie))).toEqual({ watching: false });
    expect(json<WatchlistResponse>(await req('GET', '/api/watchlist', me.cookie)).items).toHaveLength(0);
    expect((await req('GET', '/api/watchlist')).statusCode).toBe(401);
  });
});

describe('daily streak', () => {
  it('pays once a day, grows on consecutive days and restarts after a gap', async () => {
    const me = await login(ctx, 'streaky');
    expect(json<StreakDTO>(await req('GET', '/api/streak', me.cookie))).toMatchObject({ days: 0, checkedInToday: false, nowPoints: 100, nextPoints: 200 });
    const first = json<StreakDTO & { awarded: number }>(await req('POST', '/api/streak/check-in', me.cookie));
    expect(first).toMatchObject({ days: 1, checkedInToday: true, awarded: 100, nowPoints: 0, nextPoints: 200 });
    expect(json(await req('POST', '/api/streak/check-in', me.cookie))).toMatchObject({ days: 1, awarded: 0 });

    const yesterday = utcDayKey(Date.now() - 86_400_000);
    await prisma.user.update({ where: { id: me.user.id }, data: { streakDays: 6, streakLastDay: yesterday } });
    await prisma.pointsLedger.deleteMany({ where: { userId: me.user.id, kind: 'streak' } });
    expect(json(await req('POST', '/api/streak/check-in', me.cookie))).toMatchObject({ days: 7, awarded: 700 });

    await prisma.user.update({ where: { id: me.user.id }, data: { streakDays: 9, streakLastDay: '2026-01-01' } });
    expect(json(await req('GET', '/api/streak', me.cookie))).toMatchObject({ days: 0, nowPoints: 100 });
    const rows = await prisma.pointsLedger.findMany({ where: { userId: me.user.id, kind: 'streak' } });
    expect(rows.map((r) => [r.ref, r.amount])).toEqual([[`streak:${utcDayKey()}`, 700]]);
  });
});

describe('notification prefs', () => {
  it('mutes a type in the list and the badge, rejects unknown keys', async () => {
    const me = await login(ctx, 'quiet');
    await prisma.notification.createMany({
      data: [
        { userId: me.user.id, type: 'trade', body: [{ t: 'a trade' }] },
        { userId: me.user.id, type: 'mention', body: [{ t: 'a mention' }] },
      ],
    });
    expect(json<NotificationPrefs>(await req('GET', '/api/me/notification-prefs', me.cookie)).trade).toBe(true);
    expect((await req('PUT', '/api/me/notification-prefs', me.cookie, { junk: true })).statusCode).toBe(400);
    const p = json<NotificationPrefs>(await req('PUT', '/api/me/notification-prefs', me.cookie, { trade: false }));
    expect(p).toMatchObject({ trade: false, mention: true, push: true });
    const list = json<Array<{ type: string }>>(await req('GET', '/api/notifications?tab=all', me.cookie));
    expect(list.map((n) => n.type)).toEqual(['mention']);
    expect(json<unknown[]>(await req('GET', '/api/notifications?tab=trades', me.cookie))).toHaveLength(0);
    expect(json<{ unreadNotifications: number }>(await req('GET', '/api/me', me.cookie)).unreadNotifications).toBe(1);
  });
});

describe('web push', () => {
  it('accepts browser push services only and moves a browser to its newest member', async () => {
    const a = await login(ctx, 'pusher');
    const b = await login(ctx, 'pusher2');
    const keys = { p256dh: 'B'.repeat(87), auth: 'c'.repeat(22) };
    expect(json(await req('GET', '/api/push', a.cookie))).toMatchObject({ enabled: true, subscriptions: 0 });
    expect((await req('POST', '/api/push/subscribe', a.cookie, { endpoint: 'https://evil.example/x', keys })).statusCode).toBe(400);
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
    expect((await req('POST', '/api/push/subscribe', a.cookie, { endpoint, keys })).statusCode).toBe(200);
    expect(json(await req('GET', '/api/push', a.cookie))).toMatchObject({ subscriptions: 1 });
    await req('POST', '/api/push/subscribe', b.cookie, { endpoint, keys });
    expect(await prisma.pushSubscription.count({ where: { userId: a.user.id } })).toBe(0);
    expect(await prisma.pushSubscription.count({ where: { userId: b.user.id } })).toBe(1);
    await req('POST', '/api/push/unsubscribe', b.cookie, { endpoint });
    expect(await prisma.pushSubscription.count()).toBe(0);
    expect((await req('POST', '/api/push/test', a.cookie)).statusCode).toBe(200);
    expect(await prisma.notification.count({ where: { userId: a.user.id, link: '/settings' } })).toBe(1);
  });
});

describe('creator drops', () => {
  it('builds a holder tree pro rata, excludes own wallets and bot flags, serves proofs until claimed', async () => {
    const creator = await member(ctx, 'dropper');
    const market = await openMarketRow(creator, 450n);
    const bob = await member(ctx, 'bobholder');
    const cat = await member(ctx, 'catholder');
    const bot = await member(ctx, 'botholder');
    await prisma.user.update({ where: { id: bot.user.id }, data: { botFlag: true } });
    await prisma.holding.createMany({
      data: [
        { marketId: market.id, address: creator.address, units: 100n },
        { marketId: market.id, address: bob.address, units: 200n },
        { marketId: market.id, address: cat.address, units: 100n },
        { marketId: market.id, address: bot.address, units: 50n },
      ],
    });
    expect((await req('POST', '/api/drops/plan', bob.cookie, { amountWei: '3000000000000000' })).statusCode).toBe(409);
    expect((await req('POST', '/api/drops/plan', creator.cookie, { amountWei: '5' })).statusCode).toBe(400);
    const res = await req('POST', '/api/drops/plan', creator.cookie, { amountWei: '3000000000000000' });
    expect(res.statusCode).toBe(200);
    const plan = json<DropPlanDTO>(res);
    expect(plan).toMatchObject({ holders: 2, totalWei: '3000000000000000', contract: DROPS });
    expect(plan.top.map((t) => [t.user?.handle, t.amountWei])).toEqual([
      ['bobholder', '2000000000000000'],
      ['catholder', '1000000000000000'],
    ]);
    // Same request, same tree: no duplicate plan.
    expect(json<DropPlanDTO>(await req('POST', '/api/drops/plan', creator.cookie, { amountWei: '3000000000000000' })).root).toBe(plan.root);
    expect(await prisma.dropPlan.count()).toBe(1);

    expect(json(await req('GET', '/api/drops/claimable', bob.cookie))).toEqual([]);
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    await prisma.creatorDrop.create({
      data: { id: 0, creator: creator.address, root: plan.root, totalWei: dec(3_000_000_000_000_000n), expiresAt, txHash: fakeHash(), blockNumber: 5n, createdAt: new Date() },
    });
    const mine = json<Array<{ amountWei: string; proof: `0x${string}`[]; address: string; creator: { handle: string } }>>(await req('GET', '/api/drops/claimable', bob.cookie));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ amountWei: '2000000000000000', address: bob.address, creator: { handle: 'dropper' } });
    expect(verifyMerkleProof(plan.root, airdropLeaf(bob.address, 2_000_000_000_000_000n), mine[0]!.proof)).toBe(true);
    expect(json(await req('GET', '/api/drops/claimable', bot.cookie))).toEqual([]);
    expect((await req('POST', '/api/drops/plan', creator.cookie, { amountWei: '3000000000000000' })).statusCode).toBe(409);

    await prisma.dropAllocation.update({ where: { root_address: { root: plan.root, address: bob.address } }, data: { claimTx: fakeHash(), claimBlock: 6n } });
    expect(json(await req('GET', '/api/drops/claimable', bob.cookie))).toEqual([]);
    const listed = json<Array<{ id: number; holders: number; claims: number; canReclaim: boolean }>>(await req('GET', '/api/users/dropper/drops', creator.cookie));
    expect(listed).toEqual([expect.objectContaining({ id: 0, holders: 2, claims: 1, canReclaim: false })]);
  });
});

describe('referral dashboard', () => {
  it('lists invitees with status and volume and estimates referral fees', async () => {
    const inviter = await member(ctx, 'inviter');
    const inv = await login(ctx, 'invitee1', 5000, 'inviter');
    const r = await prisma.referral.findUniqueOrThrow({ where: { inviteeId: inv.user.id } });
    const invAddr = '0x00000000000000000000000000000000000000aa';
    await prisma.wallet.create({ data: { userId: inv.user.id, address: invAddr, kind: 'external' } });
    const creditedAt = new Date(Date.now() - 3_600_000);
    await prisma.referral.update({ where: { id: r.id }, data: { status: 'credited', creditedAt, onchainTx: fakeHash() } });
    const other = await member(ctx, 'someone');
    const mk = await openMarketRow(other, 1_000n);
    const trade = (ts: Date, fee: bigint, i: number) => ({
      txHash: fakeHash(), logIndex: i, blockNumber: 1n, blockHash: '0x1', marketId: mk.id, trader: invAddr, isBuy: true, units: 100n,
      baseWei: dec(fee * 100n), creatorFeeWei: dec(0), protocolFeeWei: dec(0), holderFeeWei: dec(0), referralFeeWei: dec(fee), totalWei: dec(fee * 100n), supplyAfter: 1_100n, ts,
    });
    await prisma.trade.createMany({ data: [trade(new Date(creditedAt.getTime() - 60_000), 1_000n, 0), trade(new Date(), 2_001n, 1)] });
    ctx.chain.claim = { creator: 0n, holder: 0n, referral: 777n, protocol: 0n };
    const d = json<ReferralsResponse>(await req('GET', '/api/referrals', inviter.cookie));
    expect(d).toMatchObject({ link: 'http://localhost:3000/i/inviter', invited: 1, credited: 1, pending: 0, referralPendingWei: '777', referralEarnedWei: '1000' });
    expect(d.rows).toEqual([expect.objectContaining({ handle: 'invitee1', status: 'credited', volumeWei: String(300_100n) })]);
    ctx.chain.claim = { creator: 0n, holder: 0n, referral: 0n, protocol: 0n };
  });
});

describe('profile: activity bond and anti-dump window', () => {
  it('reports creatorInactive and the viewer\'s last buy per wallet', async () => {
    const creator = await member(ctx, 'quietcreator');
    const market = await openMarketRow(creator, 300n);
    const fan = await member(ctx, 'fanbuyer');
    const t = (ts: Date, isBuy: boolean, i: number) => ({
      txHash: fakeHash(), logIndex: i, blockNumber: 1n, blockHash: '0x1', marketId: market.id, trader: fan.address, isBuy, units: 100n,
      baseWei: dec(1n), creatorFeeWei: dec(0), protocolFeeWei: dec(0), holderFeeWei: dec(0), referralFeeWei: dec(0), totalWei: dec(1n), supplyAfter: 300n, ts,
    });
    const lastBuy = new Date(Date.now() - 3_600_000);
    await prisma.trade.createMany({ data: [t(new Date(Date.now() - 86_400_000 * 3), true, 0), t(lastBuy, true, 1), t(new Date(), false, 2)] });
    await prisma.keyMarket.update({ where: { id: market.id }, data: { creatorInactive: true } });
    const p = json(await req('GET', '/api/users/quietcreator', fan.cookie));
    expect(p.creatorInactive).toBe(true);
    expect(p.lastBuyAt).toEqual({ [fan.address]: lastBuy.toISOString() });
    expect(json(await req('GET', '/api/users/quietcreator')).lastBuyAt).toEqual({});
  });
});
