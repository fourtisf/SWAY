/**
 * The HTTP + WebSocket contract between apps/web and apps/api. Both sides import these types; change
 * them here first.
 *
 * Conventions
 * - All routes live under /api. The web app proxies /api/* to the API (next.config rewrites), so the
 *   session cookie is first-party. The WebSocket is at /ws on the API origin.
 * - ETH amounts are wei as decimal strings (`Wei`). Key amounts are units as decimal strings
 *   (`Units`, 1 key = 100 units). Convert with @sway/curve (weiToEth, unitsToKeys).
 * - Timestamps are ISO-8601 strings.
 * - Errors: non-2xx with `ApiError` JSON.
 * - Guests can call every GET. Writes need a session (401 `auth_required`).
 */
import type { MarketCategory, TaskGroup, TaskIcon, TaskId } from './tasks';

export type Wei = string;
export type Units = string;
export type Address = `0x${string}`;
export type ISODate = string;

export interface ApiError {
  error: string;
  message: string;
}

/* ---------------------------------------------------------------- people & markets */

/** Minimal identity used everywhere a person is shown (avatar + name + handle). */
export interface UserRef {
  handle: string;
  name: string;
  avatarUrl: string | null;
  verified: boolean;
  /** The official @swaydotfam account (black logo avatar, gold badge). */
  official?: boolean;
  /** false for an unclaimed fan market. */
  claimed?: boolean;
}

/** A key market as listed on cards, tables and search. */
export interface MarketDTO extends UserRef {
  subject: Address;
  category: MarketCategory;
  claimed: boolean;
  followers: number;
  score: number;
  /** Reach value in USD. */
  reachValue: number;
  supplyUnits: Units;
  /** Marginal price at current supply (price(supply)). */
  priceWei: Wei;
  holders: number;
  volumeWei: Wei;
  /** Creator fees escrowed for an unclaimed fan market. */
  escrowWei: Wei;
  /** Percent change over the last 24 trades (the prototype's change). */
  change: number;
  /** Recent prices in ETH for the sparkline, oldest first. */
  spark: number[];
  memberNo: number | null;
  joinedAt: ISODate | null;
}

export interface ProfileDTO extends MarketDTO {
  bio: string;
  /** Wallet that receives tips/subscriptions and owns the locked first key. Null while a fan market is unclaimed. */
  ownerAddress: Address | null;
  isMe: boolean;
  following: boolean;
  subscribed: boolean;
  /** Units of this market the viewer holds (0 for guests). */
  heldUnits: Units;
  /** Price history in ETH (oldest first) for the curve chart and future range chart. */
  history: Array<{ t: ISODate; priceWei: Wei }>;
}

export interface HolderDTO extends UserRef {
  units: Units;
  you: boolean;
}

export interface TradeDTO {
  txHash: string;
  logIndex: number;
  trader: UserRef & { address: Address };
  market: UserRef & { subject: Address };
  isBuy: boolean;
  units: Units;
  baseWei: Wei;
  /** What the trader paid (buy) or received (sell). */
  totalWei: Wei;
  supplyAfter: Units;
  ts: ISODate;
}

/* ---------------------------------------------------------------- feed */

export type Visibility = 'public' | 'holders' | 'subs';
export type FeedTab = 'foryou' | 'trending' | 'following' | 'latest';

export interface PostDTO {
  id: string;
  author: UserRef & { subject: Address | null; priceWei: Wei | null; change: number };
  /** null when locked for this viewer. */
  text: string | null;
  /** Placeholder text of the same length, shown blurred when locked. */
  teaser: string | null;
  locked: boolean;
  visibility: Visibility;
  pinned: boolean;
  boosted: boolean;
  parentId: string | null;
  createdAt: ISODate;
  likes: number;
  reposts: number;
  replies: number;
  liked: boolean;
  reposted: boolean;
  mine: boolean;
}

export interface FeedResponse {
  pinned: PostDTO | null;
  posts: PostDTO[];
  nextCursor: string | null;
}

export interface CreatePostBody {
  text: string;
  visibility: Visibility;
  parentId?: string;
}

export interface PostDetailResponse {
  post: PostDTO;
  replies: PostDTO[];
}

/* ---------------------------------------------------------------- explore / search */

export interface TagDTO {
  tag: string;
  posts: number;
}

export type ExploreTab = 'creators' | 'tags' | 'new';
export type ExploreSort = 'trending' | 'volume' | 'price' | 'score';

export interface SearchResponse {
  members: MarketDTO[];
  tags: TagDTO[];
}

export interface ExploreResponse {
  creators: MarketDTO[];
  tags: TagDTO[];
}

export interface MarketsResponse {
  stats: { markets: number; volumeWei: Wei; holders: number };
  markets: MarketDTO[];
}

/* ---------------------------------------------------------------- rooms & messages */

export interface MessageDTO {
  id: string;
  from: UserRef;
  text: string;
  createdAt: ISODate;
  mine: boolean;
}

export type RoomAccess = 'open' | 'locked' | 'unclaimed';

export interface RoomResponse {
  access: RoomAccess;
  /** Empty unless access is 'open'. */
  messages: MessageDTO[];
  /** Cost of 1 key right now, for the "Buy 1 key for $X" button. */
  oneKeyTotalWei: Wei;
}

export interface ThreadDTO {
  id: string;
  kind: 'room' | 'dm';
  with: UserRef;
  last: string | null;
  unread: boolean;
  /** Rooms only. */
  holders?: number;
}

export interface MessagesResponse {
  rooms: ThreadDTO[];
  dms: ThreadDTO[];
}

export interface DmResponse {
  thread: ThreadDTO;
  messages: MessageDTO[];
}

/* ---------------------------------------------------------------- notifications */

export type NotificationType = 'trade' | 'mention' | 'battle' | 'points';
export type NotificationTab = 'all' | 'trades' | 'mentions';

/** Rich text without HTML: bold segments are rendered <b>. */
export type RichText = Array<{ t: string; b?: boolean }>;

export interface NotificationDTO {
  id: string;
  type: NotificationType;
  from: UserRef | null;
  body: RichText;
  /** In-app path to open on click, e.g. "/wallet". */
  link: string | null;
  createdAt: ISODate;
  read: boolean;
}

/* ---------------------------------------------------------------- tasks & points */

export type TaskStatus = 'locked' | 'open' | 'pending' | 'verified' | 'trusted' | 'revoked' | 'skipped';

export interface TaskDTO {
  id: TaskId;
  title: string;
  pts: number;
  icon: TaskIcon;
  group: TaskGroup;
  skippable: boolean;
  auto: boolean;
  status: TaskStatus;
}

export interface PointsDTO {
  total: number;
  score: number;
  ledger: number;
  held: number;
  tier: string;
  tierIndex: number;
  nextTier: string | null;
  toNext: number;
  progress: number;
  rank: number;
  /** Points that can be staked in battles (everything except score points). */
  earned: number;
}

export interface TasksResponse {
  points: PointsDTO;
  tasks: TaskDTO[];
  inviteLink: string;
  invitesCredited: number;
}

/* ---------------------------------------------------------------- wallet */

export interface HoldingDTO {
  market: MarketDTO;
  units: Units;
  /** Sell value after fees, capped so the creator's locked key is never counted. */
  valueWei: Wei;
}

export interface ActivityDTO {
  id: string;
  label: string;
  /** Signed: positive is money in. */
  amountWei: Wei;
  createdAt: ISODate;
  txHash: string | null;
}

export interface EarningsDTO {
  creatorWei: Wei;
  holderWei: Wei;
  referralWei: Wei;
  /** creatorWei + holderWei + referralWei: what one claim() pays out now. */
  totalWei: Wei;
  claimedWei: Wei;
  /** Subjects to pass to SwayKeys.claim(subjects) so holder rewards are settled. */
  claimSubjects: Address[];
}

export interface WalletDTO {
  address: Address;
  kind: 'embedded' | 'external';
  cashWei: Wei;
  keysValueWei: Wei;
  earnings: EarningsDTO;
  keys: { units: Units; markets: number };
  holdings: HoldingDTO[];
  activity: ActivityDTO[];
}

/* ---------------------------------------------------------------- leaderboard, battles, genesis */

export type LeaderboardTab = 'points' | 'creators' | 'stakers' | 'fighters';

export interface LeaderboardRow {
  rank: number;
  user: UserRef;
  points: number;
  /** Points won in battles. */
  won: number;
  feesWei: Wei;
  /** $SWAY staked (whole tokens). */
  staked: number;
  tier: string;
  me: boolean;
}

export interface LeaderboardResponse {
  rows: LeaderboardRow[];
  me: LeaderboardRow | null;
}

export type BattleStatus = 'pending' | 'live' | 'reading' | 'settled' | 'declined' | 'expired';

export interface BattleDTO {
  id: string;
  a: MarketDTO;
  b: MarketDTO | null;
  theme: string;
  tag: string;
  stake: number;
  status: BattleStatus;
  endsAt: ISODate | null;
  /** Live engagement rates (0..1). */
  erA: number;
  erB: number;
  poolA: number;
  poolB: number;
  winner: 'a' | 'b' | 'draw' | null;
  myBacking: { side: 'a' | 'b'; amount: number } | null;
  /** True when the viewer is the challenged side and can accept/decline. */
  canRespond: boolean;
}

export interface BattlesResponse {
  weeklyPool: number;
  treasuryFeePct: number;
  battles: BattleDTO[];
}

export interface CreateBattleBody {
  /** Handle or empty for an open challenge. */
  opponent?: string;
  theme: string;
  stake: number;
}

export interface BackBody {
  side: 'a' | 'b';
  amount: number;
}

export interface GenesisRow {
  rank: number;
  user: UserRef;
  points: number;
  sharePct: number;
}

export interface GenesisResponse {
  snapshotAt: ISODate;
  frozen: boolean;
  me: { rank: number; points: number; inCut: boolean; sharePct: number; toCut: number } | null;
  /** Shares for ranks 1, 10, 50, 100, 250, 500. */
  split: Array<{ rank: number; sharePct: number }>;
  top: GenesisRow[];
}

export interface LaunchpadResponse {
  symbol: string;
  score: number | null;
  startCapUsd: number | null;
  launched: boolean;
  tokenAddress: Address | null;
}

/* ---------------------------------------------------------------- session & config */

export interface MeDTO {
  user: UserRef & { id: string; memberNo: number; score: number; reachValue: number; followers: number };
  wallet: { address: Address; kind: 'embedded' | 'external' } | null;
  /** Your own key market, once opened onchain. */
  market: { subject: Address; opened: boolean } | null;
  points: PointsDTO;
  stakingLevel: number;
  unreadNotifications: number;
  unreadMessages: number;
}

export interface ConfigDTO {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  contracts: { swayKeys: Address | null; swayStaking: Address | null; genesisPass: Address | null; fanEscrow: Address | null; launchpad: Address | null };
  ethUsd: number;
  snapshotAt: ISODate;
  auth: { x: boolean; dev: boolean };
  wallets: { embedded: 'privy' | 'cdp' | 'burner'; walletConnectProjectId: string | null };
  /** Contracts are unaudited: mainnet stays off until the audit is published. */
  mainnet: boolean;
}

export interface DevLoginBody {
  handle: string;
  followers?: number;
  /** Inviter handle captured from /i/:handle or ?ref= (same as GET /api/auth/x/start?ref=). */
  ref?: string;
}

export interface PriceResponse {
  ethUsd: number;
  /** 'live' when the workers' Redis price is fresh, 'fallback' when ETH_USD_FALLBACK is used. */
  source: 'live' | 'fallback';
}

/** Optional body of POST /api/wallet/nonce. With `address` the message comes back filled in. */
export interface WalletNonceBody {
  address?: Address;
}

export interface WalletNonceResponse {
  nonce: string;
  message: string;
}

export interface WalletLinkBody {
  address: Address;
  signature: `0x${string}`;
  kind: 'embedded' | 'external';
}

/** Onboarding steps after X sign-in (the "Scoring @handle" modal). */
export interface OnboardingStatus {
  profile: boolean;
  engagement: boolean;
  scored: boolean;
  wallet: boolean;
  market: boolean;
  marketTx: string | null;
}

/* ---------------------------------------------------------------- websocket */

export type WsClientMessage =
  | { type: 'subscribe'; channel: 'room'; handle: string }
  | { type: 'unsubscribe'; channel: 'room'; handle: string }
  | { type: 'subscribe'; channel: 'dm'; threadId: string }
  | { type: 'ping' };

export type WsServerMessage =
  | { type: 'trade'; data: TradeDTO }
  | { type: 'notification'; data: NotificationDTO }
  | { type: 'room'; handle: string; data: MessageDTO }
  | { type: 'dm'; threadId: string; data: MessageDTO }
  | { type: 'market'; data: Pick<MarketDTO, 'subject' | 'handle' | 'supplyUnits' | 'priceWei' | 'holders' | 'volumeWei' | 'change'> }
  | { type: 'price'; ethUsd: number }
  | { type: 'pong' };

/* ---------------------------------------------------------------- internal event bus */

/** Redis pub/sub channel the workers publish to and the API WebSocket hub subscribes to. */
export const BUS_CHANNEL = 'sway:events';

/**
 * Workers publish ids only; the API hub loads the row, maps it to a DTO and fans it out
 * (trades and markets to everyone, notifications to their recipient).
 */
export type BusEvent =
  | { kind: 'trade'; tradeId: string }
  | { kind: 'market'; marketId: string }
  | { kind: 'notification'; notificationId: string }
  | { kind: 'price'; ethUsd: number }
  /** RoomMessage id: pushed to sockets subscribed to that room whose user has access. */
  | { kind: 'room'; messageId: string }
  /** DmMessage id: pushed to both participants. */
  | { kind: 'dm'; messageId: string };

/* ---------------------------------------------------------------- route table */

/**
 * Every route the web app calls. Path params are :name. Q = query, B = body, R = response.
 * Kept as data so both sides (and tests) can check coverage.
 */
export const ROUTES = {
  config: 'GET /api/config',
  price: 'GET /api/price',
  me: 'GET /api/me',
  xStart: 'GET /api/auth/x/start',
  xCallback: 'GET /api/auth/x/callback',
  devLogin: 'POST /api/auth/dev',
  logout: 'POST /api/auth/logout',
  onboarding: 'GET /api/onboarding',
  walletNonce: 'POST /api/wallet/nonce',
  walletLink: 'POST /api/wallet/link',
  openMarket: 'POST /api/onboarding/market',
  feed: 'GET /api/feed',
  createPost: 'POST /api/posts',
  post: 'GET /api/posts/:id',
  like: 'POST /api/posts/:id/like',
  repost: 'POST /api/posts/:id/repost',
  liveTrades: 'GET /api/trades',
  search: 'GET /api/search',
  explore: 'GET /api/explore',
  markets: 'GET /api/markets',
  profile: 'GET /api/users/:handle',
  profilePosts: 'GET /api/users/:handle/posts',
  holders: 'GET /api/users/:handle/holders',
  profileTrades: 'GET /api/users/:handle/trades',
  room: 'GET /api/users/:handle/room',
  roomPost: 'POST /api/users/:handle/room',
  follow: 'POST /api/users/:handle/follow',
  subscribe: 'POST /api/users/:handle/subscribe',
  tip: 'POST /api/users/:handle/tip',
  claimRequest: 'POST /api/users/:handle/claim-request',
  notifications: 'GET /api/notifications',
  readAll: 'POST /api/notifications/read-all',
  readOne: 'POST /api/notifications/:id/read',
  messages: 'GET /api/messages',
  dmOpen: 'POST /api/messages/dm',
  dm: 'GET /api/messages/dm/:id',
  dmSend: 'POST /api/messages/dm/:id',
  tasks: 'GET /api/tasks',
  taskVerify: 'POST /api/tasks/:id/verify',
  taskSkip: 'POST /api/tasks/:id/skip',
  wallet: 'GET /api/wallet',
  withdrawLog: 'POST /api/wallet/activity',
  faucet: 'POST /api/dev/faucet',
  leaderboard: 'GET /api/leaderboard',
  battles: 'GET /api/battles',
  createBattle: 'POST /api/battles',
  respondBattle: 'POST /api/battles/:id/respond',
  back: 'POST /api/battles/:id/back',
  genesis: 'GET /api/genesis',
  launchpad: 'GET /api/launchpad',
} as const;

/**
 * Query/body/response map per route key, for typed clients:
 *   price:                                                              R PriceResponse
 *   me:            (401 auth_required for guests)                       R MeDTO
 *   xStart:        Q { redirect?: string (path); ref?: string (inviter handle) }  302 to X; callback 302s to
 *                  `${WEB_URL}${redirect || '/'}?onboard=1` (or ?auth_error=<code>)
 *   logout:                                                             R { ok: true }
 *   feed:          Q { tab: FeedTab; cursor?: string }                 R FeedResponse
 *   createPost:    B CreatePostBody                                      R PostDTO
 *   like/repost:                                                         R { liked|reposted: boolean; count: number }
 *   liveTrades:    Q { limit?: number }                                  R TradeDTO[]
 *   search:        Q { q: string }                                       R SearchResponse
 *   explore:       Q { tab: ExploreTab; sort?: ExploreSort; q?: string } R ExploreResponse
 *   markets:       Q { tab: MarketCategory }                             R MarketsResponse
 *   profile:                                                             R ProfileDTO
 *   profilePosts:                                                        R PostDTO[]
 *   holders:                                                             R HolderDTO[]
 *   profileTrades:                                                       R TradeDTO[]
 *   room:                                                                R RoomResponse
 *   roomPost:      B { text: string }                                    R MessageDTO
 *   follow:                                                              R { following: boolean }
 *   subscribe/tip: B { txHash: string }                                  R { ok: true }
 *   claimRequest:  B { kind: 'claim' | 'takedown'; contact: string; note?: string } R { ok: true }
 *   notifications: Q { tab: NotificationTab }                            R NotificationDTO[]
 *   readAll/readOne:                                                     R { ok: true; unread: number }
 *   messages:                                                            R MessagesResponse
 *   dmOpen:        B { handle: string }                                  R ThreadDTO
 *   dm:                                                                  R DmResponse
 *   dmSend:        B { text: string }                                    R MessageDTO
 *   tasks:                                                               R TasksResponse
 *   taskVerify/Skip:                                                     R TaskDTO
 *   wallet:                                                              R WalletDTO
 *   withdrawLog:   B { label: string; amountWei: Wei; txHash: string }   R ActivityDTO
 *   faucet:        (dev chains only)                                     R { txHash: string }
 *   leaderboard:   Q { tab: LeaderboardTab }                             R LeaderboardResponse
 *   battles:                                                             R BattlesResponse
 *   createBattle:  B CreateBattleBody                                    R BattleDTO
 *   respondBattle: B { accept: boolean }                                 R BattleDTO
 *   back:          B BackBody                                            R BattleDTO
 *   genesis:                                                             R GenesisResponse
 *   launchpad:                                                           R LaunchpadResponse
 *   devLogin:      B DevLoginBody                                        R MeDTO
 *   walletNonce:   B WalletNonceBody (optional)                          R WalletNonceResponse
 *                  The message contains the line "Address: {address}". Without body.address the client
 *                  replaces "{address}" with the exact `address` string it then sends to walletLink and
 *                  signs the result (personal_sign / EIP-191). Nonces are single-use and expire in 10 min.
 *   walletLink:    B WalletLinkBody                                      R MeDTO
 *                  409 wallet_exists (member already has another wallet) / wallet_taken (address belongs to
 *                  another member); 400 bad_signature / nonce_expired.
 *   openMarket:                                                          R OnboardingStatus
 *   onboarding:                                                          R OnboardingStatus
 */
export type RouteKey = keyof typeof ROUTES;

/* ================================================================================================
 * Workstream sections. New DTOs and route tables go in the section of the workstream that owns them
 * (one vertical slice each: db → api → web). Each section has its own route table so they can be
 * edited independently; typed clients cover ROUTES plus every *_ROUTES table.
 * ============================================================================================== */

/* ---------------------------------------------------------------- [A] wallets & funding */

/* ---------------------------------------------------------------- [B] social, moderation, account & admin */

/* ---------------------------------------------------------------- [C] launchpad, staking & genesis */
