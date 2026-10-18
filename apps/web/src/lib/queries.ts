'use client';
/** React Query hooks over the SwayApi client. Every read in the app goes through here. */
import type { ExploreSort, ExploreTab, FeedTab, LeaderboardTab, MarketCategory, NotificationTab } from '@sway/shared';
import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/react-query';
import { getApi } from './api';

export const qk = {
  config: ['config'] as const,
  me: ['me'] as const,
  feed: (tab: FeedTab) => ['feed', tab] as const,
  trades: ['trades'] as const,
  search: (q: string) => ['search', q] as const,
  explore: (tab: ExploreTab, sort: ExploreSort, q: string) => ['explore', tab, sort, q] as const,
  markets: (tab: MarketCategory) => ['markets', tab] as const,
  profile: (h: string) => ['profile', h] as const,
  profilePosts: (h: string) => ['profilePosts', h] as const,
  holders: (h: string) => ['holders', h] as const,
  profileTrades: (h: string) => ['profileTrades', h] as const,
  room: (h: string) => ['room', h] as const,
  notifications: (tab: NotificationTab) => ['notifications', tab] as const,
  messages: ['messages'] as const,
  dm: (id: string) => ['dm', id] as const,
  tasks: ['tasks'] as const,
  wallet: ['wallet'] as const,
  leaderboard: (tab: LeaderboardTab) => ['leaderboard', tab] as const,
  battles: ['battles'] as const,
  genesis: ['genesis'] as const,
  launchpad: ['launchpad'] as const,
  onboarding: ['onboarding'] as const,
};

const api = () => getApi();

export const useConfig = () => useQuery({ queryKey: qk.config, queryFn: () => api().config(), staleTime: 5 * 60_000 });
export const useMe = () => useQuery({ queryKey: qk.me, queryFn: () => api().me(), staleTime: 30_000 });
export const useFeed = (tab: FeedTab) => useQuery({ queryKey: qk.feed(tab), queryFn: () => api().feed({ tab }) });
export const useTrades = () => useQuery({ queryKey: qk.trades, queryFn: () => api().liveTrades({ limit: 20 }), staleTime: 60_000 });
export const useSearch = (q: string) =>
  useQuery({ queryKey: qk.search(q), queryFn: () => api().search({ q }), enabled: !!q.trim(), placeholderData: keepPreviousData });
export const useExplore = (tab: ExploreTab, sort: ExploreSort, q: string) =>
  useQuery({ queryKey: qk.explore(tab, sort, q), queryFn: () => api().explore({ tab, sort, q: q || undefined }), placeholderData: keepPreviousData });
export const useMarkets = (tab: MarketCategory) => useQuery({ queryKey: qk.markets(tab), queryFn: () => api().markets({ tab }) });
export const useProfile = (h: string) => useQuery({ queryKey: qk.profile(h), queryFn: () => api().profile(h), enabled: !!h, retry: false });
export const useProfilePosts = (h: string) => useQuery({ queryKey: qk.profilePosts(h), queryFn: () => api().profilePosts(h) });
export const useHolders = (h: string) => useQuery({ queryKey: qk.holders(h), queryFn: () => api().holders(h) });
export const useProfileTrades = (h: string) => useQuery({ queryKey: qk.profileTrades(h), queryFn: () => api().profileTrades(h) });
export const useRoom = (h: string, enabled = true) => useQuery({ queryKey: qk.room(h), queryFn: () => api().room(h), enabled: enabled && !!h });
export const useNotifications = (tab: NotificationTab, enabled: boolean) =>
  useQuery({ queryKey: qk.notifications(tab), queryFn: () => api().notifications({ tab }), enabled });
export const useMessages = (enabled: boolean) => useQuery({ queryKey: qk.messages, queryFn: () => api().messages(), enabled });
export const useDm = (id: string, enabled: boolean) => useQuery({ queryKey: qk.dm(id), queryFn: () => api().dm(id), enabled });
export const useTasks = (enabled: boolean) =>
  useQuery({
    queryKey: qk.tasks,
    queryFn: () => api().tasks(),
    enabled,
    // Poll while a verification is pending (X reads are queued server-side).
    refetchInterval: (q) => (q.state.data?.tasks.some((t) => t.status === 'pending') ? 1000 : false),
  });
export const useWallet = (enabled: boolean) => useQuery({ queryKey: qk.wallet, queryFn: () => api().wallet(), enabled });
export const useLeaderboard = (tab: LeaderboardTab) => useQuery({ queryKey: qk.leaderboard(tab), queryFn: () => api().leaderboard({ tab }) });
export const useBattles = () => useQuery({ queryKey: qk.battles, queryFn: () => api().battles() });
export const useGenesis = () => useQuery({ queryKey: qk.genesis, queryFn: () => api().genesis() });
export const useLaunchpad = () => useQuery({ queryKey: qk.launchpad, queryFn: () => api().launchpad() });

/** Everything that depends on who is signed in (after login/logout). */
export function invalidateAll(qc: QueryClient) {
  return qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'config' });
}

/** After a trade, claim or transfer: balances, holdings, rooms and points move. */
const GLOBAL_MONEY = new Set(['me', 'wallet', 'tasks', 'messages', 'leaderboard', 'genesis', 'feed', 'profilePosts']);
const PER_HANDLE = new Set(['profile', 'room', 'holders', 'profileTrades']);
export function invalidateMoney(qc: QueryClient, handle?: string) {
  return qc.invalidateQueries({
    predicate: (q) => {
      const k = String(q.queryKey[0]);
      return GLOBAL_MONEY.has(k) || (PER_HANDLE.has(k) && (!handle || q.queryKey[1] === handle));
    },
  });
}
