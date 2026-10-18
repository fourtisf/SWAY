/**
 * WebSocket hub at /ws. Auth comes from the same session cookie (guests get public trades, markets, prices).
 * A dedicated ioredis subscriber listens on BUS_CHANNEL; each BusEvent carries an id, the hub loads the row,
 * builds the DTO with the REST mappers and fans it out:
 *   trade / market / price → everyone · notification → its recipient · room → sockets subscribed to that room
 *   whose user has access (checked again on every message, 60s cache) · dm → both participants.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { BUS_CHANNEL, normalizeHandle, type BusEvent, type MarketDTO, type WsServerMessage } from '@sway/shared';
import { messageDTO, notificationDTO, TRADE_INCLUDE, tradeDTOs } from './services/dto';
import { marketDTO, marketStats } from './services/markets';

const HEARTBEAT_MS = 30_000;
const MSG_BUDGET = 40; // client messages per 10s

// Client messages (WsClientMessage), validated per shape.
const SubRoom = z.object({ type: z.enum(['subscribe', 'unsubscribe']), channel: z.literal('room'), handle: z.string().min(1).max(40) });
const SubDm = z.object({ type: z.literal('subscribe'), channel: z.literal('dm'), threadId: z.string().min(1).max(64) });

interface Client {
  socket: WebSocket;
  userId: string | null;
  rooms: Set<string>;
  dms: Set<string>;
  alive: boolean;
  budget: { n: number; at: number };
}

export class WsHub {
  private readonly clients = new Set<Client>();
  private readonly byUser = new Map<string, Set<Client>>();
  private readonly roomSubs = new Map<string, Set<Client>>();
  private sub: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly app: FastifyInstance) {}

  get size(): number {
    return this.clients.size;
  }

  async start(): Promise<void> {
    const { deps } = this.app;
    this.sub = deps.redisSub ?? deps.redis.duplicate();
    this.sub.on('message', (channel: string, raw: string) => {
      if (channel !== BUS_CHANNEL) return;
      this.onBus(raw).catch((err) => this.app.log.warn({ err }, 'ws hub: event failed'));
    });
    await this.sub.subscribe(BUS_CHANNEL);
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.clients) c.socket.terminate();
    this.clients.clear();
    if (this.sub) {
      await this.sub.unsubscribe(BUS_CHANNEL).catch(() => undefined);
      if (!this.app.deps.redisSub) this.sub.disconnect();
    }
  }

  attach(socket: WebSocket, req: FastifyRequest): void {
    const c: Client = { socket, userId: req.session?.userId ?? null, rooms: new Set(), dms: new Set(), alive: true, budget: { n: 0, at: Date.now() } };
    this.clients.add(c);
    if (c.userId) {
      const set = this.byUser.get(c.userId) ?? new Set();
      set.add(c);
      this.byUser.set(c.userId, set);
    }
    socket.on('pong', () => {
      c.alive = true;
    });
    socket.on('message', (data) => {
      c.alive = true;
      this.onClient(c, String(data)).catch((err) => this.app.log.debug({ err }, 'ws client message failed'));
    });
    socket.on('close', () => this.detach(c));
    socket.on('error', () => this.detach(c));
  }

  private detach(c: Client): void {
    this.clients.delete(c);
    if (c.userId) {
      const set = this.byUser.get(c.userId);
      set?.delete(c);
      if (set && !set.size) this.byUser.delete(c.userId);
    }
    for (const m of c.rooms) {
      const s = this.roomSubs.get(m);
      s?.delete(c);
      if (s && !s.size) this.roomSubs.delete(m);
    }
  }

  private heartbeat(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        c.socket.terminate();
        this.detach(c);
        continue;
      }
      c.alive = false;
      try {
        c.socket.ping();
      } catch {
        this.detach(c);
      }
    }
  }

  private send(c: Client, msg: WsServerMessage): void {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(msg));
  }

  private broadcast(msg: WsServerMessage): void {
    const s = JSON.stringify(msg);
    for (const c of this.clients) if (c.socket.readyState === c.socket.OPEN) c.socket.send(s);
  }

  private async viewerFor(c: Client) {
    if (!c.userId) return null;
    const w = await this.app.deps.prisma.wallet.findUnique({ where: { userId: c.userId }, select: { address: true } });
    return { userId: c.userId, wallet: w?.address ?? null };
  }

  private async onClient(c: Client, raw: string): Promise<void> {
    const now = Date.now();
    if (now - c.budget.at > 10_000) c.budget = { n: 0, at: now };
    if (++c.budget.n > MSG_BUDGET) return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if ((msg as { type?: string })?.type === 'ping') return this.send(c, { type: 'pong' });
    const room = SubRoom.safeParse(msg);
    if (room.success) {
      const { prisma } = this.app.deps;
      const market = await prisma.keyMarket.findFirst({ where: { user: { handle: normalizeHandle(room.data.handle) } } });
      if (!market) return;
      if (room.data.type === 'unsubscribe') {
        c.rooms.delete(market.id);
        this.roomSubs.get(market.id)?.delete(c);
        return;
      }
      if ((await this.app.access.roomAccess(await this.viewerFor(c), market)) !== 'open') return;
      c.rooms.add(market.id);
      const set = this.roomSubs.get(market.id) ?? new Set();
      set.add(c);
      this.roomSubs.set(market.id, set);
      return;
    }
    const dm = SubDm.safeParse(msg);
    if (dm.success && c.userId) {
      const t = await this.app.deps.prisma.dmThread.findUnique({ where: { id: dm.data.threadId }, select: { aId: true, bId: true } });
      if (t && (t.aId === c.userId || t.bId === c.userId)) c.dms.add(dm.data.threadId);
    }
  }

  /** Visible for tests. */
  async onBus(raw: string): Promise<void> {
    let ev: BusEvent;
    try {
      ev = JSON.parse(raw) as BusEvent;
    } catch {
      return;
    }
    const { prisma, config } = this.app.deps;
    switch (ev.kind) {
      case 'price':
        if (typeof ev.ethUsd === 'number' && ev.ethUsd > 0) this.broadcast({ type: 'price', ethUsd: ev.ethUsd });
        return;
      case 'trade': {
        const t = await prisma.trade.findUnique({ where: { id: ev.tradeId }, include: TRADE_INCLUDE });
        if (!t) return;
        await this.app.access.invalidate(t.market.subject, t.trader);
        const [dto] = await tradeDTOs(prisma, [t], config.contracts.fanEscrow);
        this.broadcast({ type: 'trade', data: dto! });
        return;
      }
      case 'market': {
        const m = await prisma.keyMarket.findUnique({ where: { id: ev.marketId }, include: { user: true } });
        if (!m) return;
        const full: MarketDTO = marketDTO(m, (await marketStats(prisma, [m])).get(m.id));
        this.broadcast({
          type: 'market',
          data: { subject: full.subject, handle: full.handle, supplyUnits: full.supplyUnits, priceWei: full.priceWei, holders: full.holders, volumeWei: full.volumeWei, change: full.change },
        });
        return;
      }
      case 'notification': {
        const n = await prisma.notification.findUnique({ where: { id: ev.notificationId }, include: { from: { include: { market: true } } } });
        if (!n) return;
        const targets = this.byUser.get(n.userId);
        if (!targets?.size) return;
        const data = notificationDTO(n);
        for (const c of targets) this.send(c, { type: 'notification', data });
        return;
      }
      case 'room': {
        const m = await prisma.roomMessage.findUnique({
          where: { id: ev.messageId },
          include: { author: { include: { market: true } }, market: { include: { user: true } } },
        });
        if (!m) return;
        const subs = this.roomSubs.get(m.marketId);
        if (!subs?.size) return;
        for (const c of [...subs]) {
          const access = await this.app.access.roomAccess(await this.viewerFor(c), m.market);
          if (access !== 'open') {
            subs.delete(c);
            c.rooms.delete(m.marketId);
            continue;
          }
          this.send(c, { type: 'room', handle: m.market.user.handle, data: messageDTO(m, c.userId) });
        }
        return;
      }
      case 'dm': {
        const m = await prisma.dmMessage.findUnique({ where: { id: ev.messageId }, include: { author: { include: { market: true } }, thread: true } });
        if (!m) return;
        for (const uid of [m.thread.aId, m.thread.bId]) {
          for (const c of this.byUser.get(uid) ?? []) this.send(c, { type: 'dm', threadId: m.threadId, data: messageDTO(m, c.userId) });
        }
        return;
      }
    }
  }
}

export async function setupWs(app: FastifyInstance): Promise<WsHub> {
  const hub = new WsHub(app);
  app.get('/ws', { websocket: true }, (socket, req) => hub.attach(socket, req));
  app.addHook('onReady', () => hub.start());
  app.addHook('onClose', () => hub.stop());
  return hub;
}

