/**
 * The prototype's in-memory world (`S`, `C`, POSTS, TRADES, ...) plus the mutations it supports, mapped to
 * the API DTOs. Money is kept as ETH floats exactly like the prototype and converted to wei strings at the
 * DTO boundary; trades are priced with the exact wei curve so they match the trade sheet preview.
 */
import {
  CURVE,
  FEE_TOTAL,
  area,
  ethToWei,
  priceAt,
  priceWei,
  quoteWei,
  inAntiDumpWindow,
  weiToEth,
  type Side,
} from '@sway/curve';
import { genesisSharePercent, scorePoints, tierOf, tierProgress, TIERS } from '@sway/scoring';
import {
  TAGS,
  TASKS,
  hash,
  makeFormat,
  type ActivityDTO,
  type Address,
  type BattleDTO,
  type HolderDTO,
  type MarketDTO,
  type MeDTO,
  type MessageDTO,
  type NotificationDTO,
  type NotificationType,
  type PointsDTO,
  type PostDTO,
  type ProfileDTO,
  type RichText,
  type TaskDTO,
  type ThreadDTO,
  type TradeDTO,
  type UserRef,
  type Visibility,
  type WalletDTO,
  type HoldingDTO,
  type WalletBalanceDTO,
  type WalletInfoDTO,
} from '@sway/shared';
import { emitMock } from './bus';
import {
  CREATORS_SEED,
  ETH_USD,
  FAN_SEED,
  OFFICIAL,
  PINNED_TEXT,
  POSTS_SEED,
  battlesSeed,
  buildLB,
  fakeAddress,
  fakeHash,
  makeUser,
  mkCreator,
  mkFan,
  randTrade,
  rng,
  type Creator,
  type LbRow,
  type MockUser,
  type SeedBattle,
  type SeedPost,
  type SeedTrade,
} from './seed';

const F = makeFormat(ETH_USD);
const iso = (ms: number) => new Date(ms).toISOString();
const U = (keys: number) => BigInt(Math.round(keys * 100));
const W = (eth: number) => ethToWei(eth).toString();

interface Msg {
  id: string;
  from: string;
  text: string;
  at: number;
}
interface Thread {
  id: string;
  with: string;
  unread: boolean;
  msgs: Msg[];
}
interface Notif {
  id: string;
  type: NotificationType;
  from: string;
  body: RichText;
  at: number;
  link: string | null;
  read: boolean;
}
interface Activity {
  id: string;
  label: string;
  amt: number;
  at: number;
  txHash: string | null;
}
interface MyTrade {
  h: string;
  buy: boolean;
  k: number;
  eth: number;
  at: number;
}

/** [A] A wallet the member added (mock mode keeps its money and keys apart from the account wallet). */
export interface MockLinkedWallet {
  address: Address;
  kind: 'embedded' | 'external';
  connector: string;
  label: string | null;
  createdAt: number;
  eth: number;
  holdings: Record<string, number>;
  earnedHolder: number;
  claimed: number;
}

let seq = 0;
const nid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

export class MockWorld {
  readonly now0 = Date.now();
  C: Record<string, Creator> = {};
  LB: LbRow[];
  LBH: Record<string, LbRow>;
  posts: SeedPost[];
  pinned: SeedPost;
  trades: SeedTrade[] = [];
  battles: SeedBattle[];
  myBattles: SeedBattle[] = [];
  snapshot = new Date('2026-10-27T15:00:00Z').getTime();

  user: MockUser | null = null;
  eth = 0.75;
  holdings: Record<string, number> = {};
  following = new Set<string>();
  subs = new Set<string>();
  likes = new Set<string>();
  reposts = new Set<string>();
  tasks: Record<string, { done?: boolean; busy?: boolean; pts?: number; skipped?: boolean }> = {};
  refs = 0;
  battlePts = 0;
  keyVolume = 0;
  earned = { creator: 0, holder: 0, ref: 0 };
  claimed = 0;
  /** Mock handlers for SwayWallet.writeContract (launchpad, staking…): return a tx hash or null. */
  mockContractWrite?: (call: import('../wallet/types').ContractCall) => `0x${string}` | null;
  rooms: Record<string, Msg[]> = {};
  backed: Record<string, { side: 'a' | 'b'; amt: number }> = {};
  myTrades: MyTrade[] = [];
  activity: Activity[] = [];
  notifs: Notif[] = [];
  threads: Thread[] = [];
  level = 0;
  staked = 0;
  /** Mock wallet transactions, so tip/subscribe can log what was sent. */
  txs = new Map<string, { to: string; eth: number }>();

  /* [A] wallets: the account wallet's money is `eth` / `earned` / `claimed` above and its keys are `holdings`
   * minus what linked wallets hold (`holdings` stays the member's total, which rooms and points read). */
  linked: MockLinkedWallet[] = [];
  account: { connector: string; kind: 'embedded' | 'external'; createdAt: number; label?: string | null } = { connector: 'sway', kind: 'embedded', createdAt: Date.now() };
  /** Average-cost basis per `${address}|${handle}` (ETH paid, fees included) and realized PnL. */
  basis: Record<string, { cost: number; realized: number }> = {};
  /** [D] Last buy per `${address}|${handle}` (anti-dump window) and creators under the activity bond. */
  lastBuy: Record<string, number> = {};
  inactive = new Set<string>();

  constructor() {
    CREATORS_SEED.forEach((a) => {
      const c = mkCreator(...a);
      this.C[c.handle] = c;
    });
    (Object.entries(FAN_SEED) as Array<[Creator['cat'], Array<[string, string, number]>]>).forEach(([cat, arr]) =>
      arr.forEach((a) => {
        const c = mkFan(cat, ...a);
        this.C[c.handle] = c;
      }),
    );
    this.LB = buildLB(this.creators());
    this.LBH = Object.fromEntries(this.LB.map((x) => [x.handle, x]));
    const now = this.now0;
    let pid = 100;
    this.pinned = { id: '99', author: OFFICIAL.handle, text: PINNED_TEXT, t: 19 * 60, vis: 'public', likes: 2840, rp: 611, rep: 402, boost: false, at: now - 19 * 60 * 60000 };
    this.posts = POSTS_SEED.map(([a, text, t, vis, likes, rp, rep, boost]) => ({ id: String(pid++), author: a, text, t, vis, likes, rp, rep, boost, at: now - t * 60000 }));
    this.battles = battlesSeed(now);
    const r = rng(4242);
    for (let i = 0; i < 24; i++) this.trades.push(randTrade(this.tradable(), this.LB, r, now - (i * 3.4 + Math.random() * 2) * 60000));
  }

  /* ------------------------------------------------------------ lookups */

  creators = () => Object.values(this.C).filter((c) => c.claimed && !c.isMe);
  fans = () => Object.values(this.C).filter((c) => !c.claimed);
  tradable = () => Object.values(this.C).filter((c) => !c.isMe);
  isMine = (h: string) => !!this.user && this.user.handle === h;

  ref(h: string): UserRef {
    if (h === OFFICIAL.handle) return { handle: h, name: OFFICIAL.name, avatarUrl: null, verified: true, official: true, claimed: true };
    const c = this.C[h];
    if (c) return { handle: h, name: c.name, avatarUrl: null, verified: c.verified, claimed: c.claimed };
    if (this.user && this.user.handle === h) return { handle: h, name: this.user.name, avatarUrl: null, verified: this.user.verified };
    const l = this.LBH[h];
    if (l) return { handle: h, name: l.name, avatarUrl: null, verified: false };
    return { handle: h, name: h, avatarUrl: null, verified: false };
  }

  subjectOf = (h: string): Address => fakeAddress('subject:' + h);
  bySubject = (s: string): Creator | undefined => Object.values(this.C).find((c) => this.subjectOf(c.handle).toLowerCase() === s.toLowerCase());

  market(c: Creator): MarketDTO {
    const u = U(c.supply);
    return {
      ...this.ref(c.handle),
      subject: this.subjectOf(c.handle),
      category: c.cat,
      claimed: c.claimed,
      followers: c.followers,
      score: c.score,
      reachValue: c.value,
      supplyUnits: u.toString(),
      priceWei: priceWei(u).toString(),
      holders: c.holders,
      volumeWei: W(c.volume),
      escrowWei: W(c.escrow),
      change: c.change,
      spark: c.hist.slice(-24),
      memberNo: c.claimed ? c.memberNo : null,
      joinedAt: iso(this.now0 - c.joined * 86400000),
    };
  }

  marketPatch(c: Creator) {
    const m = this.market(c);
    return { subject: m.subject, handle: m.handle, supplyUnits: m.supplyUnits, priceWei: m.priceWei, holders: m.holders, volumeWei: m.volumeWei, change: m.change };
  }

  profile(h: string): ProfileDTO | null {
    const c = this.C[h];
    if (!c) return null;
    const isMe = !!c.isMe;
    return {
      ...this.market(c),
      bio: c.bio,
      ownerAddress: c.claimed ? (isMe && this.user ? this.user.wallet : fakeAddress('owner:' + h)) : null,
      isMe,
      following: this.following.has(h),
      subscribed: this.subs.has(h),
      heldUnits: U(this.holdings[h] || 0).toString(),
      heldBy: this.walletInfos()
        .map((wi) => ({ address: wi.address, units: U(this.unitsBy(wi.address, h)).toString() }))
        .filter((x) => x.units !== '0'),
      blocked: this.blocked.has(h), // [B]
      creatorInactive: this.inactive.has(h), // [D]
      lastBuyAt: Object.fromEntries(
        this.walletInfos()
          .filter((wi) => this.lastBuy[`${wi.address.toLowerCase()}|${h}`])
          .map((wi) => [wi.address.toLowerCase(), iso(this.lastBuy[`${wi.address.toLowerCase()}|${h}`]!)]),
      ),
      history: c.hist.map((p, i) => ({ t: iso(this.now0 - (c.hist.length - i) * 3600000), priceWei: W(p) })),
    };
  }

  /* ------------------------------------------------------------ posts */

  locked(p: SeedPost): boolean {
    const mine = this.isMine(p.author);
    const held = (this.holdings[p.author] || 0) >= 1 || mine;
    return (p.vis === 'holders' && !held) || (p.vis === 'subs' && !this.subs.has(p.author) && !mine);
  }

  post(p: SeedPost, pinned = false): PostDTO {
    const c = this.C[p.author];
    const locked = this.locked(p);
    const liked = this.likes.has(p.id),
      rp = this.reposts.has(p.id);
    return {
      id: p.id,
      author: {
        ...this.ref(p.author),
        subject: c ? this.subjectOf(c.handle) : null,
        priceWei: c ? priceWei(U(c.supply)).toString() : null,
        change: c ? c.change : 0,
      },
      text: locked ? null : p.text,
      teaser: locked ? p.text : null,
      locked,
      // [B]
      media: locked ? [] : (p.media ?? []),
      hidden: !!p.hidden,
      boostedUntil: p.boostedUntil ? iso(p.boostedUntil) : null,
      visibility: p.vis,
      pinned,
      boosted: p.boost || (p.boostedUntil ?? 0) > Date.now(),
      parentId: p.parentId ?? null,
      createdAt: iso(p.at),
      likes: p.likes + (liked ? 1 : 0),
      reposts: p.rp + (rp ? 1 : 0),
      replies: p.rep,
      liked,
      reposted: rp,
      mine: this.isMine(p.author),
    };
  }

  /** [B] Not deleted; hidden only for admins and the author; nothing from accounts you blocked. */
  visible = (p: SeedPost): boolean =>
    !p.deleted && (!p.hidden || this.isAdmin() || this.isMine(p.author)) && !this.blocked.has(p.author);

  feed(tab: string): SeedPost[] {
    const mins = (p: SeedPost) => (Date.now() - p.at) / 60000;
    let list = this.posts.filter((p) => !p.parentId && this.visible(p)); // [B]
    const boosted = (p: SeedPost) => p.boost || (p.boostedUntil ?? 0) > Date.now(); // [B]
    const sc = (p: SeedPost) => (p.likes + p.rp * 2 + p.rep * 3) / (1 + mins(p) / 120) + (boosted(p) ? 400 : 0) + (this.C[p.author]?.score || 60) * 3;
    if (tab === 'foryou') list.sort((a, b) => sc(b) - sc(a));
    if (tab === 'trending') list.sort((a, b) => b.likes + b.rp * 2 - (a.likes + a.rp * 2));
    if (tab === 'latest') list.sort((a, b) => b.at - a.at);
    if (tab === 'following')
      list = list.filter((p) => this.following.has(p.author) || (this.holdings[p.author] || 0) > 0 || this.isMine(p.author)).sort((a, b) => b.at - a.at);
    return list;
  }

  addPost(text: string, vis: Visibility): SeedPost {
    const p: SeedPost = { id: nid('p'), author: this.user!.handle, text, t: 0, vis, likes: 0, rp: 0, rep: 0, boost: false, at: Date.now() };
    this.posts.unshift(p);
    return p;
  }

  /* ------------------------------------------------------------ trades */

  tradeDTO(t: { id: string; buyer: string; c: string; buy: boolean; k: number; eth: number; t: number; supplyAfter: number }): TradeDTO {
    const fee = t.buy ? 1 + FEE_TOTAL : 1 - FEE_TOTAL;
    return {
      txHash: fakeHash(t.id),
      logIndex: 0,
      trader: { ...this.ref(t.buyer), address: fakeAddress('trader:' + t.buyer) },
      market: { ...this.ref(t.c), subject: this.subjectOf(t.c) },
      isBuy: t.buy,
      units: U(t.k).toString(),
      baseWei: W(t.eth),
      totalWei: W(t.eth * fee),
      supplyAfter: U(t.supplyAfter).toString(),
      ts: iso(t.t),
    };
  }

  pushTrade(t: SeedTrade) {
    this.trades.unshift(t);
    if (this.trades.length > 40) this.trades.pop();
    emitMock({ type: 'trade', data: this.tradeDTO(t) });
    const c = this.C[t.c];
    if (c) emitMock({ type: 'market', data: this.marketPatch(c) });
  }

  bumpHist(c: Creator) {
    c.hist.push(priceAt(c.supply));
    c.change = (priceAt(c.supply) / c.hist[Math.max(0, c.hist.length - 25)]! - 1) * 100;
  }

  /**
   * The prototype's execTrade(), priced with the exact wei quote. Throws like the contract would. [A] `from` is
   * the trading wallet (default: the account wallet); its own balance and keys are used.
   */
  execTrade(h: string, side: Side, units: bigint, from?: string): number {
    const c = this.C[h];
    if (!c || !this.user) throw new Error('Market not found');
    const k = Number(units) / 100;
    const had = this.holdings[h] || 0;
    const lw = from ? this.linkedOf(from) : undefined;
    const addr = lw ? lw.address : this.user.wallet;
    const mine = lw ? lw.holdings[h] || 0 : this.accountUnits(h);
    const bk = `${addr.toLowerCase()}|${h}`;
    const q = quoteWei(U(c.supply), side, units, {
      level: this.level,
      creatorInactive: this.inactive.has(h),
      antiDump: side === 'sell' && inAntiDumpWindow(this.lastBuy[bk]),
    });
    const total = weiToEth(q.total),
      base = weiToEth(q.base);
    const b = (this.basis[bk] ??= { cost: 0, realized: 0 });
    if (side === 'buy') {
      if (q.total > ethToWei(lw ? lw.eth : this.eth)) throw new Error('Not enough balance');
      if (lw) lw.eth -= total;
      else this.eth -= total;
      c.supply = +(c.supply + k).toFixed(2);
      this.holdings[h] = +(had + k).toFixed(2);
      if (lw) lw.holdings[h] = +(mine + k).toFixed(2);
      b.cost += total;
      this.lastBuy[bk] = Date.now();
      if (had < 0.0001) c.holders++;
      if (!c.claimed) c.escrow += weiToEth(q.creatorFee);
    } else {
      const sellable = c.isMe && !lw ? mine - 1 : mine;
      if (k > sellable + 1e-9) throw new Error('More than you hold');
      if (lw) lw.eth += total;
      else this.eth += total;
      c.supply = +(c.supply - k).toFixed(2);
      this.holdings[h] = +(had - k).toFixed(2);
      if (lw) lw.holdings[h] = +Math.max(0, mine - k).toFixed(2);
      const sold = mine > 0 ? (b.cost * k) / mine : 0;
      b.cost -= sold;
      b.realized += total - sold;
      if (this.holdings[h]! < 0.0001) {
        this.holdings[h] = 0;
        c.holders = Math.max(1, c.holders - 1);
      }
    }
    c.volume += base;
    this.keyVolume += base;
    this.bumpHist(c);
    this.myTrades.push({ h, buy: side === 'buy', k, eth: total, at: Date.now() });
    this.log(`${side === 'buy' ? 'Bought' : 'Sold'} ${F.keys(k)} key${k === 1 ? '' : 's'} of ${c.name}`, side === 'buy' ? -total : total);
    this.pushTrade({ id: nid('t'), buyer: this.user.handle, c: h, buy: side === 'buy', k, eth: base, t: Date.now(), supplyAfter: c.supply });
    return total;
  }

  log(label: string, amt: number, txHash: string | null = null) {
    this.activity.push({ id: nid('a'), label, amt, at: Date.now(), txHash });
  }

  /* ------------------------------------------------------------ wallet & points */

  holdValue(): number {
    let v = 0;
    for (const [h, k] of Object.entries(this.holdings)) {
      const c = this.C[h];
      if (c && !c.isMe && k > 0) v += area(c.supply - k, c.supply) * (1 - FEE_TOTAL);
    }
    return v;
  }

  keysHeld() {
    let n = 0,
      m = 0;
    for (const [h, k] of Object.entries(this.holdings))
      if (k > 0 && !this.C[h]?.isMe) {
        n += k;
        m++;
      }
    return { n, m };
  }

  claimable = () => this.earned.creator + this.earned.holder + this.earned.ref + this.linked.reduce((t, l) => t + l.earnedHolder, 0);

  userPoints(): number {
    if (!this.user) return 0;
    let p = scorePoints(this.user.score);
    Object.values(this.tasks).forEach((t) => {
      if (t.done) p += t.pts || 0;
    });
    p += this.refs * 500 + this.battlePts + this.holdValue() * 400000 + this.keyVolume * 100000;
    return Math.max(0, Math.round(p));
  }

  myRank(): number {
    const p = this.userPoints();
    let r = 1;
    for (const x of this.LB) if (x.pts > p) r++;
    if (r > this.LB.length) r = Math.min(19800, Math.max(this.LB.length + 1, Math.round(Math.pow(3.4e6 / Math.max(p, 1), 1 / 0.62))));
    return r;
  }

  points(): PointsDTO {
    const total = this.userPoints();
    const tp = tierProgress(total);
    const score = this.user ? scorePoints(this.user.score) : 0;
    const held = Math.round(this.holdValue() * 400000);
    return {
      total,
      score,
      held,
      ledger: total - score - held,
      tier: tp.tier.name,
      tierIndex: tp.index,
      nextTier: tp.next?.name ?? null,
      toNext: tp.toNext,
      progress: tp.progress,
      rank: this.myRank(),
      earned: Math.max(0, total - score),
    };
  }

  me(): MeDTO | null {
    const u = this.user;
    if (!u) return null;
    return {
      user: { ...this.ref(u.handle), id: 'u-' + u.handle, memberNo: u.memberNo, score: u.score, reachValue: u.value, followers: u.followers },
      wallet: { address: u.wallet, kind: this.account.kind },
      market: { subject: this.subjectOf(u.handle), opened: true },
      wallets: this.walletInfos(),
      points: this.points(),
      stakingLevel: this.level,
      unreadNotifications: this.notifs.filter((n) => !n.read).length,
      unreadMessages: this.threads.filter((t) => t.unread).length,
      isAdmin: this.isAdmin(), // [B]
    };
  }

  /* ------------------------------------------------------------ [B] moderation */

  /** Handles the signed-in member blocked. */
  blocked = new Set<string>();
  /** Mock mode: members whose handle starts with "admin" are admins (e.g. connect as @admin). */
  isAdmin = (): boolean => !!this.user && this.user.handle.startsWith('admin');

  wallet(): WalletDTO {
    const u = this.user!;
    const e = this.earned;
    const wallets = this.walletBalances();
    const holdings = this.holdingRows();
    const sum = (f: (x: WalletBalanceDTO) => string) => wallets.reduce((t, x) => t + BigInt(f(x)), 0n).toString();
    const kh = this.keysHeld();
    return {
      address: u.wallet,
      kind: this.account.kind,
      cashWei: sum((x) => x.cashWei),
      keysValueWei: holdings.reduce((t, x) => t + BigInt(x.valueWei), 0n).toString(),
      earnings: {
        creatorWei: W(e.creator),
        holderWei: sum((x) => x.earnings.holderWei),
        referralWei: W(e.ref),
        totalWei: sum((x) => x.earnings.totalWei),
        claimedWei: sum((x) => x.earnings.claimedWei),
        claimSubjects: wallets[0]!.earnings.claimSubjects,
      },
      keys: { units: U(kh.n).toString(), markets: kh.m },
      holdings,
      activity: this.activity
        .slice()
        .reverse()
        .map((a): ActivityDTO => ({ id: a.id, label: a.label, amountWei: W(a.amt), createdAt: iso(a.at), txHash: a.txHash })),
      wallets,
    };
  }

  /* ------------------------------------------------------------ [A] wallets */

  linkedOf = (address: string): MockLinkedWallet | undefined => this.linked.find((l) => l.address.toLowerCase() === address.toLowerCase());

  /** The account wallet's own units of a market (the member's total minus linked wallets). */
  accountUnits(h: string): number {
    const rest = this.linked.reduce((t, l) => t + (l.holdings[h] || 0), 0);
    return Math.max(0, +((this.holdings[h] || 0) - rest).toFixed(2));
  }

  unitsBy(address: string, h: string): number {
    const lw = this.linkedOf(address);
    return lw ? lw.holdings[h] || 0 : this.accountUnits(h);
  }

  walletInfos(): WalletInfoDTO[] {
    const u = this.user;
    if (!u) return [];
    return [
      { address: u.wallet, kind: this.account.kind, connector: this.account.connector, label: this.account.label ?? null, account: true, createdAt: iso(this.account.createdAt) },
      ...this.linked.map((l) => ({ address: l.address, kind: l.kind, connector: l.connector, label: l.label, account: false, createdAt: iso(l.createdAt) })),
    ];
  }

  /** Sell value of `k` keys of a market (the locked first key never counts). */
  private valueOf(h: string, k: number): number {
    const c = this.C[h];
    if (!c || k <= 0) return 0;
    return area(c.supply - Math.min(k, c.supply - 1), c.supply) * (1 - FEE_TOTAL);
  }

  holdingRows(): HoldingDTO[] {
    const rows: HoldingDTO[] = [];
    for (const wi of this.walletInfos()) {
      for (const h of Object.keys(this.holdings)) {
        const k = this.unitsBy(wi.address, h);
        if (k <= 0 || this.C[h]?.isMe) continue;
        const value = this.valueOf(h, k);
        const b = this.basis[`${wi.address.toLowerCase()}|${h}`] ?? { cost: 0, realized: 0 };
        rows.push({
          market: this.market(this.C[h]!),
          units: U(k).toString(),
          valueWei: W(value),
          address: wi.address,
          costBasisWei: W(b.cost),
          avgCostWei: W(k > 0 ? b.cost / k : 0),
          unrealizedPnlWei: W(value - b.cost),
          realizedPnlWei: W(b.realized),
        });
      }
    }
    return rows.sort((a, b) => (BigInt(b.valueWei) > BigInt(a.valueWei) ? 1 : -1));
  }

  walletBalances(): WalletBalanceDTO[] {
    const rows = this.holdingRows();
    return this.walletInfos().map((wi) => {
      const lw = wi.account ? undefined : this.linkedOf(wi.address);
      const mine = rows.filter((r) => r.address === wi.address);
      const held = Object.keys(this.holdings).filter((h) => this.unitsBy(wi.address, h) > 0 || (wi.account && this.C[h]?.isMe));
      const creator = lw ? 0 : this.earned.creator,
        holder = lw ? lw.earnedHolder : this.earned.holder,
        ref = lw ? 0 : this.earned.ref;
      return {
        ...wi,
        cashWei: W(lw ? lw.eth : this.eth),
        keysValueWei: mine.reduce((t, r) => t + BigInt(r.valueWei), 0n).toString(),
        keys: { units: mine.reduce((t, r) => t + BigInt(r.units), 0n).toString(), markets: mine.length },
        earnings: {
          creatorWei: W(creator),
          holderWei: W(holder),
          referralWei: W(ref),
          totalWei: W(creator + holder + ref),
          claimedWei: W(lw ? lw.claimed : this.claimed),
          claimSubjects: held.map((h) => this.subjectOf(h)),
        },
      };
    });
  }

  /** Simulated wallet app balance for a newly connected external wallet (deterministic per address). */
  static demoBalance = (address: string) => 0.04 + (hash(address) % 120) / 1000;

  /* ------------------------------------------------------------ session */

  login(handle: string, followers?: number) {
    const u = makeUser(handle, followers);
    this.user = u;
    // [A] a new member starts with just the account wallet
    this.linked = [];
    this.basis = {};
    this.account = { connector: 'sway', kind: 'embedded', createdAt: Date.now() };
    const me = mkCreator(u.name, u.handle, u.followers, 'New on Sway. Holders get my room.', u.verified, { isMe: true, memberNo: u.memberNo });
    Object.assign(me, { score: u.score, value: u.value, supply: 1, holders: 1, volume: 0, hist: Array(40).fill(priceAt(1)), change: 0, extraHolders: {} });
    this.C[u.handle] = me;
    this.holdings[u.handle] = 1;
    const now = Date.now();
    this.notifs = [
      { id: 'n1', type: 'points', from: OFFICIAL.handle, body: [{ t: 'Your Sway score is ' }, { t: String(u.score), b: true }, { t: `. ${F.int(Math.min(10000, u.score * 100))} points are on your balance.` }], at: now - 60000, link: '/tasks', read: false },
      { id: 'n2', type: 'mention', from: 'atlas_rsch', body: [{ t: 'Atlas Research', b: true }, { t: ` mentioned you: “welcome @${u.handle}, the model docs are pinned”` }], at: now - 3 * 60000, link: '/', read: false },
      { id: 'n3', type: 'battle', from: 'makotrades', body: [{ t: 'Mako', b: true }, { t: ' wants a friendly battle: “best one-line take this week”' }], at: now - 9 * 60000, link: '/battles', read: false },
    ];
    this.threads = [
      { id: 'd1', with: OFFICIAL.handle, unread: true, msgs: [{ id: nid('m'), from: OFFICIAL.handle, text: `Welcome to Sway, ${u.name}. Your key market is live and your first key is locked to you, so your room always has an owner.`, at: now }] },
      { id: 'd2', with: 'priyasol', unread: true, msgs: [{ id: nid('m'), from: 'priyasol', text: 'hey! building a dashboard on the indexer, want early access?', at: now }] },
    ];
  }

  logout() {
    if (this.user) delete this.C[this.user.handle];
    this.user = null;
    this.holdings = {};
    this.notifs = [];
    this.threads = [];
    this.tasks = {};
    this.activity = [];
    this.earned = { creator: 0, holder: 0, ref: 0 };
    this.eth = 0.75;
    this.linked = [];
    this.basis = {};
    this.account = { connector: 'sway', kind: 'embedded', createdAt: Date.now() };
    this.blocked.clear(); // [B]
  }

  /* ------------------------------------------------------------ notifications */

  notif(n: Notif): NotificationDTO {
    return { id: n.id, type: n.type, from: this.ref(n.from), body: n.body, link: n.link, createdAt: iso(n.at), read: n.read };
  }

  pushNotif(n: Omit<Notif, 'id' | 'at' | 'read'>) {
    const full: Notif = { ...n, id: nid('n'), at: Date.now(), read: false };
    this.notifs.unshift(full);
    emitMock({ type: 'notification', data: this.notif(full) });
  }

  /* ------------------------------------------------------------ rooms & dms */

  roomMsgs(h: string): Msg[] {
    const c = this.C[h]!;
    if (!this.rooms[h])
      this.rooms[h] = c.isMe
        ? [{ id: nid('m'), from: h, text: 'Welcome to my room. Holders see everything I post here first.', at: Date.now() }]
        : [
            { id: nid('m'), from: h, text: 'Welcome in. Pinned: today’s notes drop at 20:00 UTC.', at: Date.now() - 3 * 60000 },
            { id: nid('m'), from: this.LB[3]!.handle, text: 'Saw the curve move 12% after the last post, nice', at: Date.now() - 2 * 60000 },
            { id: nid('m'), from: h, text: 'Ask anything here. I answer holders first.', at: Date.now() - 60000 },
          ];
    return this.rooms[h]!;
  }

  msg(m: Msg): MessageDTO {
    return { id: m.id, from: this.ref(m.from), text: m.text, createdAt: iso(m.at), mine: this.isMine(m.from) };
  }

  roomThreads(): ThreadDTO[] {
    return Object.entries(this.holdings)
      .filter(([h, k]) => k >= 1 && this.C[h]?.claimed)
      .map(([h]) => ({ id: 'room-' + h, kind: 'room' as const, with: this.ref(h), last: this.roomMsgs(h).slice(-1)[0]?.text || '', unread: false, holders: this.C[h]!.holders }));
  }

  thread(t: Thread): ThreadDTO {
    return { id: t.id, kind: 'dm', with: this.ref(t.with), last: t.msgs.slice(-1)[0]?.text || '', unread: t.unread };
  }

  sendDm(t: Thread, text: string): Msg {
    const m: Msg = { id: nid('m'), from: this.user!.handle, text, at: Date.now() };
    t.msgs.push(m);
    if (t.with === 'priyasol' && t.msgs.length === 2)
      setTimeout(() => {
        const r: Msg = { id: nid('m'), from: 'priyasol', text: 'amazing, sending the link to your room 🙌', at: Date.now() };
        t.msgs.push(r);
        t.unread = true;
        emitMock({ type: 'dm', threadId: t.id, data: this.msg(r) });
      }, 1400);
    return m;
  }

  /* ------------------------------------------------------------ tasks */

  taskList(): TaskDTO[] {
    let unlocked = true;
    return TASKS.map((tk) => {
      let st = this.tasks[tk.id] || {};
      if (tk.auto && this.keysHeld().m > 0 && !st.done) this.tasks[tk.id] = st = { done: true, pts: tk.pts };
      const lock = !unlocked && tk.group === 'Join checklist';
      if (!st.done && tk.group === 'Join checklist') unlocked = false;
      const status: TaskDTO['status'] = st.done ? (st.skipped ? 'skipped' : 'verified') : lock ? 'locked' : st.busy ? 'pending' : 'open';
      return { id: tk.id, title: tk.title, pts: tk.pts, icon: tk.icon, group: tk.group, skippable: !!tk.skippable, auto: !!tk.auto, status };
    });
  }

  /* ------------------------------------------------------------ holders / trades of a profile */

  holdersOf(h: string): HolderDTO[] {
    const c = this.C[h]!;
    const r = rng(hash(h + 'h'));
    const out: Array<{ handle: string; k: number; you: boolean }> = [{ handle: h, k: 1, you: !!c.isMe }];
    if (c.isMe) {
      Object.entries(c.extraHolders || {}).forEach(([x, k]) => out.push({ handle: x, k, you: false }));
    } else {
      let left = c.supply - 1 - (this.holdings[h] || 0);
      for (let i = 0; i < Math.min(c.holders - 1, 12) && left > 0.01; i++) {
        const p = this.LB[Math.floor(r() * 40)]!;
        const k = +Math.min(left, 0.2 + r() * left * 0.5).toFixed(2);
        left -= k;
        out.push({ handle: p.handle, k, you: false });
      }
      if ((this.holdings[h] || 0) > 0 && this.user) out.push({ handle: this.user.handle, k: this.holdings[h]!, you: true });
    }
    return out.sort((a, b) => b.k - a.k).map((x) => ({ ...this.ref(x.handle), units: U(x.k).toString(), you: x.you }));
  }

  tradesOf(h: string): TradeDTO[] {
    const c = this.C[h]!;
    const now = Date.now();
    type Row = { id: string; buyer: string; buy: boolean; k: number; eth: number; t: number };
    const live: Row[] = this.trades.filter((t) => t.c === h).map((t) => ({ id: t.id, buyer: t.buyer, buy: t.buy, k: t.k, eth: t.eth, t: t.t }));
    const r = rng(hash(h + 't'));
    const out = [...live];
    if (!c.isMe)
      for (let i = 0; i < 8; i++) {
        const p = this.LB[Math.floor(r() * 30)]!;
        const k = +(0.1 + r() * 2).toFixed(2);
        out.push({ id: `g${h}${i}`, buyer: p.handle, buy: r() > 0.35, k, eth: area(Math.max(1, c.supply - k), c.supply) * 1.1, t: now - (90 + i * 47 + r() * 30) * 60000 });
      }
    return out.sort((a, b) => b.t - a.t).map((x) => this.tradeDTO({ ...x, c: h, supplyAfter: c.supply }));
  }

  /* ------------------------------------------------------------ battles */

  battle(b: SeedBattle): BattleDTO {
    const mine = this.backed[b.id];
    const A = this.C[b.a]!,
      B = b.b ? this.C[b.b] : undefined;
    return {
      id: b.id,
      a: this.market(A),
      b: B ? this.market(B) : null,
      theme: b.theme,
      tag: b.tag,
      stake: b.stake,
      status: B ? 'live' : 'pending',
      endsAt: iso(b.ends),
      erA: b.erA,
      erB: b.erB,
      poolA: b.poolA + (mine && mine.side === 'a' ? mine.amt : 0),
      poolB: b.poolB + (mine && mine.side === 'b' ? mine.amt : 0),
      winner: null,
      myBacking: mine ? { side: mine.side, amount: mine.amt } : null,
      canRespond: false,
    };
  }

  /* ------------------------------------------------------------ live simulation (prototype simTick) */

  simTick() {
    const r = Math.random;
    let t: SeedTrade;
    if (this.user && r() < 0.16) {
      const me = this.C[this.user.handle]!,
        b = this.LB[Math.floor(r() * this.LB.length)]!,
        k = +(r() < 0.6 ? 1 : 0.1 + r() * 0.9).toFixed(2);
      const base = area(me.supply, me.supply + k);
      me.supply = +(me.supply + k).toFixed(2);
      me.volume += base;
      me.hist.push(priceAt(me.supply));
      me.extraHolders = me.extraHolders || {};
      me.extraHolders[b.handle] = +((me.extraHolders[b.handle] || 0) + k).toFixed(2);
      me.holders = 1 + Object.keys(me.extraHolders).length;
      this.earned.creator += base * CURVE.CREATOR;
      t = { id: nid('t'), buyer: b.handle, c: this.user.handle, buy: true, k, eth: base, t: Date.now(), supplyAfter: me.supply };
      this.pushNotif({ type: 'trade', from: b.handle, body: [{ t: b.name, b: true }, { t: ` bought ${F.keys(k)} of your keys. You earned ` }, { t: F.$(base * CURVE.CREATOR), b: true }, { t: '.' }], link: '/wallet' });
    } else {
      t = randTrade(this.tradable(), this.LB, r, Date.now());
      const c = this.C[t.c]!;
      if (t.buy) c.supply = +(c.supply + t.k).toFixed(2);
      else c.supply = +Math.max(1, c.supply - t.k).toFixed(2);
      t.supplyAfter = c.supply;
      c.volume += t.eth;
      this.bumpHist(c);
      const held = this.holdings[t.c] || 0;
      if (this.user && held > 0 && !c.isMe) {
        // [A] each wallet earns on its own keys
        this.earned.holder += t.eth * CURVE.HOLDERS * (this.accountUnits(t.c) / c.supply);
        for (const l of this.linked) if (l.holdings[t.c]) l.earnedHolder += t.eth * CURVE.HOLDERS * (l.holdings[t.c]! / c.supply);
      }
      if (this.user && r() < 0.12) this.earned.ref += t.eth * CURVE.REF * 0.5;
    }
    this.pushTrade(t);
  }

  /* ------------------------------------------------------------ misc */

  genesisShare = (rank: number) => genesisSharePercent(rank);
  ptsAtRank = (r: number) => 3.4e6 * Math.pow(r, -0.62);
  tierName = (pts: number) => tierOf(pts).name;
  tiers = TIERS;
  tags = TAGS;
}
