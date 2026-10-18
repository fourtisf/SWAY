/**
 * Typed X API v2 reads used by Sway: profile + recent posts for scoring, task verification and battle reads.
 * Every function takes an XContext (token, budget, fetch) as its first argument; createXClient binds one.
 */
import { inputsFromX, score, type ScoreInputs, type ScoreResult, type XPostSample, type BattleMetrics } from '@sway/scoring';
import { xGet, type XContext } from './request';

export const USER_FIELDS = 'created_at,public_metrics,verified,verified_type,profile_image_url,description';
export const TWEET_FIELDS = 'public_metrics,created_at,referenced_tweets,entities,author_id';

export interface XUser {
  id: string;
  username: string;
  name: string;
  description: string;
  profileImageUrl: string | null;
  createdAt: string | null;
  followers: number;
  following: number;
  postCount: number;
  /** Any X checkmark (blue, business or government). */
  verified: boolean;
  verifiedType: string | null;
}

export interface XPost {
  id: string;
  text: string;
  authorId: string | null;
  createdAt: string;
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  bookmarks: number;
  impressions: number;
  /** Reply to another post. */
  isReply: boolean;
  /** Plain repost (retweet). */
  isRepost: boolean;
  isQuote: boolean;
  /** Ids of referenced posts by relation. */
  referenced: Array<{ type: 'replied_to' | 'retweeted' | 'quoted'; id: string }>;
  /** Lowercase, without '#'. */
  hashtags: string[];
}

interface RawUser {
  id: string;
  username: string;
  name: string;
  description?: string;
  profile_image_url?: string;
  created_at?: string;
  verified?: boolean;
  verified_type?: string;
  public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number };
}

interface RawTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  referenced_tweets?: Array<{ type: 'replied_to' | 'retweeted' | 'quoted'; id: string }>;
  entities?: { hashtags?: Array<{ tag: string }> };
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
    bookmark_count?: number;
    impression_count?: number;
  };
}

interface Page<T> {
  data?: T;
  meta?: { next_token?: string; result_count?: number };
  errors?: unknown[];
}

export function mapUser(u: RawUser): XUser {
  const vt = u.verified_type && u.verified_type !== 'none' ? u.verified_type : null;
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    description: u.description ?? '',
    // X serves 48px "_normal" images by default; the 400px variant reads better on cards.
    profileImageUrl: u.profile_image_url ? u.profile_image_url.replace('_normal.', '_400x400.') : null,
    createdAt: u.created_at ?? null,
    followers: u.public_metrics?.followers_count ?? 0,
    following: u.public_metrics?.following_count ?? 0,
    postCount: u.public_metrics?.tweet_count ?? 0,
    verified: !!u.verified || vt !== null,
    verifiedType: vt,
  };
}

export function mapPost(t: RawTweet): XPost {
  const refs = t.referenced_tweets ?? [];
  const m = t.public_metrics ?? {};
  return {
    id: t.id,
    text: t.text ?? '',
    authorId: t.author_id ?? null,
    createdAt: t.created_at ?? new Date(0).toISOString(),
    likes: m.like_count ?? 0,
    reposts: m.retweet_count ?? 0,
    replies: m.reply_count ?? 0,
    quotes: m.quote_count ?? 0,
    bookmarks: m.bookmark_count ?? 0,
    impressions: m.impression_count ?? 0,
    isReply: refs.some((r) => r.type === 'replied_to'),
    isRepost: refs.some((r) => r.type === 'retweeted'),
    isQuote: refs.some((r) => r.type === 'quoted'),
    referenced: refs.map((r) => ({ type: r.type, id: r.id })),
    hashtags: (t.entities?.hashtags ?? []).map((h) => h.tag.toLowerCase()),
  };
}

/** The signed-in user (needs a user access token). */
export async function getMe(ctx: XContext): Promise<XUser> {
  const res = await xGet<Page<RawUser>>(ctx, 'users/me', '/2/users/me', { 'user.fields': USER_FIELDS });
  if (!res.data) throw new Error('X /2/users/me returned no data');
  return mapUser(res.data);
}

export async function getUserByUsername(ctx: XContext, username: string): Promise<XUser | null> {
  const name = username.replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) return null;
  const res = await xGet<Page<RawUser>>(ctx, 'users/by/username', `/2/users/by/username/${name}`, { 'user.fields': USER_FIELDS });
  return res.data ? mapUser(res.data) : null;
}

export async function getUserById(ctx: XContext, id: string): Promise<XUser | null> {
  const res = await xGet<Page<RawUser>>(ctx, 'users/lookup', `/2/users/${encodeURIComponent(id)}`, { 'user.fields': USER_FIELDS });
  return res.data ? mapUser(res.data) : null;
}

export interface RecentPostsOptions {
  /** ISO time or Date: only posts created at or after it. */
  since?: Date | string;
  /** Leave out replies and/or reposts on the X side. */
  exclude?: Array<'replies' | 'retweets'>;
  /** Max pages of 100 to read (default: enough for n). */
  maxPages?: number;
}

/** The user's most recent posts, newest first (replies and reposts included and flagged unless excluded). */
export async function getRecentPosts(ctx: XContext, userId: string, n = 50, opts: RecentPostsOptions = {}): Promise<XPost[]> {
  const out: XPost[] = [];
  let token: string | undefined;
  const pages = opts.maxPages ?? Math.max(1, Math.ceil(n / 100));
  for (let i = 0; i < pages && out.length < n; i++) {
    const res = await xGet<Page<RawTweet[]>>(ctx, 'users/tweets', `/2/users/${encodeURIComponent(userId)}/tweets`, {
      max_results: Math.min(100, Math.max(5, n - out.length)),
      'tweet.fields': TWEET_FIELDS,
      start_time: opts.since ? new Date(opts.since).toISOString() : undefined,
      exclude: opts.exclude?.length ? opts.exclude.join(',') : undefined,
      pagination_token: token,
    });
    for (const t of res.data ?? []) out.push(mapPost(t));
    token = res.meta?.next_token;
    if (!token) break;
  }
  return out.slice(0, n);
}

const userIdCache = new Map<string, { id: string; at: number }>();

async function resolveUserId(ctx: XContext, handle: string): Promise<string | null> {
  const key = handle.replace(/^@/, '').toLowerCase();
  const hit = userIdCache.get(key);
  const now = (ctx.now ?? Date.now)();
  if (hit && now - hit.at < 24 * 3600 * 1000) return hit.id;
  const u = await getUserByUsername(ctx, key);
  if (!u) return null;
  userIdCache.set(key, { id: u.id, at: now });
  return u.id;
}

/**
 * Whether `sourceId` follows `targetHandle` (or a numeric target id prefixed with "id:").
 * Pages through the source's following list, up to `maxPages` × 1000 accounts.
 */
export async function isFollowing(ctx: XContext, sourceId: string, targetHandle: string, maxPages = 3): Promise<boolean> {
  const targetId = targetHandle.startsWith('id:') ? targetHandle.slice(3) : await resolveUserId(ctx, targetHandle);
  if (!targetId) return false;
  let token: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const res = await xGet<Page<Array<{ id: string }>>>(ctx, 'users/following', `/2/users/${encodeURIComponent(sourceId)}/following`, {
      max_results: 1000,
      pagination_token: token,
    });
    if ((res.data ?? []).some((u) => u.id === targetId)) return true;
    token = res.meta?.next_token;
    if (!token) break;
  }
  return false;
}

/** Whether the user reposted (retweeted) or quoted `postId` among their last 100 posts. */
export async function hasReposted(ctx: XContext, userId: string, postId: string): Promise<boolean> {
  const posts = await getRecentPosts(ctx, userId, 100);
  return posts.some((p) => p.referenced.some((r) => (r.type === 'retweeted' || r.type === 'quoted') && r.id === postId));
}

/** Most recent original post (no reply, no repost) since `since` that matches `predicate`. */
export async function findRecentPost(
  ctx: XContext,
  userId: string,
  since: Date | string,
  predicate: (p: XPost) => boolean,
): Promise<XPost | null> {
  const posts = await getRecentPosts(ctx, userId, 100, { since, exclude: ['replies', 'retweets'] });
  return posts.find((p) => !p.isReply && !p.isRepost && predicate(p)) ?? null;
}

export const postHasTag = (p: Pick<XPost, 'text' | 'hashtags'>, tag: string): boolean => {
  const t = tag.replace(/^#/, '').toLowerCase();
  if (p.hashtags.includes(t)) return true;
  return new RegExp(`(^|[^\\w])#${t.replace(/[^a-z0-9_]/g, '')}(?![\\w])`, 'i').test(p.text);
};

/** Most recent original post since `since` carrying `#tag` (case-insensitive). */
export function findRecentPostWithTag(ctx: XContext, userId: string, tag: string, since: Date | string): Promise<XPost | null> {
  return findRecentPost(ctx, userId, since, (p) => postHasTag(p, tag));
}

export interface PostMetrics extends BattleMetrics {
  impressions: number;
  authorId: string | null;
  createdAt: string;
  text: string;
}

/** Public metrics of one post (battle reads). Null when the post is gone. */
export async function getPostMetrics(ctx: XContext, postId: string): Promise<PostMetrics | null> {
  const res = await xGet<Page<RawTweet>>(ctx, 'tweets/lookup', `/2/tweets/${encodeURIComponent(postId)}`, {
    'tweet.fields': TWEET_FIELDS,
  });
  if (!res.data) return null;
  const p = mapPost(res.data);
  return {
    likes: p.likes,
    reposts: p.reposts,
    replies: p.replies,
    quotes: p.quotes,
    bookmarks: p.bookmarks,
    impressions: p.impressions,
    authorId: p.authorId,
    createdAt: p.createdAt,
    text: p.text,
  };
}

/** Bridges X data to @sway/scoring: scoring samples from posts. */
export const toScoreSamples = (posts: XPost[]): XPostSample[] =>
  posts.map((p) => ({
    createdAt: p.createdAt,
    likes: p.likes,
    reposts: p.reposts,
    replies: p.replies,
    isReply: p.isReply,
    isRepost: p.isRepost,
  }));

/** Sway score of an X account from its profile and recent posts (the same call the workers make on refresh). */
export function scoreXAccount(user: XUser, posts: XPost[], now = new Date()): { inputs: ScoreInputs; result: ScoreResult } {
  const inputs = inputsFromX(
    { followers: user.followers, createdAt: user.createdAt ?? now, verified: user.verified },
    toScoreSamples(posts),
    now,
  );
  return { inputs, result: score(inputs) };
}
