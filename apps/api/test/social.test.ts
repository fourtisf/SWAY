import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { priceWei, quoteWei, usdToWei } from '@sway/curve';
import type {
  DmResponse,
  HolderDTO,
  MarketsResponse,
  MessageDTO,
  MessagesResponse,
  NotificationDTO,
  ProfileDTO,
  RoomResponse,
  SearchResponse,
  ThreadDTO,
  TradeDTO,
  ExploreResponse,
  MeDTO,
} from '@sway/shared';
import { accessKey } from '../src/services/access';
import { notify } from '../src/services/notify';
import {
  fakeHash,
  fanMarket,
  login,
  makeApp,
  member,
  openMarketRow,
  prisma,
  resetState,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
beforeEach(async () => {
  await resetState(ctx.redis);
  ctx.chain.keys.clear();
});
afterAll(() => ctx.close());

const get = (url: string, cookie?: string) => ctx.app.inject({ url, headers: cookie ? { cookie } : {} });
const postJ = (url: string, cookie: string | undefined, payload?: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: cookie ? { cookie } : {},
    payload: payload as Record<string, unknown>,
  });

async function trade(
  marketId: string,
  trader: string,
  isBuy: boolean,
  units: bigint,
  supplyAfter: bigint,
  minsAgo = 1,
) {
  return prisma.trade.create({
    data: {
      txHash: fakeHash(),
      logIndex: 0,
      blockNumber: 1n,
      blockHash: '0x1',
      marketId,
      trader,
      isBuy,
      units,
      baseWei: '1000',
      creatorFeeWei: '60',
      protocolFeeWei: '20',
      holderFeeWei: '10',
      referralFeeWei: '10',
      totalWei: '1100',
      supplyAfter,
      ts: new Date(Date.now() - minsAgo * 60000),
    },
  });
}

describe('follow', () => {
  it('toggles and shows on the profile', async () => {
    const a = await login(ctx, 'followera');
    await login(ctx, 'followeeb');
    expect((await postJ('/api/users/followeeb/follow', a.cookie)).json()).toEqual({ following: true });
    expect((await get('/api/users/followeeb', a.cookie)).json<ProfileDTO>().following).toBe(true);
    expect((await postJ('/api/users/followeeb/follow', a.cookie)).json()).toEqual({ following: false });
    expect((await postJ('/api/users/followera/follow', a.cookie)).statusCode).toBe(400);
    expect((await postJ('/api/users/ghost/follow', a.cookie)).statusCode).toBe(404);
  });
});

describe('rooms', () => {
  it('owner and holders open the room; others are locked; unclaimed fan markets say so', async () => {
    const owner = await member(ctx, 'roomowner');
    const m = await openMarketRow(owner, 300n);
    const fan = await member(ctx, 'roomfan');
    await prisma.holding.create({ data: { marketId: m.id, address: fan.address, units: 100n } });

    const guest = (await get('/api/users/roomowner/room')).json<RoomResponse>();
    expect(guest).toEqual({
      access: 'locked',
      messages: [],
      oneKeyTotalWei: quoteWei(300n, 'buy', 100n).total.toString(),
    });

    const ownerPost = await postJ('/api/users/roomowner/room', owner.cookie, { text: 'welcome holders' });
    expect(ownerPost.statusCode).toBe(200);
    expect(ownerPost.json<MessageDTO>()).toMatchObject({
      text: 'welcome holders',
      mine: true,
      from: { handle: 'roomowner' },
    });

    const denied = await postJ('/api/users/roomowner/room', fan.cookie, { text: 'let me in' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('locked');
    expect((await get('/api/users/roomowner/room', fan.cookie)).json<RoomResponse>()).toMatchObject({
      access: 'locked',
      messages: [],
    });

    ctx.chain.setKeys(owner.address, fan.address, 100n);
    await ctx.redis.del(accessKey(owner.address, fan.address));
    const open = (await get('/api/users/roomowner/room', fan.cookie)).json<RoomResponse>();
    expect(open.access).toBe('open');
    expect(open.messages.map((x) => [x.text, x.mine])).toEqual([['welcome holders', false]]);
    expect((await postJ('/api/users/roomowner/room', fan.cookie, { text: 'gm' })).statusCode).toBe(200);

    // Selling the last key closes access once the 60s cache turns over.
    ctx.chain.setKeys(owner.address, fan.address, 0n);
    await ctx.redis.del(accessKey(owner.address, fan.address));
    expect((await get('/api/users/roomowner/room', fan.cookie)).json<RoomResponse>().access).toBe('locked');

    await fanMarket('fcmeridian', '5550001', 'football');
    expect((await get('/api/users/fcmeridian/room', fan.cookie)).json<RoomResponse>().access).toBe(
      'unclaimed',
    );
    expect((await postJ('/api/users/fcmeridian/room', fan.cookie, { text: 'hi' })).statusCode).toBe(403);
  });

  it('lists rooms (own + held ≥ 1 key) with unread state in Messages', async () => {
    const owner = await member(ctx, 'roomlist');
    const m = await openMarketRow(owner);
    const fan = await member(ctx, 'roomlistfan');
    await openMarketRow(fan);
    await prisma.holding.create({ data: { marketId: m.id, address: fan.address, units: 150n } });
    await postJ('/api/users/roomlist/room', owner.cookie, { text: 'alpha drop' });
    const msgs = (await get('/api/messages', fan.cookie)).json<MessagesResponse>();
    expect(msgs.rooms.map((r) => [r.id, r.kind, r.unread, r.last])).toEqual([
      ['roomlistfan', 'room', false, null],
      ['roomlist', 'room', true, 'alpha drop'],
    ]);
    expect((await get('/api/me', fan.cookie)).json<MeDTO>().unreadMessages).toBe(1);
    ctx.chain.setKeys(owner.address, fan.address, 150n);
    await get('/api/users/roomlist/room', fan.cookie);
    expect(
      (await get('/api/messages', fan.cookie))
        .json<MessagesResponse>()
        .rooms.find((r) => r.id === 'roomlist')!.unread,
    ).toBe(false);
  });
});

describe('direct messages', () => {
  it('opens a thread, sends, tracks unread and marks read', async () => {
    const a = await login(ctx, 'dma');
    const b = await login(ctx, 'dmb');
    const t = (await postJ('/api/messages/dm', a.cookie, { handle: '@DMB' })).json<ThreadDTO>();
    expect(t).toMatchObject({ kind: 'dm', with: { handle: 'dmb' }, last: null, unread: false });
    const again = (await postJ('/api/messages/dm', b.cookie, { handle: 'dma' })).json<ThreadDTO>();
    expect(again.id).toBe(t.id);

    const sent = (
      await postJ(`/api/messages/dm/${t.id}`, a.cookie, { text: 'hey! want early access?' })
    ).json<MessageDTO>();
    expect(sent).toMatchObject({ mine: true, text: 'hey! want early access?' });
    expect((await get('/api/messages', a.cookie)).json<MessagesResponse>().dms[0]).toMatchObject({
      unread: false,
      last: 'hey! want early access?',
    });
    expect((await get('/api/messages', b.cookie)).json<MessagesResponse>().dms[0]).toMatchObject({
      unread: true,
      with: { handle: 'dma' },
    });
    expect((await get('/api/me', b.cookie)).json<MeDTO>().unreadMessages).toBe(1);

    const read = (await get(`/api/messages/dm/${t.id}`, b.cookie)).json<DmResponse>();
    expect(read.messages.map((m) => [m.text, m.mine])).toEqual([['hey! want early access?', false]]);
    expect(read.thread.unread).toBe(false);
    expect((await get('/api/messages', b.cookie)).json<MessagesResponse>().dms[0]!.unread).toBe(false);

    const c = await login(ctx, 'dmc');
    expect((await get(`/api/messages/dm/${t.id}`, c.cookie)).statusCode).toBe(404);
    expect((await postJ(`/api/messages/dm/${t.id}`, c.cookie, { text: 'intrude' })).statusCode).toBe(404);
    expect((await postJ('/api/messages/dm', a.cookie, { handle: 'dma' })).statusCode).toBe(400);
    expect((await postJ('/api/messages/dm', a.cookie, { handle: 'nobody' })).statusCode).toBe(404);
  });
});

describe('notifications', () => {
  it('lists by tab, reads one and all; unread count is in MeDTO', async () => {
    const { cookie, user } = await login(ctx, 'notified');
    for (const type of ['trade', 'mention', 'battle', 'points'] as const) {
      await notify(prisma, ctx.redis, { userId: user.id, type, body: [{ t: type, b: true }], link: '/x' });
    }
    expect((await get('/api/me', cookie)).json<MeDTO>().unreadNotifications).toBe(4);
    expect((await get('/api/notifications?tab=all', cookie)).json<NotificationDTO[]>()).toHaveLength(4);
    expect(
      (await get('/api/notifications?tab=trades', cookie)).json<NotificationDTO[]>().map((n) => n.type),
    ).toEqual(['trade']);
    const mentions = (await get('/api/notifications?tab=mentions', cookie)).json<NotificationDTO[]>();
    expect(mentions.map((n) => n.type).sort()).toEqual(['battle', 'mention']);
    expect(mentions[0]!.body[0]).toEqual({ t: mentions[0]!.type, b: true });
    const one = await postJ(`/api/notifications/${mentions[0]!.id}/read`, cookie);
    expect(one.json()).toEqual({ ok: true, unread: 3 });
    expect((await postJ('/api/notifications/read-all', cookie)).json()).toEqual({ ok: true, unread: 0 });
    expect((await get('/api/notifications', cookie)).json<NotificationDTO[]>().every((n) => n.read)).toBe(
      true,
    );
    expect((await get('/api/notifications')).json()).toEqual([]);
  });
});

describe('profiles, markets, explore, search', () => {
  it('builds ProfileDTO / MarketDTO from KeyMarket + User + trades', async () => {
    const owner = await member(ctx, 'atlas_rsch');
    const m = await openMarketRow(owner, 100n);
    const fan = await member(ctx, 'buyer');
    await trade(m.id, fan.address, true, 200n, 300n, 10);
    await trade(m.id, fan.address, true, 100n, 400n, 5);
    await trade(m.id, fan.address, false, 50n, 350n, 1);
    await prisma.keyMarket.update({
      where: { id: m.id },
      data: { supplyUnits: 350n, holders: 2, volumeWei: '123456789' },
    });
    await prisma.holding.createMany({
      data: [
        { marketId: m.id, address: owner.address, units: 100n },
        { marketId: m.id, address: fan.address, units: 250n },
      ],
    });

    const p = (await get('/api/users/atlas_rsch', fan.cookie)).json<ProfileDTO>();
    expect(p).toMatchObject({
      handle: 'atlas_rsch',
      subject: owner.address,
      claimed: true,
      supplyUnits: '350',
      priceWei: priceWei(350n).toString(),
      holders: 2,
      volumeWei: '123456789',
      ownerAddress: owner.address,
      isMe: false,
      heldUnits: '250',
      memberNo: owner.user.memberNo,
    });
    const p100 = Number(priceWei(100n)) / 1e18;
    const p350 = Number(priceWei(350n)) / 1e18;
    expect(p.spark).toHaveLength(4);
    expect(p.spark[0]).toBeCloseTo(p100, 15);
    expect(p.spark[3]).toBeCloseTo(p350, 15);
    expect(p.change).toBeCloseTo((p350 / p100 - 1) * 100, 1);
    expect(p.history.map((h) => h.priceWei)).toEqual(
      [priceWei(100n), priceWei(300n), priceWei(400n), priceWei(350n)].map(String),
    );

    const holders = (await get('/api/users/atlas_rsch/holders', fan.cookie)).json<HolderDTO[]>();
    expect(holders.map((h) => [h.handle, h.units, h.you])).toEqual([
      ['buyer', '250', true],
      ['atlas_rsch', '100', false],
    ]);
    const trades = (await get('/api/users/atlas_rsch/trades')).json<TradeDTO[]>();
    expect(trades.map((t) => [t.isBuy, t.units, t.trader.handle, t.market.handle])).toEqual([
      [false, '50', 'buyer', 'atlas_rsch'],
      [true, '100', 'buyer', 'atlas_rsch'],
      [true, '200', 'buyer', 'atlas_rsch'],
    ]);
    expect((await get('/api/trades?limit=2')).json<TradeDTO[]>()).toHaveLength(2);

    // A market with no trades has a flat spark.
    const quiet = await member(ctx, 'quiet');
    await openMarketRow(quiet);
    const q = (await get('/api/users/quiet')).json<ProfileDTO>();
    expect(new Set(q.spark).size).toBe(1);
    expect(q.change).toBe(0);
  });

  it('markets by category with stats, fan markets unclaimed; explore sorts; search finds members and tags', async () => {
    const a = await member(ctx, 'alpha');
    const b = await member(ctx, 'bravo');
    const ma = await openMarketRow(a, 200n);
    const mb = await openMarketRow(b, 900n);
    await prisma.keyMarket.update({ where: { id: ma.id }, data: { volumeWei: '500', holders: 3 } });
    await prisma.keyMarket.update({ where: { id: mb.id }, data: { volumeWei: '100', holders: 4 } });
    await prisma.user.update({ where: { id: a.user.id }, data: { score: 80 } });
    await prisma.user.update({ where: { id: b.user.id }, data: { score: 20 } });
    await trade(ma.id, b.address, true, 100n, 200n);
    await fanMarket('orbitlabs', '8880001', 'crypto');

    const creators = (await get('/api/markets?tab=creators')).json<MarketsResponse>();
    expect(creators.stats).toEqual({ markets: 2, volumeWei: '600', holders: 7 });
    expect(creators.markets.map((x) => x.handle)).toEqual(['alpha', 'bravo']);
    const crypto = (await get('/api/markets?tab=crypto')).json<MarketsResponse>();
    expect(crypto.markets.map((x) => [x.handle, x.claimed, x.category])).toEqual([
      ['orbitlabs', false, 'crypto'],
    ]);
    expect(crypto.markets[0]!.subject).toMatch(/^0x[0-9a-f]{40}$/);

    const ex = async (q: string) =>
      (await get(`/api/explore?${q}`)).json<ExploreResponse>().creators.map((x) => x.handle);
    expect(await ex('tab=creators&sort=price')).toEqual(['bravo', 'alpha']);
    expect(await ex('tab=creators&sort=score')).toEqual(['alpha', 'bravo']);
    expect(await ex('tab=creators&sort=volume')).toEqual(['alpha', 'bravo']);
    expect(await ex('tab=creators&sort=trending')).toEqual(['alpha', 'bravo']);
    expect(await ex('tab=new')).toEqual(['bravo', 'alpha']);
    expect(await ex('tab=creators&q=brav')).toEqual(['bravo']);

    const s = (await get('/api/search?q=orbit')).json<SearchResponse>();
    expect(s.members.map((x) => [x.handle, x.claimed])).toEqual([['orbitlabs', false]]);
    const t = (await get('/api/search?q=%23genesis')).json<SearchResponse>();
    expect(t.members).toEqual([]);
    expect(t.tags.map((x) => x.tag)).toEqual(['Genesis']);
  });
});

describe('subscribe, tip, claim requests', () => {
  it('verifies the payment tx (amount at the current price, sender, recipient) and logs activity', async () => {
    const creator = await member(ctx, 'vexcapital');
    await openMarketRow(creator);
    const fan = await member(ctx, 'subscriber');
    const four = usdToWei(4, 3420);
    const under = ctx.chain.addTx({
      from: fan.address,
      to: creator.address,
      value: (four * 90n) / 100n,
      status: 'success',
    });
    const wrongTo = ctx.chain.addTx({ from: fan.address, to: fan.address, value: four, status: 'success' });
    const notMine = ctx.chain.addTx({
      from: creator.address,
      to: creator.address,
      value: four,
      status: 'success',
    });
    const good = ctx.chain.addTx({
      from: fan.address,
      to: creator.address,
      value: (four * 99n) / 100n,
      status: 'success',
    });
    const sub = (txHash: string) => postJ('/api/users/vexcapital/subscribe', fan.cookie, { txHash });
    expect((await sub(under)).json().error).toBe('underpaid');
    expect((await sub(wrongTo)).json().error).toBe('wrong_recipient');
    expect((await sub(notMine)).json().error).toBe('tx_not_yours');
    expect((await sub(good)).json()).toEqual({ ok: true });
    expect((await sub(good)).json().error).toBe('tx_used');
    const s = await prisma.subscription.findFirstOrThrow({ where: { subscriberId: fan.user.id } });
    expect(Math.round((s.expiresAt.getTime() - Date.now()) / 86400e3)).toBe(30);
    expect((await get('/api/users/vexcapital', fan.cookie)).json<ProfileDTO>().subscribed).toBe(true);

    const tipTx = ctx.chain.addTx({
      from: fan.address,
      to: creator.address,
      value: usdToWei(5, 3420),
      status: 'success',
    });
    expect((await postJ('/api/users/vexcapital/tip', fan.cookie, { txHash: tipTx })).json()).toEqual({
      ok: true,
    });
    const acts = await prisma.activity.findMany({ orderBy: { createdAt: 'asc' } });
    expect(acts.map((a) => a.label).sort()).toEqual([
      'Subscribed to Vexcapital',
      'Subscription from Subscriber',
      'Tip from Subscriber',
      'Tipped Vexcapital',
    ]);
    expect(acts.find((a) => a.label === 'Tipped Vexcapital')!.amountWei.isNegative()).toBe(true);
  });

  it('records claim and takedown requests for a market', async () => {
    const { cookie } = await login(ctx, 'requester');
    const { market } = await fanMarket('cindernet', '9990001');
    expect(
      (
        await postJ('/api/users/cindernet/claim-request', cookie, {
          kind: 'takedown',
          contact: 'legal@cinder.example',
          note: 'not us',
        })
      ).json(),
    ).toEqual({ ok: true });
    expect(await prisma.claimRequest.findFirst({ where: { marketId: market.id } })).toMatchObject({
      kind: 'takedown',
      status: 'open',
    });
    expect(
      (await postJ('/api/users/cindernet/claim-request', cookie, { kind: 'other', contact: 'x' })).statusCode,
    ).toBe(400);
    expect(
      (await postJ('/api/users/cindernet/claim-request', undefined, { kind: 'claim', contact: 'a@b.c' }))
        .statusCode,
    ).toBe(401);
  });
});
