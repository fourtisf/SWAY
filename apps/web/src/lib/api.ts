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
  type TradePermitsBody,
  type TradePermitsResponse,
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
  // [A] wallets & funding
  WALLET_ROUTES,
  type FaucetBody,
  type LinkWalletBody,
  type WalletInfoDTO,
  type WalletLabelBody,
  type WalletRouteKey,
  type WalletsResponse,
  // [B] social, moderation, account & admin
  SOCIAL_ROUTES,
  type AccountDTO,
  type AccountExport,
  type AdminClaimDTO,
  type AdminMarketDTO,
  type AdminMemberDTO,
  type AdminReportAction,
  type AdminReportDTO,
  type AdminTxResult,
  type BoostQuoteDTO,
  type BoostResponse,
  type CardDTO,
  type DeleteAccountBody,
  type HistoryRange,
  type OpenFanMarketBody,
  type PriceHistoryResponse,
  type ReportBody,
  type ReportStatus,
  type SocialRouteKey,
  type UploadResponse,
  // [C] launchpad, staking & genesis
  LAUNCH_ROUTES,
  ENGAGE_ROUTES,
  type EngageRouteKey,
  type ClaimableDropDTO,
  type CreatorDropDTO,
  type DropPlanBody,
  type DropPlanDTO,
  type NotificationPrefs,
  type PushConfigDTO,
  type PushSubscribeBody,
  type ReferralsResponse,
  type StreakDTO,
  type WatchBody,
  type WatchDTO,
  type WatchlistResponse,
  type AirdropsResponse,
  type GenesisListResponse,
  type LaunchAttestBody,
  type LaunchAttestation,
  type LaunchRouteKey,
  type LaunchTokenResponse,
  type StakingResponse,
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
  tradePermits(body: TradePermitsBody): Promise<TradePermitsResponse>;

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
  /** [A] body.address picks one of the member's wallets (default: the account wallet). */
  faucet(body?: FaucetBody): Promise<{ txHash: string }>;

  leaderboard(q: { tab: LeaderboardTab }): Promise<LeaderboardResponse>;
  battles(): Promise<BattlesResponse>;
  createBattle(body: CreateBattleBody): Promise<BattleDTO>;
  respondBattle(id: string, body: { accept: boolean }): Promise<BattleDTO>;
  back(id: string, body: BackBody): Promise<BattleDTO>;
  genesis(): Promise<GenesisResponse>;
  launchpad(): Promise<LaunchpadResponse>;

  /* [A] wallets & funding (WALLET_ROUTES) */
  wallets(): Promise<WalletsResponse>;
  walletsNonce(body?: WalletNonceBody): Promise<WalletNonceResponse>;
  walletsLink(body: LinkWalletBody): Promise<MeDTO>;
  walletsLabel(address: string, body: WalletLabelBody): Promise<WalletInfoDTO>;
  walletsRemove(address: string): Promise<MeDTO>;
  walletsMakeAccount(address: string): Promise<MeDTO>;

  /* [B] social, moderation, account & admin (SOCIAL_ROUTES) */
  deletePost(id: string): Promise<Ok>;
  boostQuote(): Promise<BoostQuoteDTO>;
  boostPost(id: string, body: { txHash: string }): Promise<BoostResponse>;
  report(body: ReportBody): Promise<Ok>;
  block(handle: string): Promise<{ blocked: boolean }>;
  /** multipart/form-data, 1–4 images. */
  upload(files: File[]): Promise<UploadResponse>;
  /** GET /api/uploads/:name serves the image itself: this returns its URL. */
  uploadFileUrl(name: string): string;
  priceHistory(handle: string, q: { range: HistoryRange }): Promise<PriceHistoryResponse>;
  card(handle: string): Promise<CardDTO>;
  account(): Promise<AccountDTO>;
  exportData(): Promise<AccountExport>;
  deleteAccount(body: DeleteAccountBody): Promise<Ok>;
  adminReports(q?: { status?: ReportStatus }): Promise<AdminReportDTO[]>;
  adminResolveReport(id: string, body: { action: AdminReportAction }): Promise<AdminReportDTO>;
  adminHidePost(id: string, body: { hidden: boolean }): Promise<{ hidden: boolean }>;
  pinPost(id: string, body: { pinned: boolean }): Promise<{ pinned: boolean }>;
  adminClaims(q?: { status?: 'open' | 'resolved' }): Promise<AdminClaimDTO[]>;
  adminResolveClaim(id: string): Promise<AdminClaimDTO>;
  adminMembers(q?: { q?: string }): Promise<AdminMemberDTO[]>;
  adminBotFlag(handle: string, body: { flagged: boolean }): Promise<AdminMemberDTO>;
  adminSetAdmin(handle: string, body: { admin: boolean }): Promise<AdminMemberDTO>;
  adminMarkets(q?: { q?: string }): Promise<AdminMarketDTO[]>;
  adminHaltMarket(handle: string, body: { halted: boolean }): Promise<AdminTxResult & { halted: boolean }>;
  adminOpenFanMarket(body: OpenFanMarketBody): Promise<AdminTxResult & { market: AdminMarketDTO }>;

  /* [C] launchpad, staking & genesis (LAUNCH_ROUTES) */
  launchAttest(body?: LaunchAttestBody): Promise<LaunchAttestation>;
  launchToken(handle: string): Promise<LaunchTokenResponse>;
  launchAirdrops(): Promise<AirdropsResponse>;
  staking(): Promise<StakingResponse>;
  genesisLatest(): Promise<GenesisListResponse>;
  genesisSnapshot(id: string): Promise<GenesisListResponse>;

  /* [D] engagement & creator drops (ENGAGE_ROUTES) */
  watchlist(): Promise<WatchlistResponse>;
  watch(handle: string, body: WatchBody): Promise<WatchDTO>;
  unwatch(handle: string): Promise<{ watching: false }>;
  streak(): Promise<StreakDTO>;
  checkIn(): Promise<StreakDTO & { awarded: number }>;
  referrals(): Promise<ReferralsResponse>;
  notifPrefs(): Promise<NotificationPrefs>;
  setNotifPrefs(body: Partial<NotificationPrefs>): Promise<NotificationPrefs>;
  pushConfig(): Promise<PushConfigDTO>;
  pushSubscribe(body: PushSubscribeBody): Promise<Ok>;
  pushUnsubscribe(body: { endpoint: string }): Promise<Ok>;
  pushTest(): Promise<Ok>;
  dropPlan(body: DropPlanBody): Promise<DropPlanDTO>;
  userDrops(handle: string): Promise<CreatorDropDTO[]>;
  claimableDrops(): Promise<ClaimableDropDTO[]>;
}

/** Compile-time check that every ROUTES entry has a client method. */
export const ROUTE_METHODS: Record<RouteKey, keyof SwayApi> = {
  config: 'config', price: 'price', me: 'me', xStart: 'xStartUrl', xCallback: 'xCallbackUrl', devLogin: 'devLogin',
  logout: 'logout', onboarding: 'onboarding', walletNonce: 'walletNonce', walletLink: 'walletLink', openMarket: 'openMarket',
  tradePermits: 'tradePermits',
  feed: 'feed', createPost: 'createPost', post: 'post', like: 'like', repost: 'repost', liveTrades: 'liveTrades',
  search: 'search', explore: 'explore', markets: 'markets', profile: 'profile', profilePosts: 'profilePosts',
  holders: 'holders', profileTrades: 'profileTrades', room: 'room', roomPost: 'roomPost', follow: 'follow',
  subscribe: 'subscribe', tip: 'tip', claimRequest: 'claimRequest', notifications: 'notifications', readAll: 'readAll',
  readOne: 'readOne', messages: 'messages', dmOpen: 'dmOpen', dm: 'dm', dmSend: 'dmSend', tasks: 'tasks',
  taskVerify: 'taskVerify', taskSkip: 'taskSkip', wallet: 'wallet', withdrawLog: 'withdrawLog', faucet: 'faucet',
  leaderboard: 'leaderboard', battles: 'battles', createBattle: 'createBattle', respondBattle: 'respondBattle',
  back: 'back', genesis: 'genesis', launchpad: 'launchpad',
};

/** [A] Same check for WALLET_ROUTES. */
export const WALLET_ROUTE_METHODS: Record<WalletRouteKey, keyof SwayApi> = {
  wallets: 'wallets', walletsNonce: 'walletsNonce', walletsLink: 'walletsLink', walletsLabel: 'walletsLabel', walletsRemove: 'walletsRemove',
  walletsMakeAccount: 'walletsMakeAccount',
};

/** [B] Same check for SOCIAL_ROUTES. */
export const SOCIAL_ROUTE_METHODS: Record<SocialRouteKey, keyof SwayApi> = {
  deletePost: 'deletePost', boostQuote: 'boostQuote', boostPost: 'boostPost', pinPost: 'pinPost', report: 'report', block: 'block',
  upload: 'upload', uploadFile: 'uploadFileUrl', priceHistory: 'priceHistory', card: 'card', account: 'account',
  exportData: 'exportData', deleteAccount: 'deleteAccount', adminReports: 'adminReports',
  adminResolveReport: 'adminResolveReport', adminHidePost: 'adminHidePost', adminClaims: 'adminClaims',
  adminResolveClaim: 'adminResolveClaim', adminMembers: 'adminMembers', adminBotFlag: 'adminBotFlag',
  adminSetAdmin: 'adminSetAdmin', adminMarkets: 'adminMarkets', adminHaltMarket: 'adminHaltMarket',
  adminOpenFanMarket: 'adminOpenFanMarket',
};

/** [C] Same check for LAUNCH_ROUTES. */
export const LAUNCH_ROUTE_METHODS: Record<LaunchRouteKey, keyof SwayApi> = {
  launchAttest: 'launchAttest', launchToken: 'launchToken', launchAirdrops: 'launchAirdrops', staking: 'staking',
  genesisLatest: 'genesisLatest', genesisSnapshot: 'genesisSnapshot',
};

/** [D] Same check for ENGAGE_ROUTES. */
export const ENGAGE_ROUTE_METHODS: Record<EngageRouteKey, keyof SwayApi> = {
  watchlist: 'watchlist', watch: 'watch', unwatch: 'unwatch', streak: 'streak', checkIn: 'checkIn', referrals: 'referrals',
  notifPrefs: 'notifPrefs', setNotifPrefs: 'setNotifPrefs', pushConfig: 'pushConfig', pushSubscribe: 'pushSubscribe',
  pushUnsubscribe: 'pushUnsubscribe', pushTest: 'pushTest', dropPlan: 'dropPlan', userDrops: 'userDrops',
  claimableDrops: 'claimableDrops',
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

type RequestOpts = { params?: Record<string, string>; query?: Query; body?: unknown };

function request<T>(key: RouteKey, opts: RequestOpts = {}): Promise<T> {
  return requestRoute<T>(ROUTES[key], opts);
}

/** Calls any 'METHOD /path' entry, so the workstream tables (*_ROUTES) share one implementation. */
export async function requestRoute<T>(route: string, opts: RequestOpts = {}): Promise<T> {
  const [method, tpl] = route.split(' ') as [string, string];
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

/** [B] POST /api/uploads as multipart/form-data (requestRoute only sends JSON). */
async function uploadFiles(files: File[]): Promise<UploadResponse> {
  const [method, url] = SOCIAL_ROUTES.upload.split(' ') as [string, string];
  const form = new FormData();
  for (const f of files) form.append('file', f, f.name);
  let res: Response;
  try {
    res = await fetch(url, { method, credentials: 'include', headers: { accept: 'application/json' }, body: form });
  } catch {
    throw new ApiRequestError(0, 'network', 'Can’t reach Sway right now');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Partial<ApiError>;
    const err = new ApiRequestError(res.status, body.error || `http_${res.status}`, body.message || res.statusText || 'Upload failed');
    if (isAuthRequired(err)) notifyAuthRequired();
    throw err;
  }
  return (await res.json()) as UploadResponse;
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
    tradePermits: (body) => request('tradePermits', { body }),
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
    faucet: (body) => request('faucet', body ? { body } : {}),
    leaderboard: (query) => request('leaderboard', { query }),
    battles: () => request('battles'),
    createBattle: (body) => request('createBattle', { body }),
    respondBattle: (id, body) => request('respondBattle', { params: { id }, body }),
    back: (id, body) => request('back', { params: { id }, body }),
    genesis: () => request('genesis'),
    launchpad: () => request('launchpad'),

    /* [A] wallets & funding */
    wallets: () => requestRoute(WALLET_ROUTES.wallets),
    walletsNonce: (body) => requestRoute(WALLET_ROUTES.walletsNonce, body ? { body } : {}),
    walletsLink: (body) => requestRoute(WALLET_ROUTES.walletsLink, { body }),
    walletsLabel: (address, body) => requestRoute(WALLET_ROUTES.walletsLabel, { params: { address }, body }),
    walletsRemove: (address) => requestRoute(WALLET_ROUTES.walletsRemove, { params: { address } }),
    walletsMakeAccount: (address) => requestRoute(WALLET_ROUTES.walletsMakeAccount, { params: { address } }),

    /* [B] social, moderation, account & admin */
    deletePost: (id) => requestRoute(SOCIAL_ROUTES.deletePost, { params: { id } }),
    boostQuote: () => requestRoute(SOCIAL_ROUTES.boostQuote),
    boostPost: (id, body) => requestRoute(SOCIAL_ROUTES.boostPost, { params: { id }, body }),
    pinPost: (id, body) => requestRoute(SOCIAL_ROUTES.pinPost, { params: { id }, body }),
    report: (body) => requestRoute(SOCIAL_ROUTES.report, { body }),
    block: (handle) => requestRoute(SOCIAL_ROUTES.block, { params: p(handle) }),
    upload: (files) => uploadFiles(files),
    uploadFileUrl: (name) => SOCIAL_ROUTES.uploadFile.split(' ')[1]!.replace(':name', encodeURIComponent(name)),
    priceHistory: (handle, query) => requestRoute(SOCIAL_ROUTES.priceHistory, { params: p(handle), query }),
    card: (handle) => requestRoute(SOCIAL_ROUTES.card, { params: p(handle) }),
    account: () => requestRoute(SOCIAL_ROUTES.account),
    exportData: () => requestRoute(SOCIAL_ROUTES.exportData),
    deleteAccount: (body) => requestRoute(SOCIAL_ROUTES.deleteAccount, { body }),
    adminReports: (query) => requestRoute(SOCIAL_ROUTES.adminReports, { query }),
    adminResolveReport: (id, body) => requestRoute(SOCIAL_ROUTES.adminResolveReport, { params: { id }, body }),
    adminHidePost: (id, body) => requestRoute(SOCIAL_ROUTES.adminHidePost, { params: { id }, body }),
    adminClaims: (query) => requestRoute(SOCIAL_ROUTES.adminClaims, { query }),
    adminResolveClaim: (id) => requestRoute(SOCIAL_ROUTES.adminResolveClaim, { params: { id } }),
    adminMembers: (query) => requestRoute(SOCIAL_ROUTES.adminMembers, { query }),
    adminBotFlag: (handle, body) => requestRoute(SOCIAL_ROUTES.adminBotFlag, { params: p(handle), body }),
    adminSetAdmin: (handle, body) => requestRoute(SOCIAL_ROUTES.adminSetAdmin, { params: p(handle), body }),
    adminMarkets: (query) => requestRoute(SOCIAL_ROUTES.adminMarkets, { query }),
    adminHaltMarket: (handle, body) => requestRoute(SOCIAL_ROUTES.adminHaltMarket, { params: p(handle), body }),
    adminOpenFanMarket: (body) => requestRoute(SOCIAL_ROUTES.adminOpenFanMarket, { body }),

    /* [C] launchpad, staking & genesis */
    launchAttest: (body) => requestRoute(LAUNCH_ROUTES.launchAttest, { body: body ?? {} }),
    launchToken: (handle) => requestRoute(LAUNCH_ROUTES.launchToken, { params: p(handle) }),
    launchAirdrops: () => requestRoute(LAUNCH_ROUTES.launchAirdrops),
    staking: () => requestRoute(LAUNCH_ROUTES.staking),
    genesisLatest: () => requestRoute(LAUNCH_ROUTES.genesisLatest),
    genesisSnapshot: (id) => requestRoute(LAUNCH_ROUTES.genesisSnapshot, { params: { id } }),

    /* [D] engagement & creator drops */
    watchlist: () => requestRoute(ENGAGE_ROUTES.watchlist),
    watch: (handle, body) => requestRoute(ENGAGE_ROUTES.watch, { params: p(handle), body }),
    unwatch: (handle) => requestRoute(ENGAGE_ROUTES.unwatch, { params: p(handle) }),
    streak: () => requestRoute(ENGAGE_ROUTES.streak),
    checkIn: () => requestRoute(ENGAGE_ROUTES.checkIn),
    referrals: () => requestRoute(ENGAGE_ROUTES.referrals),
    notifPrefs: () => requestRoute(ENGAGE_ROUTES.notifPrefs),
    setNotifPrefs: (body) => requestRoute(ENGAGE_ROUTES.setNotifPrefs, { body }),
    pushConfig: () => requestRoute(ENGAGE_ROUTES.pushConfig),
    pushSubscribe: (body) => requestRoute(ENGAGE_ROUTES.pushSubscribe, { body }),
    pushUnsubscribe: (body) => requestRoute(ENGAGE_ROUTES.pushUnsubscribe, { body }),
    pushTest: () => requestRoute(ENGAGE_ROUTES.pushTest),
    dropPlan: (body) => requestRoute(ENGAGE_ROUTES.dropPlan, { body }),
    userDrops: (handle) => requestRoute(ENGAGE_ROUTES.userDrops, { params: p(handle) }),
    claimableDrops: () => requestRoute(ENGAGE_ROUTES.claimableDrops),
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
