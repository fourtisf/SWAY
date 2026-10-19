'use client';
/**
 * [B] Queries and actions for the post menu (delete, boost, report, block, hide), images, threads, settings
 * and the admin panel. Mutations patch or invalidate the shared feed/profile caches.
 */
import type { FeedResponse, HistoryRange, PostDetailResponse, PostDTO, ProfileDTO, ReportReason } from '@sway/shared';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useActions } from './actions';
import { errorMessage, getApi, isAuthRequired } from './api';
import { qk, useMe } from './queries';
import { closeModal, openModal, toast } from './store';

const api = () => getApi();

export const sk = {
  post: (id: string) => ['postDetail', id] as const,
  boostQuote: ['boostQuote'] as const,
  history: (h: string, r: HistoryRange) => ['priceHistory', h, r] as const,
  card: (h: string) => ['card', h] as const,
  account: ['account'] as const,
  admin: (what: string, arg = '') => ['admin', what, arg] as const,
};

export const usePostDetail = (id: string) => useQuery({ queryKey: sk.post(id), queryFn: () => api().post(id), retry: false });
export const useBoostQuote = (enabled = true) => useQuery({ queryKey: sk.boostQuote, queryFn: () => api().boostQuote(), enabled, staleTime: 30_000 });
export const usePriceHistory = (h: string, r: HistoryRange, enabled = true) =>
  useQuery({ queryKey: sk.history(h, r), queryFn: () => api().priceHistory(h, { range: r }), enabled: enabled && !!h });
export const useCard = (h: string) => useQuery({ queryKey: sk.card(h), queryFn: () => api().card(h), retry: false });
export const useAccount = (enabled: boolean) => useQuery({ queryKey: sk.account, queryFn: () => api().account(), enabled });

/** Every cached copy of a post (feeds, profile posts, threads). */
export function patchPostEverywhere(qc: QueryClient, id: string, fn: (p: PostDTO) => PostDTO) {
  for (const [key, data] of qc.getQueriesData<FeedResponse | PostDTO[] | PostDetailResponse>({
    predicate: (q) => ['feed', 'profilePosts', 'postDetail'].includes(String(q.queryKey[0])),
  })) {
    if (!data) continue;
    const f = (p: PostDTO) => (p.id === id ? fn(p) : p);
    if (Array.isArray(data)) qc.setQueryData(key, data.map(f));
    else if ('post' in data)
      qc.setQueryData(key, { ...data, post: f(data.post), parents: data.parents.map(f), replies: data.replies.map(f), nested: data.nested.map(f) });
    else qc.setQueryData(key, { ...data, pinned: data.pinned ? f(data.pinned) : null, posts: data.posts.map(f) });
  }
}

/** After deletes, hides and blocks: every list of posts may change. */
export function refreshPosts(qc: QueryClient) {
  return qc.invalidateQueries({ predicate: (q) => ['feed', 'profilePosts', 'postDetail'].includes(String(q.queryKey[0])) });
}

const fail = (e: unknown) => {
  if (!isAuthRequired(e)) toast(errorMessage(e));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useSocialActions() {
  const qc = useQueryClient();
  const router = useRouter();
  const me = useMe().data ?? null;
  const a = useActions();

  return {
    copyLink(p: Pick<PostDTO, 'id'>) {
      const url = `${window.location.origin}/post/${p.id}`;
      navigator.clipboard?.writeText(url).catch(() => null);
      toast('Link copied');
    },

    async deletePost(id: string, opts: { leave?: boolean } = {}) {
      try {
        await api().deletePost(id);
        closeModal();
        toast('Post deleted');
        await refreshPosts(qc);
        if (opts.leave) router.push('/');
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    /** Pays the boost price to the treasury through the active wallet, then tells the API. */
    async boost(id: string) {
      const w = a.needWallet();
      if (!w) return false;
      try {
        const q = await qc.fetchQuery({ queryKey: sk.boostQuote, queryFn: () => api().boostQuote(), staleTime: 30_000 });
        if (!q.treasury) {
          toast('Boosts aren’t available on this network yet');
          return false;
        }
        const hash = await w.sendEth(q.treasury, BigInt(q.wei));
        await w.waitForReceipt(hash);
        let res = null;
        for (let i = 0; !res; i++) {
          try {
            res = await api().boostPost(id, { txHash: hash });
          } catch (e) {
            // The API reads the chain; give a just-mined payment a moment to show up.
            const code = (e as { code?: string }).code;
            if (i < 6 && (code === 'tx_pending' || code === 'tx_not_found')) await sleep(1500);
            else throw e;
          }
        }
        patchPostEverywhere(qc, id, () => res!.post);
        closeModal();
        toast(`Boosted for ${q.hours} hours`);
        qc.invalidateQueries({ queryKey: qk.wallet });
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async report(target: { postId?: string; handle: string }, reason: ReportReason, note: string) {
      try {
        await api().report({ ...(target.postId ? { postId: target.postId } : { handle: target.handle }), reason, note: note.trim() || undefined });
        closeModal();
        toast('Thanks. Our moderators will take a look.');
      } catch (e) {
        fail(e);
      }
    },

    async block(handle: string) {
      if (!a.needUser()) return;
      try {
        const r = await api().block(handle);
        qc.setQueryData<ProfileDTO>(qk.profile(handle), (p) => (p ? { ...p, blocked: r.blocked, following: r.blocked ? false : p.following } : p));
        toast(r.blocked ? `You blocked @${handle}` : `Unblocked @${handle}`);
        await refreshPosts(qc);
        qc.invalidateQueries({ queryKey: qk.messages });
        qc.invalidateQueries({ queryKey: sk.account });
      } catch (e) {
        fail(e);
      }
    },

    async hide(p: Pick<PostDTO, 'id' | 'hidden'>) {
      try {
        const r = await api().adminHidePost(p.id, { hidden: !p.hidden });
        patchPostEverywhere(qc, p.id, (x) => ({ ...x, hidden: r.hidden }));
        toast(r.hidden ? 'Post hidden' : 'Post visible again');
        qc.invalidateQueries({ queryKey: ['admin'] });
      } catch (e) {
        fail(e);
      }
    },

    openReport: (target: { postId?: string; handle: string }) => (me ? openModal({ type: 'report', ...target }) : openModal({ type: 'connect' })),
  };
}

export type SocialActions = ReturnType<typeof useSocialActions>;
