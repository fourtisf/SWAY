/** In-memory stand-in for the API WebSocket: the mock adapter emits the same WsServerMessage objects. */
import type { WsServerMessage } from '@sway/shared';

type Listener = (m: WsServerMessage) => void;
const listeners = new Set<Listener>();

export function onMockMessage(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitMock(m: WsServerMessage): void {
  // Deliver asynchronously, like a socket would.
  setTimeout(() => listeners.forEach((fn) => fn(m)), 0);
}
