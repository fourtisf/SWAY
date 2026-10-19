/**
 * [D] Mock mode for the watchlist, daily streak, referral dashboard, notification prefs, web push (off: it needs
 * the live API's VAPID keys) and creator drops (real merkle trees; SwayDrops calls arrive through
 * MockWorld.mockContractWrite).
 */
import { ethToWei, priceWei, weiToEth } from '@sway/curve';
import { INVITE_POINTS, INVITES_CREDITED_PER_DAY, nextStreak, streakPoints, utcDayKey } from '@sway/scoring';
import {
  DEFAULT_NOTIFICATION_PREFS,
  airdropLeaf,
  buildAirdrop,
  verifyMerkleProof,
  type Address,
  type ClaimableDropDTO,
  type CreatorDropDTO,
  type NotificationPrefs,
  type StreakDTO,
  type WatchDTO,
} from '@sway/shared';
import { ApiRequestError, notifyAuthRequired, type SwayApi } from '../api';
import type { ContractCall } from '../wallet/types';
import { fakeAddress, fakeHash } from './seed';
import type { MockWorld } from './state';

export const MOCK_DROPS = fakeAddress('drops');
const DAY = 86_400_000;

interface MockDrop {
  id: number;
  creator: string;
  root: `0x${string}`;
  total: bigint;
  claimed: bigint;
  expiresAt: number;
  reclaimed: boolean;
  createdAt: number;
  txHash: `0x${string}`;
  allocations: Map<string, { amount: bigint; proof: `0x${string}`[]; claimed: boolean }>;
}

interface EngageState {
  watches: Map<string, { alertPct: number; baseline: bigint; at: number }>;
  streak: { days: number; lastDay: string | null };
  prefs: NotificationPrefs;
  plans: Map<string, Array<{ address: string; amount: bigint; proof: `0x${string}`[] }>>;
  drops: MockDrop[];
}

const states = new WeakMap<MockWorld, EngageState>();
function stateOf(w: MockWorld): EngageState {
  let s = states.get(w);
  if (!s) {
    s = { watches: new Map(), streak: { days: 0, lastDay: null }, prefs: { ...DEFAULT_NOTIFICATION_PREFS, push: false }, plans: new Map(), drops: [] };
    states.set(w, s);
  }
  return s;
}

function needUser(w: MockWorld) {
  if (!w.user) {
    notifyAuthRequired();
    throw new ApiRequestError(401, 'auth_required', 'Connect X first');
  }
  return w.user;
}

const price = (w: MockWorld, h: string) => priceWei(BigInt(Math.round((w.C[h]?.supply ?? 1) * 100)));
const lc = (a: string) => a.toLowerCase();

function watchDTO(w: MockWorld, h: string, x: { alertPct: number; baseline: bigint; at: number }): WatchDTO {
  const p = price(w, h);
  return {
    ...w.ref(h),
    priceWei: p.toString(),
    alertPct: x.alertPct,
    baselineWei: x.baseline.toString(),
    change: x.baseline > 0n ? Number(((p - x.baseline) * 10_000n) / x.baseline) / 100 : 0,
    createdAt: new Date(x.at).toISOString(),
  };
}

function streakDTO(s: EngageState['streak']): StreakDTO {
  const n = nextStreak(s.lastDay, s.days, utcDayKey());
  const days = n.already || n.days > 1 ? s.days : 0;
  return { days, checkedInToday: n.already, lastDay: s.lastDay, nowPoints: n.already ? 0 : streakPoints(n.days), nextPoints: streakPoints((n.already ? days : n.days) + 1), perDay: 100, capDays: 7 };
}

/** Holders of the viewer's market, as fake addresses weighted like the seeded market. */
function holdersOf(w: MockWorld, handle: string) {
  const c = w.C[handle];
  const n = Math.max(0, (c?.holders ?? 1) - 1);
  return Array.from({ length: Math.min(n, 40) }, (_, i) => ({ address: fakeAddress(`holder:${handle}:${i}`), units: BigInt(100 + ((i * 37) % 400)) }));
}

/** One demo drop to the viewer from the first creator whose key they hold. */
function seedDemoDrop(w: MockWorld, st: EngageState) {
  if (!w.user || st.drops.some((d) => d.creator !== w.user!.handle)) return;
  const h = Object.keys(w.holdings).find((k) => (w.holdings[k] ?? 0) > 0 && w.C[k] && k !== w.user!.handle && !w.C[k]!.isMe);
  if (!h) return;
  const me = { address: w.user.wallet, units: BigInt(Math.round((w.holdings[h] ?? 0) * 100)) };
  const tree = buildAirdrop([me, ...holdersOf(w, h)], ethToWei(0.05));
  st.drops.push({
    id: st.drops.length,
    creator: h,
    root: tree.root,
    total: ethToWei(0.05),
    claimed: 0n,
    expiresAt: Date.now() + 6 * DAY,
    reclaimed: false,
    createdAt: Date.now() - 3_600_000,
    txHash: fakeHash(`drop:${h}`),
    allocations: new Map(tree.entries.map((e) => [lc(e.address), { amount: e.amount, proof: e.proof, claimed: false }])),
  });
}

function dropDTO(w: MockWorld, d: MockDrop): CreatorDropDTO {
  const claims = [...d.allocations.values()].filter((a) => a.claimed).length;
  return {
    id: d.id,
    creator: w.ref(d.creator),
    totalWei: d.total.toString(),
    claimedWei: d.claimed.toString(),
    holders: d.allocations.size,
    claims,
    expiresAt: new Date(d.expiresAt).toISOString(),
    reclaimed: d.reclaimed,
    createdAt: new Date(d.createdAt).toISOString(),
    txHash: d.txHash,
    canReclaim: w.user?.handle === d.creator && Date.now() >= d.expiresAt && !d.reclaimed && d.claimed < d.total,
  };
}

export function engageMockApi(w: MockWorld): Pick<
  SwayApi,
  | 'watchlist' | 'watch' | 'unwatch' | 'streak' | 'checkIn' | 'referrals' | 'notifPrefs' | 'setNotifPrefs'
  | 'pushConfig' | 'pushSubscribe' | 'pushUnsubscribe' | 'pushTest' | 'dropPlan' | 'userDrops' | 'claimableDrops'
> {
  const st = () => stateOf(w);
  return {
    async watchlist() {
      needUser(w);
      return { items: [...st().watches].sort((a, b) => b[1].at - a[1].at).map(([h, x]) => watchDTO(w, h, x)) };
    },
    async watch(handle, body) {
      const u = needUser(w);
      if (handle === u.handle) throw new ApiRequestError(400, 'self', 'You can’t watch your own key.');
      if (!w.C[handle]) throw new ApiRequestError(409, 'no_market', `@${handle} has no key market yet.`);
      const pct = body.alertPct ?? 10;
      if (pct !== 0 && (pct < 5 || pct > 100)) throw new ApiRequestError(400, 'bad_request', 'alertPct must be 0 or 5..100');
      const x = { alertPct: pct, baseline: price(w, handle), at: st().watches.get(handle)?.at ?? Date.now() };
      st().watches.set(handle, x);
      return watchDTO(w, handle, x);
    },
    async unwatch(handle) {
      needUser(w);
      st().watches.delete(handle);
      return { watching: false as const };
    },
    async streak() {
      needUser(w);
      return streakDTO(st().streak);
    },
    async checkIn() {
      needUser(w);
      const s = st().streak;
      const today = utcDayKey();
      const n = nextStreak(s.lastDay, s.days, today);
      let awarded = 0;
      if (!n.already) {
        s.days = n.days;
        s.lastDay = today;
        awarded = streakPoints(n.days);
        w.battlePts += awarded; // the mock's catch-all ledger bucket
      }
      return { ...streakDTO(s), awarded };
    },
    async referrals() {
      const u = needUser(w);
      const names = ['milo_onchain', 'pixelpriya', 'ravenbuilds', 'tessa_trades', 'okafor_eth'];
      const rows = names.slice(0, Math.max(2, Math.min(names.length, w.refs + 2))).map((h, i) => ({
        handle: h,
        name: h.replace(/_/g, ' '),
        avatarUrl: null,
        verified: i % 2 === 0,
        claimed: true,
        status: (i < w.refs ? 'credited' : i === names.length - 1 ? 'rejected' : 'pending') as 'credited' | 'pending' | 'rejected',
        reason: i === names.length - 1 ? 'X account younger than 30 days' : null,
        joinedAt: new Date(Date.now() - (i + 1) * 3 * DAY).toISOString(),
        creditedAt: i < w.refs ? new Date(Date.now() - (i + 1) * 2 * DAY).toISOString() : null,
        volumeWei: ethToWei(i < w.refs ? 0.08 * (i + 1) : 0).toString(),
      }));
      const credited = rows.filter((r) => r.status === 'credited').length;
      return {
        link: `${typeof location === 'undefined' ? 'http://localhost:3000' : location.origin}/i/${u.handle}`,
        invited: rows.length,
        credited,
        pending: rows.filter((r) => r.status === 'pending').length,
        points: credited * INVITE_POINTS,
        dailyCap: INVITES_CREDITED_PER_DAY,
        creditedToday: 0,
        pointsPerInvite: INVITE_POINTS,
        referralPendingWei: ethToWei(w.earned.ref).toString(),
        referralEarnedWei: ethToWei(w.earned.ref + credited * 0.0004).toString(),
        rows,
      };
    },
    async notifPrefs() {
      needUser(w);
      return { ...st().prefs };
    },
    async setNotifPrefs(body) {
      needUser(w);
      st().prefs = { ...st().prefs, ...body };
      return { ...st().prefs };
    },
    async pushConfig() {
      return { enabled: false, publicKey: null, subscriptions: 0 };
    },
    async pushSubscribe() {
      throw new ApiRequestError(409, 'push_unavailable', 'Push notifications need the live API (mock mode has no push service).');
    },
    async pushUnsubscribe() {
      return { ok: true as const };
    },
    async pushTest() {
      needUser(w);
      w.pushNotif({ type: 'points', from: 'swaydotfamily', body: [{ t: 'Push notifications are on.', b: true }], link: '/settings' });
      return { ok: true as const };
    },
    async dropPlan(body) {
      const u = needUser(w);
      const amount = BigInt(body.amountWei);
      if (amount < 10n ** 12n || amount > 1_000n * 10n ** 18n) throw new ApiRequestError(400, 'bad_amount', 'Drop between 0.000001 and 1,000 ETH.');
      const holders = holdersOf(w, u.handle);
      if (!holders.length) throw new ApiRequestError(409, 'no_holders', 'Nobody else holds your key yet.');
      const tree = buildAirdrop(holders, amount);
      st().plans.set(lc(tree.root), tree.entries.map((e) => ({ address: lc(e.address), amount: e.amount, proof: e.proof })));
      const units = new Map(holders.map((h) => [lc(h.address), h.units]));
      return {
        root: tree.root,
        totalWei: amount.toString(),
        holders: tree.entries.length,
        contract: MOCK_DROPS,
        minDays: 1,
        maxDays: 365,
        top: [...tree.entries]
          .sort((a, b) => (b.amount > a.amount ? 1 : -1))
          .slice(0, 20)
          .map((e) => ({ address: e.address, user: null, amountWei: e.amount.toString(), units: (units.get(lc(e.address)) ?? 0n).toString() })),
      };
    },
    async userDrops(handle) {
      seedDemoDrop(w, st());
      return st().drops.filter((d) => d.creator === handle).sort((a, b) => b.id - a.id).map((d) => dropDTO(w, d));
    },
    async claimableDrops() {
      const u = needUser(w);
      seedDemoDrop(w, st());
      const out: ClaimableDropDTO[] = [];
      for (const d of st().drops) {
        if (d.reclaimed || Date.now() >= d.expiresAt) continue;
        const a = d.allocations.get(lc(u.wallet));
        if (!a || a.claimed) continue;
        out.push({ id: d.id, creator: w.ref(d.creator), address: u.wallet, amountWei: a.amount.toString(), proof: a.proof, expiresAt: new Date(d.expiresAt).toISOString(), contract: MOCK_DROPS });
      }
      return out;
    },
  };
}

function handleWrite(w: MockWorld, st: EngageState, call: ContractCall): `0x${string}` | null {
  if (lc(call.address) !== lc(MOCK_DROPS)) return null;
  const u = needUser(w);
  const a = (call.args ?? []) as readonly unknown[];
  const hash = fakeHash(`drops:${call.functionName}:${Date.now()}:${Math.random()}`);
  if (call.functionName === 'create') {
    const plan = st.plans.get(lc(String(a[0])));
    const value = call.value ?? 0n;
    if (!plan) throw new Error('Unknown drop root');
    if (value > ethToWei(w.eth)) throw new Error('Not enough balance');
    w.eth -= weiToEth(value);
    st.drops.push({
      id: st.drops.length,
      creator: u.handle,
      root: String(a[0]) as `0x${string}`,
      total: value,
      claimed: 0n,
      expiresAt: Date.now() + Number(a[1]) * 1000,
      reclaimed: false,
      createdAt: Date.now(),
      txHash: hash,
      allocations: new Map(plan.map((p) => [p.address, { amount: p.amount, proof: p.proof, claimed: false }])),
    });
    w.log('Airdropped ETH to your holders', -weiToEth(value), hash);
    return hash;
  }
  const d = st.drops[Number(a[0])];
  if (!d) throw new Error('UnknownDrop');
  if (call.functionName === 'claim') {
    const al = d.allocations.get(lc(u.wallet));
    if (al?.claimed) throw new Error('AlreadyClaimed');
    // Same check as SwayDrops.claim: the (claimer, amount) leaf must prove into the drop's root.
    if (!al || !verifyMerkleProof(d.root, airdropLeaf(u.wallet, BigInt(a[1] as bigint)), a[2] as `0x${string}`[])) throw new Error('BadProof');
    al.claimed = true;
    d.claimed += al.amount;
    w.eth += weiToEth(al.amount);
    w.log(`Claimed airdrop from @${d.creator}`, weiToEth(al.amount), hash);
    return hash;
  }
  if (call.functionName === 'reclaim') {
    if (d.creator !== u.handle) throw new Error('NotCreator');
    if (Date.now() < d.expiresAt) throw new Error('NotExpired');
    d.reclaimed = true;
    w.eth += weiToEth(d.total - d.claimed);
    w.log('Took back unclaimed airdrop', weiToEth(d.total - d.claimed), hash);
    return hash;
  }
  return null;
}

export function installEngageMock(api: SwayApi, w: MockWorld): void {
  const prevWrite = w.mockContractWrite;
  w.mockContractWrite = (call) => handleWrite(w, stateOf(w), call) ?? prevWrite?.(call) ?? null;
  const baseConfig = api.config.bind(api);
  api.config = async () => {
    const c = await baseConfig();
    return { ...c, contracts: { ...c.contracts, drops: (c.contracts as { drops?: Address | null }).drops ?? MOCK_DROPS } };
  };
}
