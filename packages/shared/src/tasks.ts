/**
 * Tasks (brief §6). Verified by reading the user's X account through the API: no screenshots, no pasted
 * links. Join-checklist tasks unlock in order.
 */

export type TaskId = 'follow' | 'repost' | 'tg' | 'card' | 'daily' | 'buykey';
export type TaskGroup = 'Join checklist' | 'Daily';
export type TaskIcon = 'x' | 'repeat' | 'telegram' | 'share' | 'flame' | 'key';

export interface TaskDef {
  id: TaskId;
  title: string;
  pts: number;
  icon: TaskIcon;
  group: TaskGroup;
  skippable?: boolean;
  /** Completed automatically from onchain state rather than by an X read. */
  auto?: boolean;
  /** Resets every UTC day. */
  daily?: boolean;
}

export const OFFICIAL_HANDLE = 'swaydotfamily';
export const DAILY_TAG = 'SwayDaily';

export const TASKS: readonly TaskDef[] = [
  { id: 'follow', title: 'Follow @swaydotfamily on X', pts: 1000, icon: 'x', group: 'Join checklist' },
  { id: 'repost', title: 'Repost the launch post', pts: 1000, icon: 'repeat', group: 'Join checklist' },
  { id: 'tg', title: 'Join the Telegram', pts: 500, icon: 'telegram', group: 'Join checklist', skippable: true },
  { id: 'card', title: 'Share your Sway card on X', pts: 2000, icon: 'share', group: 'Join checklist' },
  { id: 'daily', title: 'Post with #SwayDaily today', pts: 750, icon: 'flame', group: 'Daily', daily: true },
  { id: 'buykey', title: 'Hold a key you didn’t mint', pts: 1500, icon: 'key', group: 'Daily', auto: true },
];

export const taskById = (id: string): TaskDef | undefined => TASKS.find((t) => t.id === id);

/** Trending tags shown in search and Explore. */
export const TAGS = ['SwayBattle', 'OpenModel', 'Genesis', 'FanMarkets', 'SwayDaily', 'RobinhoodChain', 'Keys', 'Launchpad'];

export const POST_MAX = 500;
export const POST_MAX_STAKED = 2000;

/** Staking levels: protocol-fee cut and perks. Level ≥1 unlocks 2,000-character posts. */
export const STAKING_LEVELS = [
  { level: 0, name: 'None', cut: 0 },
  { level: 1, name: 'Beat', cut: 0.1 },
  { level: 2, name: 'Rhythm', cut: 0.25 },
  { level: 3, name: 'Tempo', cut: 0.5 },
  { level: 4, name: 'Crescendo', cut: 0.75 },
] as const;

export const SUBSCRIPTION_USD = 4;
export const TIP_USD = 5;
export const MARKET_CATEGORIES = ['creators', 'crypto', 'football', 'stocks', 'rwa'] as const;
export type MarketCategory = (typeof MARKET_CATEGORIES)[number];
