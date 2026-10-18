/**
 * Typed client for the Sway HTTP API (packages/shared/src/api.ts). One method per ROUTES entry.
 * Real mode calls same-origin /api/* (proxied to apps/api by next.config rewrites) with cookies.
 * Mock mode (NEXT_PUBLIC_API_MOCK=1) swaps in the in-memory adapter from ./mock, same interface.
 */
import {
  ROUTES,
  type ActivityDTO,
  type ApiError,
  type BackBody,
  type BattleDTO,
  type BattlesResponse,
  type ConfigDTO,
  type CreateBattleBody,
  type CreatePostBody,
  type DevLoginBody,
  type DmResponse,
  type ExploreResponse,
  type ExploreSort,
  type ExploreTab,
  type FeedResponse,
  type FeedTab,
  type GenesisResponse,
  type HolderDTO,
  type LaunchpadResponse,
  type LeaderboardResponse,
  type LeaderboardTab,
  type MarketCategory,
  type MarketsResponse,
  type MeDTO,
  type MessageDTO,
  type MessagesResponse,
  type NotificationDTO,
  type NotificationTab,
  type OnboardingStatus,
  type PriceResponse,
  type PostDTO,
  type PostDetailResponse,
  type ProfileDTO,
  type RoomResponse,
  type RouteKey,
  type SearchResponse,
  type TaskDTO,
  type TasksResponse,
  type ThreadDTO,
  type TradeDTO,
  type Wei,
  type WalletDTO,
  type WalletLinkBody,
  type WalletNonceBody,
  type WalletNonceResponse,
} from '@sway/shared';
import { MOCK } from './env';

export type Ok = { ok: true };
export type ReadResult = { ok: true; unread: number };

export interface SwayApi {
  config(): Promise<ConfigDTO>;
  price(): Promise<PriceResponse>;
  /** null for guests (the API answers 401). */
  me(): Promise<MeDTO | null>;
  /** GET /api/auth/x/start is a browser navigation, not a fetch: this returns the URL to open. */
  xStartUrl(redirect: string, ref?: string | null): string;
  /** GET /api/auth/x/callback is X's redirect target, handled by the API. Exposed for completeness. */
  xCallbackUrl(): string;
  devLogin(body: DevLoginBody): Promise<MeDTO>;
  logout(): Promise<Ok>;
  onboarding(): Promise<OnboardingStatus>;
  walletNonce(body?: WalletNonceBody): Promise<WalletNonceResponse>;
  walletLink(body: WalletLinkBody): Promise<MeDTO>;
  openMarket(): Promise<OnboardingStatus>;

  feed(q: { tab: FeedTab; cursor?: string }): Promise<FeedResponse>;
  createPost(body: CreatePostBody): Promise<PostDTO>;
  post(id: string): Promise<PostDetailResponse>;
  like(id: string): Promise<{ liked: boolean; count: number }>;
  repost(id: string): Promise<{ reposted: boolean; count: number }>;
  liveTrades(q?: { limit?: number }): Promise<TradeDTO[]>;
  search(q: { q: string }): Promise<SearchResponse>;
  explore(q: { tab: ExploreTab; sort?: ExploreSort; q?: string }): Promise<ExploreResponse>;
  markets(q: { tab: MarketCategory }): Promise<MarketsResponse>;

  profile(handle: string): Promise<ProfileDTO>;
  profilePosts(handle: string): Promise<PostDTO[]>;
  holders(handle: string): Promise<HolderDTO[]>;
  profileTrades(handle: string): Promise<TradeDTO[]>;
  room(handle: string): Promise<RoomResponse>;
  roomPost(handle: string, body: { text: string }): Promise<MessageDTO>;
  follow(handle: string): Promise<{ following: boolean }>;
  subscribe(handle: string, body: { txHash: string }): Promise<Ok>;
  tip(handle: string, body: { txHash: string }): Promise<Ok>;
  claimRequest(handle: string, body: { kind: 'claim' | 'takedown'; contact: string; note?: string }): Promise<Ok>;

  notifications(q: { tab: NotificationTab }): Promise<NotificationDTO[]>;
  readAll(): Promise<ReadResult>;
  readOne(id: string): Promise<ReadResult>;
  messages(): Promise<MessagesResponse>;
  dmOpen(body: { handle: string }): Promise<ThreadDTO>;
  dm(id: string): Promise<DmResponse>;
  dmSend(id: string, body: { text: string }): Promise<MessageDTO>;

  tasks(): Promise<TasksResponse>;
  taskVerify(id: string): Promise<TaskDTO>;
  taskSkip(id: string): Promise<TaskDTO>;
  wallet(): Promise<WalletDTO>;
  withdrawLog(body: { label: string; amountWei: Wei; txHash: string }): Promise<ActivityDTO>;
  faucet(): Promise<{ txHash: string }>;

  leaderboard(q: { tab: LeaderboardTab }): Promise<LeaderboardResponse>;
  battles(): Promise<BattlesResponse>;
  createBattle(body: CreateBattleBody): Promise<BattleDTO>;
  respondBattle(id: string, body: { accept: boolean }): Promise<BattleDTO>;
  back(id: string, body: BackBody): Promise<BattleDTO>;
  genesis(): Promise<GenesisResponse>;
  launchpad(): Promise<LaunchpadResponse>;
}

/** Compile-time check that every ROUTES entry has a client method. */
export const ROUTE_METHODS: Record<RouteKey, keyof SwayApi> = {
  config: 'config', price: 'price', me: 'me', xStart: 'xStartUrl', xCallback: 'xCallbackUrl', devLogin: 'devLogin',
  logout: 'logout', onboarding: 'onboarding', walletNonce: 'walletNonce', walletLink: 'walletLink', openMarket: 'openMarket',
  feed: 'feed', createPost: 'createPost', post: 'post', like: 'like', repost: 'repost', liveTrades: 'liveTrades',
  search: 'search', explore: 'explore', markets: 'markets', profile: 'profile', profilePosts: 'profilePosts',
  holders: 'holders', profileTrades: 'profileTrades', room: 'room', roomPost: 'roomPost', follow: 'follow',
  subscribe: 'subscribe', tip: 'tip', claimRequest: 'claimRequest', notifications: 'notifications', readAll: 'readAll',
  readOne: 'readOne', messages: 'messages', dmOpen: 'dmOpen', dm: 'dm', dmSend: 'dmSend', tasks: 'tasks',
  taskVerify: 'taskVerify', taskSkip: 'taskSkip', wallet: 'wallet', withdrawLog: 'withdrawLog', faucet: 'faucet',
  leaderboard: 'leaderboard', battles: 'battles', createBattle: 'createBattle', respondBattle: 'respondBattle',
  back: 'back', genesis: 'genesis', launchpad: 'launchpad',
};

/** Non-2xx answer from the API, carrying the ApiError body. */
export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export const isAuthRequired = (e: unknown): boolean =>
  e instanceof ApiRequestError && (e.status === 401 || e.code === 'auth_required');

export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message || e.code;
  if (e && typeof e === 'object' && 'shortMessage' in e && typeof (e as { shortMessage: unknown }).shortMessage === 'string')
    return (e as { shortMessage: string }).shortMessage;
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}

/* ---------------------------------------------------------------- auth hook */

let onAuthRequired: (() => void) | null = null;
/** The shell registers this to open the Connect X modal when a write answers 401 auth_required. */
export function setAuthRequiredHandler(fn: (() => void) | null): void {
  onAuthRequired = fn;
}
export function notifyAuthRequired(): void {
  onAuthRequired?.();
}

/* ---------------------------------------------------------------- http implementation */

type Query = Record<string, string | number | boolean | undefined | null>;

async function request<T>(key: RouteKey, opts: { params?: Record<string, string>; query?: Query; body?: unknown } = {}): Promise<T> {
  const [method, tpl] = ROUTES[key].split(' ') as [string, string];
  const path = tpl.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(opts.params?.[k] ?? ''));
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const url = path + (qs.size ? `?${qs}` : '');
  const init: RequestInit = { method, credentials: 'include', headers: { accept: 'application/json' } };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { ...init.headers, 'content-type': 'application/json' };
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiRequestError(0, 'network', 'Can’t reach Sway right now');
  }
  if (!res.ok) {
    let body: Partial<ApiError> = {};
    try {
      body = (await res.json()) as ApiError;
    } catch {
      /* not JSON */
    }
    const err = new ApiRequestError(res.status, body.error || `http_${res.status}`, body.message || res.statusText || 'Request failed');
    if (method !== 'GET' && isAuthRequired(err)) notifyAuthRequired();
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function createHttpApi(): SwayApi {
  const p = (handle: string) => ({ handle });
  return {
    config: () => request('config'),
    price: () => request('price'),
    me: async () => {
      try {
        return (await request<MeDTO | null>('me')) ?? null;
      } catch (e) {
        if (isAuthRequired(e)) return null;
        throw e;
      }
    },
    xStartUrl: (redirect, ref) =>
      `${ROUTES.xStart.split(' ')[1]}?redirect=${encodeURIComponent(redirect)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`,
    xCallbackUrl: () => ROUTES.xCallback.split(' ')[1]!,
    devLogin: (body) => request('devLogin', { body }),
    logout: () => request('logout'),
    onboarding: () => request('onboarding'),
    walletNonce: (body) => request('walletNonce', body ? { body } : {}),
    walletLink: (body) => request('walletLink', { body }),
    openMarket: () => request('openMarket'),
    feed: (query) => request('feed', { query }),
    createPost: (body) => request('createPost', { body }),
    post: (id) => request('post', { params: { id } }),
    like: (id) => request('like', { params: { id } }),
    repost: (id) => request('repost', { params: { id } }),
    liveTrades: (query) => request('liveTrades', { query }),
    search: (query) => request('search', { query }),
    explore: (query) => request('explore', { query }),
    markets: (query) => request('markets', { query }),
    profile: (handle) => request('profile', { params: p(handle) }),
    profilePosts: (handle) => request('profilePosts', { params: p(handle) }),
    holders: (handle) => request('holders', { params: p(handle) }),
    profileTrades: (handle) => request('profileTrades', { params: p(handle) }),
    room: (handle) => request('room', { params: p(handle) }),
    roomPost: (handle, body) => request('roomPost', { params: p(handle), body }),
    follow: (handle) => request('follow', { params: p(handle) }),
    subscribe: (handle, body) => request('subscribe', { params: p(handle), body }),
    tip: (handle, body) => request('tip', { params: p(handle), body }),
    claimRequest: (handle, body) => request('claimRequest', { params: p(handle), body }),
    notifications: (query) => request('notifications', { query }),
    readAll: () => request('readAll'),
    readOne: (id) => request('readOne', { params: { id } }),
    messages: () => request('messages'),
    dmOpen: (body) => request('dmOpen', { body }),
    dm: (id) => request('dm', { params: { id } }),
    dmSend: (id, body) => request('dmSend', { params: { id }, body }),
    tasks: () => request('tasks'),
    taskVerify: (id) => request('taskVerify', { params: { id } }),
    taskSkip: (id) => request('taskSkip', { params: { id } }),
    wallet: () => request('wallet'),
    withdrawLog: (body) => request('withdrawLog', { body }),
    faucet: () => request('faucet'),
    leaderboard: (query) => request('leaderboard', { query }),
    battles: () => request('battles'),
    createBattle: (body) => request('createBattle', { body }),
    respondBattle: (id, body) => request('respondBattle', { params: { id }, body }),
    back: (id, body) => request('back', { params: { id }, body }),
    genesis: () => request('genesis'),
    launchpad: () => request('launchpad'),
  };
}

/* ---------------------------------------------------------------- selection */

let instance: SwayApi | null = null;

/** The client for this build: the in-memory adapter in mock mode, HTTP otherwise. */
export function getApi(): SwayApi {
  if (!instance) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    instance = MOCK ? (require('./mock') as typeof import('./mock')).getMockApi() : createHttpApi();
  }
  return instance;
}
