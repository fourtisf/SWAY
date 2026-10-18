/**
 * @sway/x: X (Twitter) API v2 client for Sway. No web framework inside, so the API and the workers share it.
 *
 *   const x = createXClient({ token: accessToken, budget: redis, budgetScope: `u:${userId}` });
 *   const me = await x.getMe();
 *   const posts = await x.getRecentPosts(me.id, 50);
 *   const { inputs, result } = scoreXAccount(me, posts);
 */
import * as api from './api';
import { checkTaskOnX, type TaskCheckInput } from './tasks';
import type { XContext } from './request';

export * from './errors';
export * from './pkce';
export * from './request';
export * from './api';
export * from './tasks';

export type XClient = ReturnType<typeof createXClient>;

export function createXClient(ctx: XContext) {
  return {
    ctx,
    getMe: () => api.getMe(ctx),
    getUserByUsername: (username: string) => api.getUserByUsername(ctx, username),
    getUserById: (id: string) => api.getUserById(ctx, id),
    getRecentPosts: (userId: string, n?: number, opts?: api.RecentPostsOptions) =>
      api.getRecentPosts(ctx, userId, n, opts),
    isFollowing: (sourceId: string, targetHandle: string, maxPages?: number) =>
      api.isFollowing(ctx, sourceId, targetHandle, maxPages),
    hasReposted: (userId: string, postId: string) => api.hasReposted(ctx, userId, postId),
    findRecentPost: (userId: string, since: Date | string, predicate: (p: api.XPost) => boolean) =>
      api.findRecentPost(ctx, userId, since, predicate),
    findRecentPostWithTag: (userId: string, tag: string, since: Date | string) =>
      api.findRecentPostWithTag(ctx, userId, tag, since),
    getPostMetrics: (postId: string) => api.getPostMetrics(ctx, postId),
    checkTask: (input: TaskCheckInput) => checkTaskOnX(ctx, input),
  };
}
