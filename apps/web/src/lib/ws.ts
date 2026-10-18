'use client';
/**
 * WebSocket client for the API hub (NEXT_PUBLIC_WS_URL). Auto-reconnects with exponential backoff and
 * re-sends room/dm subscriptions after every reconnect. Messages are WsServerMessage (packages/shared).
 */
import type { WsClientMessage, WsServerMessage } from '@sway/shared';
import { WS_URL } from './env';

type Listener = (m: WsServerMessage) => void;

class SwaySocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private rooms = new Map<string, number>();
  private dms = new Set<string>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private stopped = true;

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
    this.ws = null;
  }

  /** Reconnect now (e.g. after sign-in, so the socket picks up the session cookie). */
  restart() {
    this.stop();
    this.start();
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribeRoom(handle: string) {
    const n = this.rooms.get(handle) ?? 0;
    this.rooms.set(handle, n + 1);
    if (n === 0) this.send({ type: 'subscribe', channel: 'room', handle });
  }

  unsubscribeRoom(handle: string) {
    const n = this.rooms.get(handle) ?? 0;
    if (n <= 1) {
      this.rooms.delete(handle);
      this.send({ type: 'unsubscribe', channel: 'room', handle });
    } else this.rooms.set(handle, n - 1);
  }

  subscribeDm(threadId: string) {
    if (this.dms.has(threadId)) return;
    this.dms.add(threadId);
    this.send({ type: 'subscribe', channel: 'dm', threadId });
  }

  private send(m: WsClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private connect() {
    if (this.stopped || typeof window === 'undefined') return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.rooms.forEach((_, handle) => this.send({ type: 'subscribe', channel: 'room', handle }));
      this.dms.forEach((threadId) => this.send({ type: 'subscribe', channel: 'dm', threadId }));
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => this.send({ type: 'ping' }), 25_000);
    };
    ws.onmessage = (ev) => {
      let m: WsServerMessage;
      try {
        m = JSON.parse(String(ev.data)) as WsServerMessage;
      } catch {
        return;
      }
      if (m.type === 'pong') return;
      this.listeners.forEach((fn) => fn(m));
    };
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      if (this.ws === ws) this.ws = null;
      this.schedule();
    };
    ws.onerror = () => ws.close();
  }

  private schedule() {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
    this.attempt = Math.min(this.attempt + 1, 6);
    this.timer = setTimeout(() => this.connect(), delay);
  }
}

export const socket = new SwaySocket();
