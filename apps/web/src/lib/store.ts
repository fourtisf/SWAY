'use client';
/** Client UI state (the prototype's `S` minus server data): modals, toasts, tabs, drawer, nav history. */
import type { ExploreSort, ExploreTab, FeedTab, LeaderboardTab, MarketCategory, NotificationTab } from '@sway/shared';
import { create } from 'zustand';

export type Modal =
  | { type: 'trade'; handle: string; side: 'buy' | 'sell' }
  | { type: 'connect' }
  | { type: 'onboard'; handle?: string; followers?: number }
  | { type: 'card' }
  | { type: 'compose' }
  | { type: 'withdraw' }
  | { type: 'deposit' }
  | { type: 'challenge'; handle?: string }
  | { type: 'claim'; handle: string }
  | { type: 'launch' };

export type ProfileTab = 'posts' | 'room' | 'holders' | 'trades';

interface Toast {
  id: number;
  msg: string;
}

interface UIState {
  modal: Modal | null;
  toasts: Toast[];
  drawer: boolean;
  feedTab: FeedTab;
  exploreTab: ExploreTab;
  exploreSort: ExploreSort;
  exploreQ: string;
  mkTab: MarketCategory;
  lbTab: LeaderboardTab;
  ntTab: NotificationTab;
  profTab: ProfileTab;
  slide: number;
  launch: boolean;
  /** Live ETH/USD from `price` socket messages (overrides ConfigDTO.ethUsd). */
  ethUsd: number | null;
  /** Key of the newest trade pushed by the socket, so its row animates in. */
  newTrade: string | null;
  /** In-app navigation stack for the Back button (prototype lastView). */
  history: string[];
  model: { followers: number; er: number; ppw: number; age: number; verified: boolean };
  set: (p: Partial<UIState>) => void;
  openModal: (m: Modal) => void;
  closeModal: () => void;
  toast: (msg: string) => void;
}

let tid = 0;

export const useUI = create<UIState>((set) => ({
  modal: null,
  toasts: [],
  drawer: false,
  feedTab: 'foryou',
  exploreTab: 'creators',
  exploreSort: 'trending',
  exploreQ: '',
  mkTab: 'creators',
  lbTab: 'points',
  ntTab: 'all',
  profTab: 'posts',
  slide: 0,
  launch: false,
  ethUsd: null,
  newTrade: null,
  history: [],
  model: { followers: 41000, er: 0.022, ppw: 10, age: 3, verified: true },
  set: (p) => set(p),
  openModal: (modal) => set({ modal, drawer: false }),
  closeModal: () => set({ modal: null }),
  toast: (msg) => {
    const id = ++tid;
    set((s) => ({ toasts: [...s.toasts, { id, msg }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2600);
  },
}));

export const toast = (msg: string) => useUI.getState().toast(msg);
export const openModal = (m: Modal) => useUI.getState().openModal(m);
export const closeModal = () => useUI.getState().closeModal();

/** A 1s clock shared by every countdown (prototype tickCountdowns). */
export const useClock = create<{ now: number }>(() => ({ now: Date.now() }));
if (typeof window !== 'undefined') setInterval(() => useClock.setState({ now: Date.now() }), 1000);

// Mock mode: expose the UI store for design review and visual tests.
if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_API_MOCK === '1') (window as unknown as { __ui: typeof useUI }).__ui = useUI;
