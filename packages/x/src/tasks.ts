/**
 * Task checks against X (brief §6): the one place that decides whether an X-verified task is done, shared by
 * the API (synchronous verify with the user's token) and the workers (`verify-task` jobs).
 */
import { DAILY_TAG, OFFICIAL_HANDLE, type TaskId } from '@sway/shared';
import { findRecentPost, findRecentPostWithTag, hasReposted, isFollowing, type XPost } from './api';
import type { XContext } from './request';

export interface TaskCheckInput {
  taskId: TaskId;
  /** The member's X user id. */
  xUserId: string;
  /** UTC day the task is for (daily tasks look for posts since 00:00 of this day). */
  day: Date;
  /** When the member joined: the Sway card must be shared after this. */
  joinedAt?: Date | null;
  /** Id of the official launch post for the 'repost' task. */
  launchPostId?: string | null;
  /** Hosts that identify a Sway card share, e.g. ["sway.fam", "localhost:3000"]. */
  cardHosts?: string[];
  officialHandle?: string;
}

/**
 * - verified: the X read confirms it.
 * - not_found: the X read found nothing yet (task stays open).
 * - unsupported: X cannot verify this task (Telegram, auto tasks) or it is not configured.
 */
export type TaskCheckResult = 'verified' | 'not_found' | 'unsupported';

export const isSwayCardPost = (p: Pick<XPost, 'text' | 'hashtags'>, hosts: string[] = []): boolean => {
  const t = p.text.toLowerCase();
  return t.includes('sway score') || p.hashtags.includes('sway') || hosts.some((h) => h && t.includes(h.toLowerCase()));
};

export async function checkTaskOnX(ctx: XContext, input: TaskCheckInput): Promise<TaskCheckResult> {
  switch (input.taskId) {
    case 'follow':
      return (await isFollowing(ctx, input.xUserId, input.officialHandle ?? OFFICIAL_HANDLE)) ? 'verified' : 'not_found';
    case 'repost':
      if (!input.launchPostId) return 'unsupported';
      return (await hasReposted(ctx, input.xUserId, input.launchPostId)) ? 'verified' : 'not_found';
    case 'card': {
      const since = input.joinedAt ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const hit = await findRecentPost(ctx, input.xUserId, since, (p) => isSwayCardPost(p, input.cardHosts));
      return hit ? 'verified' : 'not_found';
    }
    case 'daily':
      return (await findRecentPostWithTag(ctx, input.xUserId, DAILY_TAG, input.day)) ? 'verified' : 'not_found';
    default:
      return 'unsupported';
  }
}
