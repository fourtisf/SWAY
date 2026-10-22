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
  /** The official @swaydotfamily account (black logo avatar, gold badge). */
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
  /** [C] Once a snapshot exists: its id (GET /api/genesis/snapshots/:id, /genesis/list/:id) and list hash. */
  snapshotId?: string;
  listHash?: string;
}

export interface LaunchpadResponse {
  symbol: string;
  score: number | null;
  startCapUsd: number | null;
  launched: boolean;
  tokenAddress: Address | null;
  /** [C] Terms the attestation would sign (signed-in member with an opened market, before launch). */
  terms?: LaunchTermsDTO;
  /** [C] The launched token, read live from SwayLaunchpad. */
  token?: LaunchTokenDTO;
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
  contracts: {
    swayKeys: Address | null;
    swayStaking: Address | null;
    genesisPass: Address | null;
    fanEscrow: Address | null;
    launchpad: Address | null;
    /** [D] SwayDrops (creator airdrops to holders). */
    drops?: Address | null;
  };
  ethUsd: number;
  snapshotAt: ISODate;
  auth: { x: boolean; dev: boolean };
  /** 'off' on mainnet when the provider is the in-browser burner: its key lives in browser storage, which isn't
   *  fit for real funds. Only wallet apps can be connected then. */
  wallets: { embedded: 'privy' | 'cdp' | 'burner' | 'off'; walletConnectProjectId: string | null };
  /** Contracts are unaudited: mainnet stays off until the audit is published. */
  mainnet: boolean;
  /** The token @swaydotfamily launched on the launchpad ($SWAY), null until it's live. */
  swayToken: Address | null;
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

/**
 * Operator-signed SwayKeys.Member permit (EIP-712, domain "SwayKeys" v1). Joining sends no transaction: the
 * first buy that needs a member's market, fan-market claim or referrer onchain carries the permit.
 */
export interface MemberPermit {
  /** open: the member's own market; claim: their X account's fan market; referrer: only who invited them. */
  kind: 'open' | 'claim' | 'referrer';
  wallet: Address;
  /** uint64 X user id as a decimal string; "0" = referrer only. */
  xId: string;
  /** Zero address = none. */
  referrer: Address;
  /** Unix seconds. */
  deadline: number;
  signature: `0x${string}`;
}

export interface TradePermitsBody {
  /** Market about to be bought. */
  subject: Address;
  /** Wallet that will send the buy. */
  trader: Address;
}

export interface TradePermitsResponse {
  permits: MemberPermit[];
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
  tradePermits: 'POST /api/trade/permits',
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
 *   faucet:        (dev chains only)                                     R { txHash: string; swayTxHash?: string } ([C] + 10,000 $SWAY)
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
 *   tradePermits:  B TradePermitsBody                                    R TradePermitsResponse
 *                  Permits the buy must carry (SwayKeys.registerAndBuy); empty when buy() is enough.
 *                  403 not_your_wallet when `trader` isn't one of the viewer's wallets.
 *   onboarding:                                                          R OnboardingStatus
 */
export type RouteKey = keyof typeof ROUTES;

/* ================================================================================================
 * Workstream sections. New DTOs and route tables go in the section of the workstream that owns them
 * (one vertical slice each: db → api → web). Each section has its own route table so they can be
 * edited independently; typed clients cover ROUTES plus every *_ROUTES table.
 * ============================================================================================== */

/* ---------------------------------------------------------------- [A] wallets & funding */

/*
 * A member has one account wallet (Wallet: owns their key market, receives tips and the Genesis pass, fixed
 * once the market is open) and up to MAX_LINKED_WALLETS more (LinkedWallet, added by signature). An address
 * belongs to at most one member. Keys held across all of a member's wallets count together (rooms,
 * holder posts, heldUnits, Following, Messages, the auto task, points, the wallet page).
 */

export const MAX_LINKED_WALLETS = 10;
export const WALLET_LABEL_MAX = 32;

/**
 * Logo key of the wallet app used to connect: 'sway' (the embedded Sway wallet), one of WALLET_APPS, or the
 * EIP-6963 rdns of another browser wallet (e.g. 'io.metamask'). null for wallets linked before it was stored.
 */
export type WalletConnector = string;

/** The curated wallet apps the connect modal always lists (logos come from RainbowKit's wallet definitions). */
export const WALLET_APPS = ['metaMask', 'coinbaseWallet', 'rabby', 'rainbow', 'trust', 'okx', 'phantom', 'zerion', 'walletConnect'] as const;
export type WalletApp = (typeof WALLET_APPS)[number];

/** Allowed shape of a connector key (RainbowKit id or rdns). */
export const WALLET_CONNECTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface WalletInfoDTO {
  address: Address;
  kind: 'embedded' | 'external';
  connector: WalletConnector | null;
  /** Member-chosen name (linked wallets only; the account wallet has none). */
  label: string | null;
  /** The account wallet (first in every list). */
  account: boolean;
  createdAt: ISODate;
}

export interface WalletBalanceDTO extends WalletInfoDTO {
  cashWei: Wei;
  /** Sell value of this wallet's keys (own market excluded), as in WalletDTO. */
  keysValueWei: Wei;
  keys: { units: Units; markets: number };
  /** What SwayKeys.claim(claimSubjects) pays this address now. */
  earnings: EarningsDTO;
}

export interface WalletsResponse {
  /** Account wallet first, then linked wallets oldest first. */
  wallets: WalletBalanceDTO[];
  maxLinked: number;
}

/** POST /api/wallets/link: add another wallet (signature over the /api/wallets/nonce message). */
export interface LinkWalletBody {
  address: Address;
  signature: `0x${string}`;
  connector: WalletConnector;
  label?: string;
  /** 'embedded' for another Sway wallet created in the browser. Default 'external'. */
  kind?: 'embedded' | 'external';
}

export interface WalletLabelBody {
  /** null or '' clears it. */
  label: string | null;
}

export interface FaucetBody {
  /** One of the member's wallets (default: the account wallet). */
  address?: Address;
}

/* Fields [A] adds to the shared DTOs above (merged by TypeScript into the interfaces of the same name). */

export interface MeDTO {
  /** Every wallet of the member: account first, then linked ones. */
  wallets?: WalletInfoDTO[];
}

export interface WalletLinkBody {
  /** Wallet app used (logo key), see WalletConnector. */
  connector?: WalletConnector;
}

export interface HoldingDTO {
  /** The wallet that holds these units (WalletDTO lists one row per wallet and market). */
  address?: Address;
  /** Wei paid for the units held, fees included (average-cost basis from the mirror). */
  costBasisWei?: Wei;
  /** Average cost per key (100 units). */
  avgCostWei?: Wei;
  /** valueWei − costBasisWei (signed). */
  unrealizedPnlWei?: Wei;
  /** Realized on sells so far (signed). */
  realizedPnlWei?: Wei;
}

export interface WalletDTO {
  /** Per-wallet breakdown; the top-level numbers are sums across these. */
  wallets?: WalletBalanceDTO[];
}

export interface ProfileDTO {
  /** The viewer's units of this market per wallet (only wallets holding some); heldUnits is their sum. */
  heldBy?: Array<{ address: Address; units: Units }>;
}

export interface ConfigDTO {
  /** Testnet faucet page (FAUCET_URL), shown in the Deposit modal. */
  faucetUrl?: string | null;
}

export const WALLET_ROUTES = {
  wallets: 'GET /api/wallets',
  walletsNonce: 'POST /api/wallets/nonce',
  walletsLink: 'POST /api/wallets/link',
  walletsLabel: 'PATCH /api/wallets/:address',
  walletsRemove: 'DELETE /api/wallets/:address',
  walletsMakeAccount: 'POST /api/wallets/:address/account',
} as const;

/**
 * Q / B / R per WALLET_ROUTES key (all need a session; :address is any case, stored lowercase):
 *   wallets:       R WalletsResponse
 *   walletsNonce:  B WalletNonceBody (optional)                         R WalletNonceResponse
 *                  Same rules as walletNonce, with its own nonce: the message names the handle, the address
 *                  ("Address: {address}") and the nonce.
 *   walletsLink:   B LinkWalletBody                                     R MeDTO
 *                  409 no_wallet (no account wallet yet) / wallet_taken (address belongs to another member,
 *                  in either table) / wallet_is_account (it is your account wallet) / wallet_limit (10 linked);
 *                  400 bad_signature / nonce_expired. Linking an address you already linked is a no-op.
 *   walletsLabel:  B WalletLabelBody                                    R WalletInfoDTO
 *                  404 wallet_not_found (the account wallet can be renamed too)
 *   walletsRemove:                                                      R MeDTO
 *                  404 wallet_not_found; 409 account_wallet (the account wallet can't be removed)
 *   walletsMakeAccount:                                                 R MeDTO
 *                  The linked wallet becomes the account wallet (it then owns the key market) and the old
 *                  account wallet stays linked. Only while the key market isn't onchain yet (onchain it's
 *                  bound to its wallet). 404 wallet_not_found; 409 account_wallet / market_onchain / launched
 * Also: walletLink (account wallet) takes WalletLinkBody.connector; faucet takes FaucetBody (optional);
 * the wallet route answers WalletDTO summed across every wallet, with `wallets` per wallet.
 */
export type WalletRouteKey = keyof typeof WALLET_ROUTES;

/* ---------------------------------------------------------------- [B] social, moderation, account & admin */

/*
 * Fields [B] adds to the shared DTOs above. TypeScript merges these declarations into the interfaces of
 * the same name, so the additions stay in this section.
 */
export interface PostDTO {
  /** Image URLs (/api/uploads/<name>), at most POST_MEDIA_MAX. Always empty while `locked`. */
  media: string[];
  /** Hidden by a moderator: only the author and admins still see it. */
  hidden: boolean;
  /** End of the paid boost window; `boosted` is true while it runs (and always for promoted posts). */
  boostedUntil: ISODate | null;
}

export interface CreatePostBody {
  /** URLs returned by POST /api/uploads; only the author's own uploads. */
  media?: string[];
}

export interface PostDetailResponse {
  /** Ancestors of `post`, root first. */
  parents: PostDTO[];
  /** The chain above `parents` stops at a post that was deleted, hidden or blocked. */
  parentUnavailable: boolean;
  /** Replies to `replies` (one level of nesting), oldest first; group them by parentId. */
  nested: PostDTO[];
}

export interface ProfileDTO {
  /** The viewer blocked this account. */
  blocked?: boolean;
  /** The owner deleted the account; the market stays live under "Deleted account". */
  deleted?: boolean;
}

export interface MeDTO {
  /** Can open /admin (moderation and operations). */
  isAdmin?: boolean;
}

export const POST_MEDIA_MAX = 4;
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const UPLOAD_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type UploadMime = (typeof UPLOAD_MIMES)[number];
/** Default price of a 24h boost (the API reads BOOST_USD). */
export const BOOST_USD_DEFAULT = 10;
export const BOOST_HOURS = 24;
export const REPORT_REASONS = ['spam', 'abuse', 'impersonation', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
/** Typed confirmation for DELETE /api/me. */
export const deleteConfirmText = (handle: string) => `delete @${handle}`;

export interface UploadDTO {
  /** Pass this in CreatePostBody.media. */
  url: string;
  name: string;
  mime: UploadMime;
  bytes: number;
}

export interface UploadResponse {
  uploads: UploadDTO[];
}

export interface BoostQuoteDTO {
  usd: number;
  /** usd at the current ETH price; send at least this (2% tolerance). */
  wei: Wei;
  /** Where the payment goes (SwayKeys.treasury() or TREASURY_ADDRESS). Null when boosts are unavailable. */
  treasury: Address | null;
  hours: number;
}

export interface BoostResponse {
  post: PostDTO;
}

export interface ReportBody {
  /** Exactly one of postId / handle. */
  postId?: string;
  handle?: string;
  reason: ReportReason;
  note?: string;
}

export type HistoryRange = '1h' | '1d' | '7d';

export interface PriceHistoryResponse {
  range: HistoryRange;
  /** Oldest first: the price at the start of the range, priceWei(supplyAfter) at each trade, then now. */
  points: Array<{ t: ISODate; priceWei: Wei }>;
}

/** Public share card (/card/:handle and its OG image). */
export interface CardDTO extends UserRef {
  score: number;
  reachValue: number;
  followers: number;
  tier: string;
  memberNo: number | null;
  /** Key price, null without a market. */
  priceWei: Wei | null;
}

export interface AccountDTO {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  /** Verified on X. */
  verified: boolean;
  memberNo: number | null;
  joinedAt: ISODate | null;
  isAdmin: boolean;
  /** Accounts you blocked, newest first. */
  blocked: UserRef[];
}

/** GET /api/me/export: everything Sway stores about you, as one JSON file. */
export interface AccountExport {
  exportedAt: ISODate;
  profile: {
    xId: string;
    handle: string;
    name: string;
    avatarUrl: string | null;
    bio: string;
    followers: number;
    verified: boolean;
    score: number;
    reachValue: number;
    scoreInputs: unknown;
    memberNo: number | null;
    joinedAt: ISODate | null;
    tier: string;
  };
  posts: Array<{
    id: string;
    text: string;
    visibility: Visibility;
    media: string[];
    parentId: string | null;
    createdAt: ISODate;
    deletedAt: ISODate | null;
    hiddenAt: ISODate | null;
    boostedUntil: ISODate | null;
  }>;
  dmsSent: Array<{ id: string; to: string; text: string; createdAt: ISODate }>;
  notifications: Array<{ id: string; type: NotificationType; body: RichText; link: string | null; createdAt: ISODate; read: boolean }>;
  pointsLedger: Array<{ kind: string; amount: number; ref: string; createdAt: ISODate }>;
  wallets: Array<{ address: Address; kind: 'embedded' | 'external'; linked: boolean; createdAt: ISODate }>;
  trades: Array<{
    txHash: string;
    logIndex: number;
    market: string;
    subject: Address;
    trader: Address;
    isBuy: boolean;
    units: Units;
    baseWei: Wei;
    totalWei: Wei;
    supplyAfter: Units;
    ts: ISODate;
  }>;
}

export interface DeleteAccountBody {
  /** Must equal deleteConfirmText(handle). */
  confirm: string;
}

/* admin */

export type ReportStatus = 'open' | 'actioned' | 'dismissed';
export type AdminReportAction = 'hide' | 'dismiss' | 'flag';

export interface AdminReportDTO {
  id: string;
  reason: ReportReason;
  note: string | null;
  status: ReportStatus;
  createdAt: ISODate;
  reporter: UserRef;
  /** Full post (any visibility) for post reports; null for account reports. */
  post: {
    id: string;
    text: string;
    media: string[];
    visibility: Visibility;
    createdAt: ISODate;
    hidden: boolean;
    deleted: boolean;
  } | null;
  /** The reported account (the author, for post reports). */
  target: (UserRef & { botFlag: boolean }) | null;
}

export interface AdminClaimDTO {
  id: string;
  kind: 'claim' | 'takedown';
  contact: string;
  note: string | null;
  status: 'open' | 'resolved';
  createdAt: ISODate;
  market: UserRef & { subject: Address; halted: boolean };
  from: UserRef | null;
}

export interface AdminMemberDTO extends UserRef {
  id: string;
  memberNo: number | null;
  joinedAt: ISODate | null;
  followers: number;
  score: number;
  botFlag: boolean;
  botReason: string | null;
  isAdmin: boolean;
  deleted: boolean;
}

export interface AdminMarketDTO extends UserRef {
  subject: Address;
  category: MarketCategory;
  fan: boolean;
  claimed: boolean;
  opened: boolean;
  /** Mirror of SwayKeys (the indexer applies MarketHalted). */
  halted: boolean;
  supplyUnits: Units;
  holders: number;
}

export interface OpenFanMarketBody {
  handle: string;
  /** name, xId and followers left out are read from X (app bearer token), along with the avatar. */
  name?: string;
  /** Numeric X user id (uint64) as a string. */
  xId?: string;
  followers?: number;
  category: MarketCategory;
}

export interface AdminTxResult {
  txHash: string | null;
  /** 'skipped' when no SwayKeys/operator is configured (DB only). */
  status: 'success' | 'reverted' | 'pending' | 'skipped';
}

export const SOCIAL_ROUTES = {
  deletePost: 'DELETE /api/posts/:id',
  boostQuote: 'GET /api/boost',
  boostPost: 'POST /api/posts/:id/boost',
  pinPost: 'POST /api/posts/:id/pin',
  report: 'POST /api/reports',
  block: 'POST /api/users/:handle/block',
  upload: 'POST /api/uploads',
  uploadFile: 'GET /api/uploads/:name',
  priceHistory: 'GET /api/users/:handle/history',
  card: 'GET /api/users/:handle/card',
  account: 'GET /api/me/account',
  exportData: 'GET /api/me/export',
  deleteAccount: 'DELETE /api/me',
  adminReports: 'GET /api/admin/reports',
  adminResolveReport: 'POST /api/admin/reports/:id',
  adminHidePost: 'POST /api/admin/posts/:id/hide',
  adminClaims: 'GET /api/admin/claims',
  adminResolveClaim: 'POST /api/admin/claims/:id/resolve',
  adminMembers: 'GET /api/admin/members',
  adminBotFlag: 'POST /api/admin/members/:handle/bot',
  adminSetAdmin: 'POST /api/admin/members/:handle/admin',
  adminMarkets: 'GET /api/admin/markets',
  adminHaltMarket: 'POST /api/admin/markets/:handle/halt',
  adminOpenFanMarket: 'POST /api/admin/fan-markets',
} as const;

/**
 * Q / B / R per SOCIAL_ROUTES key (403 `forbidden` for every /api/admin route unless User.isAdmin):
 *   deletePost:         (author or admin; soft delete)                   R { ok: true }
 *   boostQuote:                                                          R BoostQuoteDTO
 *   boostPost:          B { txHash }  (author only)                      R BoostResponse
 *                       400 tx_not_found / tx_reverted / wrong_recipient / underpaid, 403 tx_not_yours,
 *                       409 tx_used / tx_pending
 *   pinPost:            B { pinned: boolean }  (the official account's top-level posts; by that account or an admin)
 *                                                                        R { pinned: boolean }; pinning unpins its others
 *                       400 not_pinnable, 403 not_yours
 *   report:             B ReportBody                                     R { ok: true }
 *   block:              (toggle)                                         R { blocked: boolean }
 *   upload:             multipart/form-data, 1–4 image files (jpeg/png/webp/gif by magic bytes, ≤ 5 MB each)
 *                                                                        R UploadResponse
 *                       400 bad_image / too_many_files, 413 too_large
 *   uploadFile:         the image bytes (long-lived cache, nosniff, sandboxed CSP)
 *   priceHistory:       Q { range: HistoryRange }                         R PriceHistoryResponse
 *   card:                                                                R CardDTO
 *   account:                                                             R AccountDTO
 *   exportData:         (Content-Disposition: attachment)                R AccountExport
 *   deleteAccount:      B DeleteAccountBody                              R { ok: true }; every session is revoked
 *   adminReports:       Q { status?: ReportStatus }                      R AdminReportDTO[]
 *   adminResolveReport: B { action: AdminReportAction }                  R AdminReportDTO
 *   adminHidePost:      B { hidden: boolean }                            R { hidden: boolean }
 *   adminClaims:        Q { status?: 'open' | 'resolved' }               R AdminClaimDTO[]
 *   adminResolveClaim:                                                   R AdminClaimDTO
 *   adminMembers:       Q { q?: string }                                 R AdminMemberDTO[]
 *   adminBotFlag:       B { flagged: boolean }                           R AdminMemberDTO
 *   adminSetAdmin:      B { admin: boolean }                             R AdminMemberDTO
 *   adminMarkets:       Q { q?: string }                                 R AdminMarketDTO[]
 *   adminHaltMarket:    B { halted: boolean }                            R AdminTxResult & { halted: boolean }
 *   adminOpenFanMarket: B OpenFanMarketBody                              R AdminTxResult & { market: AdminMarketDTO }
 *                       400 x_lookup_unavailable (no bearer token) / x_lookup_failed, 404 x_user_not_found
 */
export type SocialRouteKey = keyof typeof SOCIAL_ROUTES;

/* ---------------------------------------------------------------- [C] launchpad, staking & genesis */

/** Token amounts are 18-decimal token units as decimal strings (like Wei). */
export type TokenAmount = string;

/** One key holder's share of the launch airdrop (10% of supply, pro rata to keys held). */
export interface LaunchAirdropShareDTO {
  /** null for an address that belongs to no member. */
  user: UserRef | null;
  address: Address;
  /** Keys held that count (the creator's locked first key is excluded). */
  units: Units;
  amount: TokenAmount;
  sharePct: number;
}

/** What POST /api/launchpad/attest would sign right now. */
export interface LaunchTermsDTO {
  name: string;
  /** Without the "$". */
  symbol: string;
  startCapWei: Wei;
  startCapUsd: number;
  graduationCapWei: Wei;
  graduationCapUsd: number;
  totalSupply: TokenAmount;
  holderAllocation: TokenAmount;
  /** Largest first. Empty never: with no other holders the creator's account wallet gets the whole 10%. */
  holders: LaunchAirdropShareDTO[];
  creatorOnly: boolean;
}

export interface LaunchTokenDTO {
  address: Address;
  name: string;
  symbol: string;
  creator: UserRef;
  creatorAddress: Address;
  /** Wei per whole token. */
  priceWei: Wei;
  marketCapWei: Wei;
  startCapWei: Wei;
  graduationCapWei: Wei;
  /** 0..1 from start cap to graduation cap. */
  progress: number;
  virtualEthWei: Wei;
  /** Real ETH in the curve. */
  ethReserveWei: Wei;
  /** Tokens still on the curve. */
  tokenReserve: TokenAmount;
  volumeWei: Wei;
  /** Wallets holding the token (not the launchpad, its pool or burn addresses), from the indexer. */
  holders: number;
  graduated: boolean;
  /** Uniswap V2 pair the curve's liquidity moved into at graduation (trade it there); null before. */
  pool: Address | null;
  /** Unclaimed 1% creator fees (SwayLaunchpad.creatorFees). */
  creatorFeesWei: Wei;
  /** The viewer's balance and launchpad allowance per wallet (account wallet first, then linked wallets). */
  balances: Array<{ address: Address; balance: TokenAmount; allowance: TokenAmount }>;
  isMine: boolean;
  launchTx: string | null;
  launchedAt: ISODate | null;
  /** Explorer page of the token, when the chain has an explorer. */
  explorer: string | null;
  /** 'chain' when read live from SwayLaunchpad, 'mirror' when the chain was unreachable. */
  source: 'chain' | 'mirror';
}

/** GET /api/launchpad/tokens/:handle: any creator's token (or why there is none yet). */
export interface LaunchTokenResponse {
  creator: UserRef & { score: number };
  /** With the "$", like LaunchpadResponse.symbol. */
  symbol: string;
  launched: boolean;
  token: LaunchTokenDTO | null;
}

/** POST /api/launchpad/attest: the operator-signed terms to pass to SwayLaunchpad.launch. */
/** The creator's own token name and ticker (without "$"); the suggested ones when left out. */
export interface LaunchAttestBody {
  name?: string;
  symbol?: string;
}

export interface LaunchAttestation {
  launchpad: Address;
  /** The account wallet that owns the key market; it must send the launch transaction. */
  creator: Address;
  name: string;
  symbol: string;
  startCapWei: Wei;
  graduationCapWei: Wei;
  airdropRoot: `0x${string}`;
  /** Unix seconds. */
  deadline: number;
  signature: `0x${string}`;
  holders: number;
  /** Nobody has bought the creator's keys yet: send SwayKeys.register(permit) first to open the market onchain. */
  permit: MemberPermit | null;
}

export interface AirdropAllocationDTO {
  token: Address;
  name: string;
  symbol: string;
  creator: UserRef;
  /** The wallet that owns the allocation and must send claimAirdrop. */
  address: Address;
  walletKind: 'account' | 'linked';
  amount: TokenAmount;
  proof: `0x${string}`[];
}

export interface AirdropsResponse {
  launchpad: Address | null;
  allocations: AirdropAllocationDTO[];
}

export interface StakingLevelDTO {
  level: number;
  name: string;
  /** Protocol-fee cut, e.g. 0.5 for −50%. */
  cut: number;
  thresholdWei: Wei;
  /** Post length limit at this level. */
  postMax: number;
}

export interface StakingResponse {
  /** false when SwayStaking isn't configured on this chain. */
  enabled: boolean;
  stakingAddress: Address | null;
  tokenAddress: Address | null;
  tokenSymbol: string;
  /** The viewer's account wallet (null for guests). */
  address: Address | null;
  balanceWei: Wei;
  allowanceWei: Wei;
  stakedWei: Wei;
  unstakingWei: Wei;
  unlockAt: ISODate | null;
  canWithdraw: boolean;
  level: number;
  /** Levels 1..4, ascending thresholds read from the contract. */
  levels: StakingLevelDTO[];
  pendingRewardsWei: Wei;
  totalStakedWei: Wei;
  cooldownSeconds: number;
}

export interface GenesisListRow {
  rank: number;
  user: UserRef;
  wallet: Address;
  walletShort: string;
  points: number;
  sharePct: number;
  /** Pool units (18-decimal token units) for this rank. */
  units: TokenAmount;
  minted: boolean;
  mintTx: string | null;
  me: boolean;
}

export interface GenesisListResponse {
  snapshotId: string;
  takenAt: ISODate;
  listHash: string;
  poolUnits: TokenAmount;
  published: boolean;
  count: number;
  minted: number;
  rows: GenesisListRow[];
}

/**
 * [C] routes. Q/B/R as in ROUTES:
 *   launchAttest:         (member with an opened market, not launched)       B LaunchAttestBody R LaunchAttestation
 *                         400 bad_name / bad_symbol; 409 no_wallet / no_market / already_launched / symbol_taken;
 *                         503 launch_unavailable / signer_mismatch
 *   launchToken:                                                             R LaunchTokenResponse
 *   launchAirdrops:       (viewer's unclaimed allocations across all their wallets; claimed ones drop out
 *                         as soon as SwayLaunchpad.airdropClaimed reads true)  R AirdropsResponse
 *   staking:                                                                 R StakingResponse
 *   genesisLatest:        (404 no_snapshot before the freeze)                R GenesisListResponse
 *   genesisSnapshot:                                                         R GenesisListResponse
 */
export const LAUNCH_ROUTES = {
  launchAttest: 'POST /api/launchpad/attest',
  launchToken: 'GET /api/launchpad/tokens/:handle',
  launchAirdrops: 'GET /api/launchpad/airdrops',
  staking: 'GET /api/staking',
  genesisLatest: 'GET /api/genesis/snapshots/latest',
  genesisSnapshot: 'GET /api/genesis/snapshots/:id',
} as const;

export type LaunchRouteKey = keyof typeof LAUNCH_ROUTES;

/* ---------------------------------------------------------------- [D] engagement & creator drops */

export interface ProfileDTO {
  /** Activity bond in effect (SwayKeys.creatorInactive): the 6% creator fee goes to holders. */
  creatorInactive?: boolean;
  /** The viewer's last buy in this market per wallet (lowercase address): sells within 24h pay the anti-dump fee. */
  lastBuyAt?: Record<string, ISODate>;
}

/** Per-member notification settings (User.notifPrefs). A muted type is hidden from the list and the badge. */
export interface NotificationPrefs {
  trade: boolean;
  mention: boolean;
  battle: boolean;
  points: boolean;
  /** Watchlist price alerts (delivered as `trade` notifications). */
  alerts: boolean;
  /** Web push for every unmuted type, on every browser the member subscribed. */
  push: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  trade: true,
  mention: true,
  battle: true,
  points: true,
  alerts: true,
  push: true,
};

export interface WatchDTO extends UserRef {
  priceWei: Wei;
  /** Percent alert threshold; 0 = watch only. */
  alertPct: number;
  baselineWei: Wei;
  /** Percent change of priceWei against baselineWei. */
  change: number;
  createdAt: ISODate;
}

export interface WatchlistResponse {
  items: WatchDTO[];
}

export interface WatchBody {
  /** 0 (no alerts) or 5..100. Default 10. */
  alertPct?: number;
}

export interface StreakDTO {
  days: number;
  checkedInToday: boolean;
  /** UTC day of the last check-in, "YYYY-MM-DD". */
  lastDay: string | null;
  /** Points a check-in pays now (0 once checked in today) and tomorrow if the streak holds. */
  nowPoints: number;
  nextPoints: number;
  perDay: number;
  capDays: number;
}

export interface ReferralRowDTO extends UserRef {
  status: 'pending' | 'credited' | 'rejected';
  reason: string | null;
  joinedAt: ISODate | null;
  creditedAt: ISODate | null;
  /** The invitee's curve volume on Sway (all their wallets). */
  volumeWei: Wei;
}

export interface ReferralsResponse {
  /** Invite link (`${WEB_URL}/?ref=<handle>`). */
  link: string;
  invited: number;
  credited: number;
  pending: number;
  /** Points from the invite ledger entries. */
  points: number;
  dailyCap: number;
  creditedToday: number;
  pointsPerInvite: number;
  /** Onchain referral earnings waiting in SwayKeys across the viewer's wallets (claim from the Wallet page). */
  referralPendingWei: Wei;
  /** Estimate of the referral fee halves your invitees generated (trader half of their trades, creator half of
   *  trades in their markets). */
  referralEarnedWei: Wei;
  rows: ReferralRowDTO[];
}

export interface PushConfigDTO {
  /** false when the server has no VAPID keys. */
  enabled: boolean;
  publicKey: string | null;
  /** Browsers subscribed for the viewer. */
  subscriptions: number;
}

export interface PushSubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface DropPlanBody {
  /** ETH to split across holders. */
  amountWei: Wei;
}

export interface DropAllocationDTO {
  address: Address;
  user: UserRef | null;
  amountWei: Wei;
  units: Units;
}

export interface DropPlanDTO {
  /** Pass to SwayDrops.create(root, durationSeconds) with msg.value = totalWei. */
  root: `0x${string}`;
  totalWei: Wei;
  holders: number;
  contract: Address;
  minDays: number;
  maxDays: number;
  /** Largest allocations first (at most 20). */
  top: DropAllocationDTO[];
}

export interface CreatorDropDTO {
  id: number;
  creator: UserRef;
  totalWei: Wei;
  claimedWei: Wei;
  holders: number;
  claims: number;
  expiresAt: ISODate;
  reclaimed: boolean;
  createdAt: ISODate;
  txHash: string;
  /** The viewer is the creator and the drop expired with ETH left. */
  canReclaim: boolean;
}

export interface ClaimableDropDTO {
  id: number;
  creator: UserRef;
  /** The viewer's wallet that holds this allocation (claim from it). */
  address: Address;
  amountWei: Wei;
  proof: `0x${string}`[];
  expiresAt: ISODate;
  contract: Address;
}

/**
 * [D] routes. Q/B/R as in ROUTES (all need a session except userDrops):
 *   watchlist:                                                          R WatchlistResponse
 *   watch:          B WatchBody (upsert; baseline = current price)      R WatchDTO   404 not_found / 409 no_market
 *   unwatch:                                                            R { watching: false }
 *   streak:                                                             R StreakDTO
 *   checkIn:        (idempotent per UTC day; ledger kind `streak`)      R StreakDTO
 *   referrals:                                                          R ReferralsResponse
 *   notifPrefs:                                                         R NotificationPrefs
 *   setNotifPrefs:  B Partial<NotificationPrefs>                        R NotificationPrefs
 *   pushConfig:                                                         R PushConfigDTO
 *   pushSubscribe:  B PushSubscribeBody (https endpoints only)          R { ok: true }
 *   pushUnsubscribe: B { endpoint: string }                             R { ok: true }
 *   pushTest:       (sends a test notification to the viewer)          R { ok: true }
 *   dropPlan:       B DropPlanBody (creator with an opened market; holders pro rata to units across their
 *                   wallets, excluding the creator's own wallets, the fan escrow and bot-flagged members)
 *                                                                       R DropPlanDTO
 *                   400 bad_amount / 409 no_holders / 503 drops_unavailable
 *   userDrops:                                                          R CreatorDropDTO[]
 *   claimableDrops: (unclaimed, unexpired allocations across all the viewer's wallets) R ClaimableDropDTO[]
 */
export const ENGAGE_ROUTES = {
  watchlist: 'GET /api/watchlist',
  watch: 'PUT /api/users/:handle/watch',
  unwatch: 'DELETE /api/users/:handle/watch',
  streak: 'GET /api/streak',
  checkIn: 'POST /api/streak/check-in',
  referrals: 'GET /api/referrals',
  notifPrefs: 'GET /api/me/notification-prefs',
  setNotifPrefs: 'PUT /api/me/notification-prefs',
  pushConfig: 'GET /api/push',
  pushSubscribe: 'POST /api/push/subscribe',
  pushUnsubscribe: 'POST /api/push/unsubscribe',
  pushTest: 'POST /api/push/test',
  dropPlan: 'POST /api/drops/plan',
  userDrops: 'GET /api/users/:handle/drops',
  claimableDrops: 'GET /api/drops/claimable',
} as const;

export type EngageRouteKey = keyof typeof ENGAGE_ROUTES;
