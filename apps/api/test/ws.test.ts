import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { BUS_CHANNEL, type ThreadDTO, type WsServerMessage } from '@sway/shared';
import { notify } from '../src/services/notify';
import { fakeHash, login, makeApp, member, openMarketRow, prisma, resetState, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
beforeEach(() => resetState(ctx.redis));
afterAll(() => ctx.close());

interface Probe {
  ws: WebSocket;
  got: WsServerMessage[];
  waitFor(pred: (m: WsServerMessage) => boolean, ms?: number): Promise<WsServerMessage>;
  none(pred: (m: WsServerMessage) => boolean, ms?: number): Promise<void>;
  send(m: unknown): void;
}

async function connect(cookie?: string): Promise<Probe> {
  const ws = await ctx.app.injectWS('/ws', cookie ? { headers: { cookie } } : {});
  const got: WsServerMessage[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  const waitFor = (pred: (m: WsServerMessage) => boolean, ms = 3000) =>
    new Promise<WsServerMessage>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const hit = got.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) return reject(new Error(`timeout; got ${JSON.stringify(got)}`));
        setTimeout(tick, 20);
      };
      tick();
    });
  const none = async (pred: (m: WsServerMessage) => boolean, ms = 400) => {
    await new Promise((r) => setTimeout(r, ms));
    expect(got.filter(pred)).toEqual([]);
  };
  return { ws, got, waitFor, none, send: (m) => ws.send(JSON.stringify(m)) };
}

const publish = (ev: object) => ctx.redis.publish(BUS_CHANNEL, JSON.stringify(ev));
const settle = () => new Promise((r) => setTimeout(r, 80));

describe('websocket hub', () => {
  it('answers ping, and fans out price and trade events to guests', async () => {
    const g = await connect();
    g.send({ type: 'ping' });
    await g.waitFor((m) => m.type === 'pong');

    await publish({ kind: 'price', ethUsd: 3501.25 });
    await g.waitFor((m) => m.type === 'price' && m.ethUsd === 3501.25);

    const creator = await member(ctx, 'wscreator');
    const m = await openMarketRow(creator, 200n);
    const buyer = await member(ctx, 'wsbuyer');
    const t = await prisma.trade.create({
      data: {
        txHash: fakeHash(),
        logIndex: 3,
        blockNumber: 1n,
        blockHash: '0x1',
        marketId: m.id,
        trader: buyer.address,
        isBuy: true,
        units: 100n,
        baseWei: '1000',
        creatorFeeWei: '60',
        protocolFeeWei: '20',
        holderFeeWei: '10',
        referralFeeWei: '10',
        totalWei: '1100',
        supplyAfter: 200n,
        ts: new Date(),
      },
    });
    await publish({ kind: 'trade', tradeId: t.id });
    const msg = await g.waitFor((x) => x.type === 'trade');
    expect(msg).toMatchObject({
      type: 'trade',
      data: {
        txHash: t.txHash,
        logIndex: 3,
        isBuy: true,
        units: '100',
        totalWei: '1100',
        trader: { handle: 'wsbuyer' },
        market: { handle: 'wscreator', subject: m.subject },
      },
    });

    await publish({ kind: 'market', marketId: m.id });
    const mk = await g.waitFor((x) => x.type === 'market');
    expect(mk).toMatchObject({ type: 'market', data: { handle: 'wscreator', supplyUnits: '200' } });
    g.ws.terminate();
  });

  it('pushes notifications only to their recipient', async () => {
    const a = await login(ctx, 'wsa');
    const b = await login(ctx, 'wsb');
    const sa = await connect(a.cookie);
    const sb = await connect(b.cookie);
    await settle();
    await notify(prisma, ctx.redis, {
      userId: a.user.id,
      type: 'points',
      body: [{ t: 'hello a' }],
      link: '/tasks',
    });
    const n = await sa.waitFor((m) => m.type === 'notification');
    expect(n).toMatchObject({
      type: 'notification',
      data: { type: 'points', body: [{ t: 'hello a' }], read: false },
    });
    await sb.none((m) => m.type === 'notification');
    sa.ws.terminate();
    sb.ws.terminate();
  });

  it('delivers room messages to subscribed sockets with access only', async () => {
    const owner = await member(ctx, 'wsroom');
    await openMarketRow(owner);
    const holder = await member(ctx, 'wsholder');
    const outsider = await member(ctx, 'wsoutsider');
    ctx.chain.setKeys(owner.address, holder.address, 100n);
    const sh = await connect(holder.cookie);
    const so = await connect(outsider.cookie);
    sh.send({ type: 'subscribe', channel: 'room', handle: 'wsroom' });
    so.send({ type: 'subscribe', channel: 'room', handle: 'wsroom' });
    await settle();
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/users/wsroom/room',
      headers: { cookie: owner.cookie },
      payload: { text: 'holders only' },
    });
    expect(r.statusCode).toBe(200);
    const m = await sh.waitFor((x) => x.type === 'room');
    expect(m).toMatchObject({
      type: 'room',
      handle: 'wsroom',
      data: { text: 'holders only', mine: false, from: { handle: 'wsroom' } },
    });
    await so.none((x) => x.type === 'room');
    sh.ws.terminate();
    so.ws.terminate();
  });

  it('delivers DMs to both participants', async () => {
    const a = await login(ctx, 'wsdma');
    const b = await login(ctx, 'wsdmb');
    const sb = await connect(b.cookie);
    const t = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/messages/dm',
        headers: { cookie: a.cookie },
        payload: { handle: 'wsdmb' },
      })
    ).json<ThreadDTO>();
    sb.send({ type: 'subscribe', channel: 'dm', threadId: t.id });
    await settle();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/messages/dm/${t.id}`,
      headers: { cookie: a.cookie },
      payload: { text: 'psst' },
    });
    const m = await sb.waitFor((x) => x.type === 'dm');
    expect(m).toMatchObject({ type: 'dm', threadId: t.id, data: { text: 'psst', mine: false } });
    sb.ws.terminate();
  });
});
