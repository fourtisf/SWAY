'use client';
/**
 * [D] Watchlist, daily streak, referrals, notification prefs, web push and creator drops: queries and actions.
 * Drop transactions go through the SwayWallet (SwayDrops.create / claim / reclaim); the indexer mirrors them,
 * so after a receipt we invalidate and let the next read pick them up.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { shortAddress, type Address, type ClaimableDropDTO, type CreatorDropDTO, type DropPlanDTO, type NotificationPrefs } from '@sway/shared';
import { swayDropsAbi } from '@sway/shared/abi';
import { errorMessage, getApi, isAuthRequired } from './api';
import { qk, useConfig, useMe } from './queries';
import { openModal, toast } from './store';
import { SWAY_WALLET_OFF, useExternalWallet, useSwayWallet, type SwayWallet } from './wallet';
import { currentPushSubscription, disablePush, enablePush, pushSupported } from './push';

const api = () => getApi();
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export const qkEngage = {
  watchlist: ['watchlist'] as const,
  streak: ['streak'] as const,
  referrals: ['referrals'] as const,
  prefs: ['notifPrefs'] as const,
  push: ['pushConfig'] as const,
  userDrops: (h: string) => ['userDrops', h] as const,
  claimableDrops: ['claimableDrops'] as const,
};

export const useWatchlist = (enabled: boolean) => useQuery({ queryKey: qkEngage.watchlist, queryFn: () => api().watchlist(), enabled });
export const useStreak = (enabled: boolean) => useQuery({ queryKey: qkEngage.streak, queryFn: () => api().streak(), enabled });
export const useReferrals = (enabled: boolean) => useQuery({ queryKey: qkEngage.referrals, queryFn: () => api().referrals(), enabled });
export const useNotifPrefs = (enabled: boolean) => useQuery({ queryKey: qkEngage.prefs, queryFn: () => api().notifPrefs(), enabled });
export const usePushConfig = () => useQuery({ queryKey: qkEngage.push, queryFn: () => api().pushConfig(), staleTime: 60_000 });
export const useUserDrops = (h: string) => useQuery({ queryKey: qkEngage.userDrops(h), queryFn: () => api().userDrops(h), enabled: !!h });
export const useClaimableDrops = (enabled: boolean) =>
  useQuery({ queryKey: qkEngage.claimableDrops, queryFn: () => api().claimableDrops(), enabled });

export function useEngageActions() {
  const qc = useQueryClient();
  const me = useMe().data ?? null;
  const config = useConfig().data;
  const { wallet, status } = useSwayWallet();

  const fail = (e: unknown) => {
    if (!isAuthRequired(e)) toast(errorMessage(e));
  };

  const needUser = () => {
    if (me) return true;
    openModal({ type: 'connect' });
    return false;
  };

  /** The connected wallet, optionally required to be `address` (the wallet holding the allocation). */
  const needWallet = (address?: string | null): SwayWallet | null => {
    if (!needUser()) return null;
    if (!wallet) {
      if (status === 'none') openModal({ type: 'onboard' });
      else if (status === 'needs-external') {
        const oc = useExternalWallet.getState().openConnect;
        if (oc) oc();
        else toast('Connect your wallet to continue');
      } else if (status === 'missing-key') toast('Your Sway wallet key isn’t on this device');
      else toast(SWAY_WALLET_OFF);
      return null;
    }
    if (address && !same(wallet.address, address)) {
      toast(`Switch to wallet ${shortAddress(address)} to claim`);
      return null;
    }
    return wallet;
  };

  const dropsContract = (): Address => {
    const a = config?.contracts.drops;
    if (!a) throw new Error('Creator drops aren’t deployed on this chain yet');
    return a;
  };

  const refreshDrops = (handle?: string) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qkEngage.claimableDrops }),
      qc.invalidateQueries({ queryKey: qk.wallet }),
      handle ? qc.invalidateQueries({ queryKey: qkEngage.userDrops(handle) }) : null,
    ]);

  return {
    async watch(handle: string, alertPct: number): Promise<boolean> {
      if (!needUser()) return false;
      try {
        await api().watch(handle, { alertPct });
        await qc.invalidateQueries({ queryKey: qkEngage.watchlist });
        toast(alertPct ? `Watching @${handle}: alert at ±${alertPct}%` : `Watching @${handle}`);
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async unwatch(handle: string): Promise<void> {
      try {
        await api().unwatch(handle);
        await qc.invalidateQueries({ queryKey: qkEngage.watchlist });
        toast(`Removed @${handle} from your watchlist`);
      } catch (e) {
        fail(e);
      }
    },

    async checkIn(): Promise<void> {
      if (!needUser()) return;
      try {
        const r = await api().checkIn();
        qc.setQueryData(qkEngage.streak, r);
        await qc.invalidateQueries({ queryKey: qk.me });
        toast(r.awarded ? `Day ${r.days} streak · +${r.awarded} points` : 'Already checked in today');
      } catch (e) {
        fail(e);
      }
    },

    async setPrefs(patch: Partial<NotificationPrefs>): Promise<void> {
      const prev = qc.getQueryData<NotificationPrefs>(qkEngage.prefs);
      if (prev) qc.setQueryData(qkEngage.prefs, { ...prev, ...patch });
      try {
        qc.setQueryData(qkEngage.prefs, await api().setNotifPrefs(patch));
        await Promise.all([qc.invalidateQueries({ queryKey: ['notifications'] }), qc.invalidateQueries({ queryKey: qk.me })]);
      } catch (e) {
        if (prev) qc.setQueryData(qkEngage.prefs, prev);
        fail(e);
      }
    },

    /** Asks for permission, subscribes this browser and registers it with the API. */
    async enablePush(publicKey: string | null): Promise<boolean> {
      if (!needUser()) return false;
      if (!pushSupported()) {
        toast('This browser doesn’t support push notifications');
        return false;
      }
      if (!publicKey) {
        toast('Push notifications aren’t set up on this server');
        return false;
      }
      try {
        await api().pushSubscribe(await enablePush(publicKey));
        await qc.invalidateQueries({ queryKey: qkEngage.push });
        toast('Push notifications on for this browser');
        return true;
      } catch (e) {
        toast((e as Error).message === 'denied' ? 'Allow notifications for Sway in your browser settings' : errorMessage(e));
        return false;
      }
    },

    async disablePush(): Promise<void> {
      try {
        const endpoint = await disablePush();
        if (endpoint) await api().pushUnsubscribe({ endpoint });
        await qc.invalidateQueries({ queryKey: qkEngage.push });
        toast('Push notifications off for this browser');
      } catch (e) {
        fail(e);
      }
    },

    pushOnHere: async (): Promise<boolean> => !!(await currentPushSubscription()),

    async pushTest(): Promise<void> {
      try {
        await api().pushTest();
        toast('Test notification sent');
      } catch (e) {
        fail(e);
      }
    },

    /** Builds the holder tree (the API snapshots key balances now). */
    async planDrop(amountWei: bigint): Promise<DropPlanDTO | null> {
      if (!needUser()) return null;
      try {
        return await api().dropPlan({ amountWei: amountWei.toString() });
      } catch (e) {
        fail(e);
        return null;
      }
    },

    /** Funds the drop from the account wallet (it owns the market). */
    async sendDrop(plan: DropPlanDTO, days: number): Promise<boolean> {
      const w = needWallet(me?.wallet?.address);
      if (!w || !me) return false;
      try {
        const hash = await w.writeContract({
          address: plan.contract,
          abi: swayDropsAbi,
          functionName: 'create',
          args: [plan.root, BigInt(Math.round(days * 86_400))],
          value: BigInt(plan.totalWei),
        });
        await w.waitForReceipt(hash);
        await refreshDrops(me.user.handle);
        toast(`Airdrop sent to ${plan.holders} holder${plan.holders === 1 ? '' : 's'}`);
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async claimDrop(d: ClaimableDropDTO): Promise<boolean> {
      const w = needWallet(d.address);
      if (!w) return false;
      try {
        const hash = await w.writeContract({
          address: d.contract ?? dropsContract(),
          abi: swayDropsAbi,
          functionName: 'claim',
          args: [BigInt(d.id), BigInt(d.amountWei), d.proof],
        });
        await w.waitForReceipt(hash);
        // Drop it from the list right away; the indexer catches up within seconds.
        qc.setQueryData<ClaimableDropDTO[]>(qkEngage.claimableDrops, (xs) => xs?.filter((x) => !(x.id === d.id && same(x.address, d.address))));
        await refreshDrops(d.creator.handle);
        toast(`Claimed airdrop from @${d.creator.handle}`);
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async reclaimDrop(d: CreatorDropDTO): Promise<boolean> {
      const w = needWallet(me?.wallet?.address);
      if (!w) return false;
      try {
        const hash = await w.writeContract({ address: dropsContract(), abi: swayDropsAbi, functionName: 'reclaim', args: [BigInt(d.id)] });
        await w.waitForReceipt(hash);
        await refreshDrops(d.creator.handle);
        toast('Unclaimed ETH is back in your wallet');
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
  };
}

export type EngageActions = ReturnType<typeof useEngageActions>;
