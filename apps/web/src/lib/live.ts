'use client';
/**
 * Applies WsServerMessage events (real socket or the mock bus) to the React Query cache: live trades,
 * market prices, notifications (badge + toast), room/DM messages and the ETH/USD price.
 */
import type {
  DmResponse,
  MeDTO,
  MessagesResponse,
  NotificationDTO,
  NotificationTab,
  RoomResponse,
  TradeDTO,
  WsServerMessage,
} from '@sway/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getApi } from './api';
import { MOCK } from './env';
import { onMockMessage } from './mock/bus';
import { qk } from './queries';
import { toast, useUI } from './store';
import { plainText } from './util';
import { socket } from './ws';

export const tradeKey = (t: Pick<TradeDTO, 'txHash' | 'logIndex'>) => `${t.txHash}:${t.logIndex}`;

type MarketPatch = Extract<WsServerMessage, { type: 'market' }>['data'];

/** Returns a copy of `v` with every market-shaped object for `p.subject` patched, or `v` itself if unchanged. */
function patchDeep(v: unknown, p: MarketPatch, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = patchDeep(x, p, depth + 1);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  const o = v as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  if (typeof o.subject === 'string' && o.subject.toLowerCase() === p.subject.toLowerCase()) {
    if ('supplyUnits' in o) next = { ...o, supplyUnits: p.supplyUnits, priceWei: p.priceWei, holders: p.holders, volumeWei: p.volumeWei, change: p.change };
    else if ('priceWei' in o && 'change' in o) next = { ...o, priceWei: p.priceWei, change: p.change };
  }
  for (const [k, val] of Object.entries(next ?? o)) {
    if (val && typeof val === 'object') {
      const y = patchDeep(val, p, depth + 1);
      if (y !== val) {
        next = next ?? { ...o };
        next[k] = y;
      }
    }
  }
  return next ?? v;
}

const PATCHABLE = new Set(['explore', 'markets', 'search', 'profile', 'feed', 'profilePosts', 'battles', 'wallet']);

function onNotification(qc: QueryClient, n: NotificationDTO) {
  const matches = (tab: NotificationTab) =>
    tab === 'all' || (tab === 'trades' ? n.type === 'trade' : n.type === 'mention' || n.type === 'battle');
  for (const [key, data] of qc.getQueriesData<NotificationDTO[]>({ queryKey: ['notifications'] })) {
    const tab = key[1] as NotificationTab;
    if (data && matches(tab) && !data.some((x) => x.id === n.id)) qc.setQueryData(key, [n, ...data]);
  }
  qc.setQueryData<MeDTO | null>(qk.me, (me) => (me ? { ...me, unreadNotifications: me.unreadNotifications + 1 } : me));
  if (n.type === 'points') qc.invalidateQueries({ queryKey: qk.tasks });
  if (n.type === 'trade') qc.invalidateQueries({ queryKey: qk.wallet });
  // The Tasks page already says "Verified on X. +N pts" for task notifications.
  const onTasks = typeof window !== 'undefined' && window.location.pathname === '/tasks';
  if (!(n.type === 'points' && onTasks)) toast(plainText(n.body));
}

export function handleWsMessage(qc: QueryClient, m: WsServerMessage) {
  switch (m.type) {
    case 'trade': {
      const t = m.data;
      const key = tradeKey(t);
      qc.setQueryData<TradeDTO[]>(qk.trades, (old) => (old ? [t, ...old.filter((x) => tradeKey(x) !== key)].slice(0, 40) : old));
      qc.setQueryData<TradeDTO[]>(qk.profileTrades(t.market.handle), (old) => (old && !old.some((x) => tradeKey(x) === key) ? [t, ...old] : old));
      useUI.setState({ newTrade: key });
      const me = qc.getQueryData<MeDTO | null>(qk.me);
      if (me && (me.user.handle === t.trader.handle || me.user.handle === t.market.handle)) {
        // The indexer has this trade now: holdings, room access, balances and points may have moved.
        for (const key of [qk.wallet, qk.me, qk.tasks, qk.messages, qk.holders(t.market.handle), qk.profile(t.market.handle), qk.room(t.market.handle)])
          qc.invalidateQueries({ queryKey: key });
      }
      break;
    }
    case 'market': {
      for (const q of qc.getQueryCache().getAll()) {
        if (!PATCHABLE.has(String(q.queryKey[0])) || q.state.data === undefined) continue;
        const next = patchDeep(q.state.data, m.data);
        if (next !== q.state.data) qc.setQueryData(q.queryKey, next);
      }
      break;
    }
    case 'notification':
      onNotification(qc, m.data);
      break;
    case 'room': {
      qc.setQueryData<RoomResponse>(qk.room(m.handle), (old) =>
        old && old.access === 'open' && !old.messages.some((x) => x.id === m.data.id) ? { ...old, messages: [...old.messages, m.data] } : old,
      );
      qc.setQueryData<MessagesResponse>(qk.messages, (old) =>
        old ? { ...old, rooms: old.rooms.map((r) => (r.with.handle === m.handle ? { ...r, last: m.data.text } : r)) } : old,
      );
      break;
    }
    case 'dm': {
      qc.setQueryData<DmResponse>(qk.dm(m.threadId), (old) =>
        old && !old.messages.some((x) => x.id === m.data.id) ? { ...old, messages: [...old.messages, m.data] } : old,
      );
      const viewing = typeof window !== 'undefined' && window.location.pathname === `/messages/${m.threadId}`;
      if (viewing) {
        // Opening the thread marks it read server-side; refresh badges after that.
        getApi()
          .dm(m.threadId)
          .catch(() => null)
          .finally(() => {
            qc.invalidateQueries({ queryKey: qk.me });
            qc.invalidateQueries({ queryKey: qk.messages });
          });
      } else if (!m.data.mine) {
        qc.invalidateQueries({ queryKey: qk.me });
        qc.invalidateQueries({ queryKey: qk.messages });
      }
      break;
    }
    case 'price':
      useUI.setState({ ethUsd: m.ethUsd });
      break;
    case 'pong':
      break;
  }
}

/** Mount once (in the shell): connects the socket (or mock bus) and routes messages into the cache. */
export function useLive() {
  const qc = useQueryClient();
  useEffect(() => {
    const fn = (m: WsServerMessage) => handleWsMessage(qc, m);
    if (MOCK) return onMockMessage(fn);
    const off = socket.on(fn);
    socket.start();
    return () => {
      off();
    };
  }, [qc]);
}

/** Subscribe to a room's live messages while it is on screen. */
export function useRoomSubscription(handle: string | null, enabled: boolean) {
  useEffect(() => {
    if (MOCK || !handle || !enabled) return;
    socket.subscribeRoom(handle);
    return () => socket.unsubscribeRoom(handle);
  }, [handle, enabled]);
}

export function useDmSubscription(threadId: string | null) {
  useEffect(() => {
    if (MOCK || !threadId) return;
    socket.subscribeDm(threadId);
  }, [threadId]);
}
