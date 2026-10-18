'use client';
/**
 * User actions (the prototype's click handlers): optimistic likes/reposts, follow, tip, subscribe,
 * trades through the SwayWallet, claims, deposits, withdrawals, tasks, battles and messages.
 */
import { keysToUnits, unitsToKeys, usdToWei, type QuoteWei } from '@sway/curve';
import {
  SUBSCRIPTION_USD,
  TIP_USD,
  type Address,
  type FeedResponse,
  type MeDTO,
  type NotificationDTO,
  type PostDTO,
  type ProfileDTO,
  type Visibility,
  type WalletDTO,
} from '@sway/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { isAddress } from 'viem';
import { errorMessage, getApi, isAuthRequired } from './api';
import { MOCK } from './env';
import { useEthUsd, useFormat } from './format';
import { invalidateMoney, qk, useMe } from './queries';
import { closeModal, openModal, toast, useUI } from './store';
import { shareCardUrl } from './util';
import { useExternalWallet, useSwayWallet, type SwayWallet } from './wallet';
import { weiToEth } from '@sway/curve';

const api = () => getApi();

function fail(e: unknown) {
  if (isAuthRequired(e)) return; // the Connect X modal is already open
  toast(errorMessage(e));
}

/** Applies fn to every cached PostDTO with this id (feed, profile posts). */
function patchPost(qc: QueryClient, id: string, fn: (p: PostDTO) => PostDTO) {
  for (const [key, data] of qc.getQueriesData<FeedResponse | PostDTO[]>({ predicate: (q) => q.queryKey[0] === 'feed' || q.queryKey[0] === 'profilePosts' })) {
    if (!data) continue;
    if (Array.isArray(data)) qc.setQueryData(key, data.map((p) => (p.id === id ? fn(p) : p)));
    else qc.setQueryData(key, { ...data, pinned: data.pinned?.id === id ? fn(data.pinned) : data.pinned, posts: data.posts.map((p) => (p.id === id ? fn(p) : p)) });
  }
}

export function useActions() {
  const qc = useQueryClient();
  const router = useRouter();
  const me = useMe().data ?? null;
  const F = useFormat();
  const ethUsd = useEthUsd();
  const { wallet, status } = useSwayWallet();

  const needUser = (): boolean => {
    if (!me) openModal({ type: 'connect' });
    return !!me;
  };

  const needWallet = (): SwayWallet | null => {
    if (!needUser()) return null;
    if (wallet) return wallet;
    if (status === 'none') openModal({ type: 'onboard' });
    else if (status === 'needs-external') {
      const oc = useExternalWallet.getState().openConnect;
      if (oc) oc();
      else toast('Connect your wallet to continue');
    } else if (status === 'missing-key') toast('Your Sway wallet key isn’t on this device');
    else toast('Embedded wallets aren’t available yet. Use your own wallet.');
    return null;
  };

  const cash = async (): Promise<bigint> => {
    const w = await qc.fetchQuery({ queryKey: qk.wallet, queryFn: () => api().wallet(), staleTime: 5_000 });
    return BigInt(w.cashWei);
  };

  /** Pays a creator's owner wallet in ETH, then tells the API (tip / subscribe). */
  const payCreator = async (handle: string, usd: number, noFunds: string) => {
    const w = needWallet();
    if (!w) return null;
    const p = await qc.fetchQuery({ queryKey: qk.profile(handle), queryFn: () => api().profile(handle) });
    if (!p.ownerAddress) {
      toast('This account hasn’t joined Sway yet');
      return null;
    }
    const wei = usdToWei(usd, ethUsd);
    if ((await cash()) < wei) {
      toast(noFunds);
      return null;
    }
    const hash = await w.sendEth(p.ownerAddress, wei);
    await w.waitForReceipt(hash);
    return hash;
  };

  return {
    me,
    needUser,
    openTrade: (handle: string, side: 'buy' | 'sell' = 'buy') => openModal({ type: 'trade', handle, side }),

    async execTrade(p: ProfileDTO, side: 'buy' | 'sell', q: QuoteWei) {
      const w = needWallet();
      if (!w) return false;
      try {
        const hash =
          side === 'buy'
            ? await w.buy(p.subject, q.units, q.total + q.total / 100n) // +1% buffer, the contract refunds change
            : await w.sell(p.subject, q.units, (q.total * 99n) / 100n);
        await w.waitForReceipt(hash);
        const k = unitsToKeys(q.units);
        toast(`${side === 'buy' ? 'Bought' : 'Sold'} ${F.keys(k)} key${k === 1 ? '' : 's'} of ${p.name}`);
        closeModal();
        // Mined, but the API mirrors chain state through the indexer (a few blocks behind): show the new
        // holding now, then refresh once the indexer has it.
        const expected = BigInt(p.heldUnits) + (side === 'buy' ? q.units : -q.units);
        qc.setQueryData<ProfileDTO>(qk.profile(p.handle), (o) => (o ? { ...o, heldUnits: expected.toString() } : o));
        void (async () => {
          for (let i = 0; i < 30; i++) {
            const fresh = await api()
              .profile(p.handle)
              .catch(() => null);
            if (fresh && BigInt(fresh.heldUnits) === expected) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
          await invalidateMoney(qc, p.handle);
        })();
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async like(post: PostDTO) {
      if (!needUser()) return;
      const liked = !post.liked;
      patchPost(qc, post.id, (p) => ({ ...p, liked, likes: p.likes + (liked ? 1 : -1) }));
      try {
        const r = await api().like(post.id);
        patchPost(qc, post.id, (p) => ({ ...p, liked: r.liked, likes: r.count }));
      } catch (e) {
        patchPost(qc, post.id, (p) => ({ ...p, liked: !liked, likes: p.likes + (liked ? -1 : 1) }));
        fail(e);
      }
    },

    async repost(post: PostDTO) {
      if (!needUser()) return;
      const reposted = !post.reposted;
      patchPost(qc, post.id, (p) => ({ ...p, reposted, reposts: p.reposts + (reposted ? 1 : -1) }));
      try {
        const r = await api().repost(post.id);
        patchPost(qc, post.id, (p) => ({ ...p, reposted: r.reposted, reposts: r.count }));
      } catch (e) {
        patchPost(qc, post.id, (p) => ({ ...p, reposted: !reposted, reposts: p.reposts + (reposted ? -1 : 1) }));
        fail(e);
      }
    },

    async follow(handle: string) {
      if (!needUser()) return;
      qc.setQueryData<ProfileDTO>(qk.profile(handle), (p) => (p ? { ...p, following: !p.following } : p));
      try {
        const r = await api().follow(handle);
        qc.setQueryData<ProfileDTO>(qk.profile(handle), (p) => (p ? { ...p, following: r.following } : p));
        qc.invalidateQueries({ queryKey: qk.feed('following') });
      } catch (e) {
        qc.invalidateQueries({ queryKey: qk.profile(handle) });
        fail(e);
      }
    },

    async tip(handle: string) {
      if (!needUser()) return;
      try {
        const hash = await payCreator(handle, TIP_USD, 'Add funds to tip');
        if (!hash) return;
        await api().tip(handle, { txHash: hash });
        toast(`Tipped @${handle} $${TIP_USD}`);
        qc.invalidateQueries({ queryKey: qk.wallet });
      } catch (e) {
        fail(e);
      }
    },

    async subscribe(handle: string) {
      if (!needUser()) return;
      try {
        const hash = await payCreator(handle, SUBSCRIPTION_USD, 'Add funds to subscribe');
        if (!hash) return;
        await api().subscribe(handle, { txHash: hash });
        toast(`Subscribed for $${SUBSCRIPTION_USD} a month`);
        qc.invalidateQueries({ queryKey: qk.wallet });
        qc.invalidateQueries({ queryKey: ['feed'] });
        qc.invalidateQueries({ queryKey: ['profilePosts'] });
        qc.invalidateQueries({ queryKey: qk.profile(handle) });
      } catch (e) {
        fail(e);
      }
    },

    async dm(handle: string) {
      if (!needUser()) return;
      try {
        const t = await api().dmOpen({ handle });
        qc.invalidateQueries({ queryKey: qk.messages });
        router.push(`/messages/${encodeURIComponent(t.id)}`);
      } catch (e) {
        fail(e);
      }
    },

    async post(text: string, visibility: Visibility, onDone?: () => void) {
      if (!needUser()) return false;
      try {
        await api().createPost({ text, visibility });
        onDone?.();
        useUI.setState({ feedTab: 'latest' });
        await qc.invalidateQueries({ queryKey: ['feed'] });
        qc.invalidateQueries({ queryKey: ['profilePosts'] });
        if (window.location.pathname !== '/') router.push('/');
        toast('Posted');
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async claimEarnings(w: WalletDTO) {
      const sw = needWallet();
      if (!sw) return;
      try {
        const hash = await sw.claim(w.earnings.claimSubjects as Address[]);
        await sw.waitForReceipt(hash);
        toast(`Claimed ${F.$(weiToEth(w.earnings.totalWei))}`);
        await invalidateMoney(qc);
        // "Claimed so far" comes from the indexer: refresh once it has the Claim event.
        const before = BigInt(w.earnings.claimedWei);
        void (async () => {
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            const fresh = await api()
              .wallet()
              .catch(() => null);
            if (fresh && BigInt(fresh.earnings.claimedWei) > before) {
              qc.setQueryData(qk.wallet, fresh);
              break;
            }
          }
        })();
      } catch (e) {
        fail(e);
      }
    },

    async deposit() {
      if (!needUser()) return;
      try {
        const { txHash } = await api().faucet();
        if (MOCK) toast('Added $100 in demo funds');
        else {
          if (wallet) await wallet.waitForReceipt(txHash as `0x${string}`).catch(() => null);
          toast('Added test funds from the faucet');
        }
        qc.invalidateQueries({ queryKey: qk.wallet });
      } catch (e) {
        if (isAuthRequired(e)) return;
        // No faucet on this chain: show the deposit address instead.
        openModal({ type: 'deposit' });
      }
    },

    async withdraw(usd: number, to: string, available: bigint) {
      const w = needWallet();
      if (!w) return false;
      const wei = usdToWei(usd, ethUsd);
      if (!(usd > 0) || wei > available) {
        toast('Enter an amount up to your balance');
        return false;
      }
      if (!MOCK && !isAddress(to)) {
        toast('Enter a valid wallet address');
        return false;
      }
      try {
        const dest = (isAddress(to) ? to : w.address) as Address;
        const hash = await w.sendEth(dest, wei);
        await w.waitForReceipt(hash);
        await api().withdrawLog({ label: 'Withdrawal to external wallet', amountWei: (-wei).toString(), txHash: hash });
        closeModal();
        toast(`Withdrew $${usd.toFixed(2)} as USDC`);
        await invalidateMoney(qc);
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async verifyTask(id: string) {
      if (!needUser()) return;
      try {
        const t = await api().taskVerify(id);
        qc.invalidateQueries({ queryKey: qk.tasks });
        if (t.status === 'verified' || t.status === 'trusted') toast(`Verified on X. +${F.int(t.pts)} pts`);
      } catch (e) {
        fail(e);
      }
    },

    async skipTask(id: string) {
      if (!needUser()) return;
      try {
        await api().taskSkip(id);
        qc.invalidateQueries({ queryKey: qk.tasks });
      } catch (e) {
        fail(e);
      }
    },

    async backSide(battleId: string, side: 'a' | 'b', amount: number) {
      if (!needUser()) return;
      if (me && me.points.total < amount) {
        toast('Not enough points');
        return;
      }
      try {
        await api().back(battleId, { side, amount });
        toast(`Backed with ${F.int(amount)} pts`);
        qc.invalidateQueries({ queryKey: qk.battles });
        qc.invalidateQueries({ queryKey: qk.me });
      } catch (e) {
        fail(e);
      }
    },

    async challenge(opponent: string, theme: string, stake: number) {
      if (!needUser()) return;
      const opp = opponent.replace('@', '').trim().toLowerCase();
      try {
        const b = await api().createBattle({ opponent: opp || undefined, theme: theme.trim() || 'Best take of the week', stake });
        closeModal();
        qc.invalidateQueries({ queryKey: qk.battles });
        qc.invalidateQueries({ queryKey: qk.me });
        router.push('/battles');
        toast(b.b && opp ? `Challenge sent to @${b.b.handle}` : 'Open challenge posted');
      } catch (e) {
        fail(e);
      }
    },

    async respond(battleId: string, accept: boolean) {
      try {
        await api().respondBattle(battleId, { accept });
        qc.invalidateQueries({ queryKey: qk.battles });
      } catch (e) {
        fail(e);
      }
    },

    async readAll() {
      try {
        const r = await api().readAll();
        qc.setQueryData<MeDTO | null>(qk.me, (m) => (m ? { ...m, unreadNotifications: r.unread } : m));
        qc.invalidateQueries({ queryKey: ['notifications'] });
      } catch (e) {
        fail(e);
      }
    },

    async openNotification(n: NotificationDTO) {
      if (!n.read) {
        api()
          .readOne(n.id)
          .then((r) => {
            qc.setQueryData<MeDTO | null>(qk.me, (m) => (m ? { ...m, unreadNotifications: r.unread } : m));
            qc.invalidateQueries({ queryKey: ['notifications'] });
          })
          .catch(() => null);
      }
      if (n.link) router.push(n.link);
    },

    async sendRoom(handle: string, text: string) {
      if (!needUser()) return;
      try {
        const m = await api().roomPost(handle, { text });
        qc.setQueryData(qk.room(handle), (old: import('@sway/shared').RoomResponse | undefined) =>
          old && !old.messages.some((x) => x.id === m.id) ? { ...old, messages: [...old.messages, m] } : old,
        );
        qc.invalidateQueries({ queryKey: qk.messages });
      } catch (e) {
        fail(e);
      }
    },

    async sendDm(id: string, text: string) {
      if (!needUser()) return;
      try {
        const m = await api().dmSend(id, { text });
        qc.setQueryData(qk.dm(id), (old: import('@sway/shared').DmResponse | undefined) =>
          old && !old.messages.some((x) => x.id === m.id) ? { ...old, messages: [...old.messages, m] } : old,
        );
        qc.invalidateQueries({ queryKey: qk.messages });
      } catch (e) {
        fail(e);
      }
    },

    shareCard() {
      if (!me) return;
      window.open(shareCardUrl(me.user.score, F.usd(me.user.reachValue)), '_blank', 'noopener');
    },
  };
}

export type Actions = ReturnType<typeof useActions>;
export { keysToUnits };
