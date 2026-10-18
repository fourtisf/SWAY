/**
 * In-memory implementation of SwayApi (NEXT_PUBLIC_API_MOCK=1). Same interface as the HTTP client, built
 * on the prototype's seed data and live simulation. Needs no API, chain or wallet.
 */
import { ethToWei, priceAt, quoteWei, weiToEth } from '@sway/curve';
import { POST_MAX, POST_MAX_STAKED, hash, normalizeHandle, type ConfigDTO, type LeaderboardRow, type MarketDTO } from '@sway/shared';
import { ApiRequestError, notifyAuthRequired, type SwayApi } from '../api';
import { emitMock } from './bus';
import { ETH_USD, fakeAddress, fakeHash } from './seed';
import { MockWorld } from './state';

let world: MockWorld | null = null;
let simStarted = false;

export function getWorld(): MockWorld {
  if (!world) world = new MockWorld();
  if (!simStarted && typeof window !== 'undefined') {
    simStarted = true;
    window.setInterval(() => world?.simTick(), 4200);
  }
  return world;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const notFound = (what: string) => new ApiRequestError(404, 'not_found', `${what} not found`);

function needUser(w: MockWorld) {
  if (!w.user) {
    notifyAuthRequired();
    throw new ApiRequestError(401, 'auth_required', 'Connect X first');
  }
  return w.user;
}

export function getMockApi(): SwayApi {
  const w = getWorld();
  const api: SwayApi = {
    async config(): Promise<ConfigDTO> {
      return {
        chainId: 31337,
        chainName: 'Robinhood Chain',
        rpcUrl: 'http://127.0.0.1:8545',
        explorerUrl: '',
        contracts: { swayKeys: fakeAddress('swaykeys'), swayStaking: null, genesisPass: null, fanEscrow: null, launchpad: null },
        ethUsd: ETH_USD,
        snapshotAt: new Date(w.snapshot).toISOString(),
        auth: { x: false, dev: true },
        wallets: { embedded: 'burner', walletConnectProjectId: null },
        mainnet: false,
      };
    },
    async price() {
      return { ethUsd: ETH_USD };
    },
    async me() {
      await tick();
      return w.me();
    },
    xStartUrl: (redirect) => `/api/auth/x/start?redirect=${encodeURIComponent(redirect)}`,
    xCallbackUrl: () => '/api/auth/x/callback',
    async devLogin({ handle, followers }) {
      w.login(handle, followers);
      return w.me()!;
    },
    async logout() {
      w.logout();
      return { ok: true };
    },
    async onboarding() {
      const on = !!w.user;
      return { profile: on, engagement: on, scored: on, wallet: on, market: on, marketTx: on ? fakeHash('market') : null };
    },
    async walletNonce() {
      needUser(w);
      return { nonce: 'mock', message: 'Sign in to Sway (mock)' };
    },
    async walletLink() {
      needUser(w);
      return w.me()!;
    },
    async openMarket() {
      needUser(w);
      return api.onboarding();
    },

    async feed({ tab }) {
      await tick();
      return { pinned: w.post(w.pinned, true), posts: w.feed(tab).map((p) => w.post(p)), nextCursor: null };
    },
    async createPost({ text, visibility }) {
      needUser(w);
      const max = w.level >= 1 ? POST_MAX_STAKED : POST_MAX;
      const t = text.trim();
      if (!t) throw new ApiRequestError(400, 'empty', 'Write something first');
      if (t.length > max) throw new ApiRequestError(400, 'too_long', `Posts are limited to ${max} characters`);
      return w.post(w.addPost(t, visibility));
    },
    async post(id) {
      const p = id === w.pinned.id ? w.pinned : w.posts.find((x) => x.id === id);
      if (!p) throw notFound('Post');
      return { post: w.post(p, p === w.pinned), replies: [] };
    },
    async like(id) {
      needUser(w);
      w.likes.has(id) ? w.likes.delete(id) : w.likes.add(id);
      const p = id === w.pinned.id ? w.pinned : w.posts.find((x) => x.id === id);
      return { liked: w.likes.has(id), count: (p?.likes ?? 0) + (w.likes.has(id) ? 1 : 0) };
    },
    async repost(id) {
      needUser(w);
      w.reposts.has(id) ? w.reposts.delete(id) : w.reposts.add(id);
      const p = id === w.pinned.id ? w.pinned : w.posts.find((x) => x.id === id);
      return { reposted: w.reposts.has(id), count: (p?.rp ?? 0) + (w.reposts.has(id) ? 1 : 0) };
    },
    async liveTrades(q) {
      return w.trades.slice(0, q?.limit ?? 20).map((t) => w.tradeDTO(t));
    },
    async search({ q }) {
      const s = q.trim().toLowerCase();
      if (!s) return { members: [], tags: [] };
      const qq = s.replace(/^[@#]/, '');
      return {
        members: Object.values(w.C)
          .filter((c) => c.handle.includes(qq) || c.name.toLowerCase().includes(qq))
          .slice(0, 6)
          .map((c) => w.market(c)),
        tags: w.tags.filter((t) => t.toLowerCase().includes(qq)).slice(0, 3).map((t) => ({ tag: t, posts: 400 + (hash(t) % 9000) })),
      };
    },
    async explore({ tab, sort = 'trending', q = '' }) {
      await tick();
      const qq = q.toLowerCase().replace(/^[@#]/, '');
      if (tab === 'tags') return { creators: [], tags: w.tags.filter((t) => !qq || t.toLowerCase().includes(qq)).map((t) => ({ tag: t, posts: 400 + (hash(t) % 9000) })) };
      let list = w.creators();
      if (qq) list = list.filter((c) => c.handle.includes(qq) || c.name.toLowerCase().includes(qq));
      if (tab === 'new') list.sort((a, b) => a.joined - b.joined);
      else {
        const sorts = {
          trending: (a: typeof list[0], b: typeof list[0]) => b.change - a.change,
          volume: (a: typeof list[0], b: typeof list[0]) => b.volume - a.volume,
          price: (a: typeof list[0], b: typeof list[0]) => priceAt(b.supply) - priceAt(a.supply),
          score: (a: typeof list[0], b: typeof list[0]) => b.score - a.score,
        };
        list.sort(sorts[sort]);
      }
      return { creators: list.map((c) => w.market(c)), tags: [] };
    },
    async markets({ tab }) {
      await tick();
      const list = (tab === 'creators' ? w.creators() : w.fans().filter((c) => c.cat === tab)).sort((a, b) => b.volume - a.volume);
      const markets: MarketDTO[] = list.map((c) => w.market(c));
      const vol = list.reduce((s, c) => s + c.volume, 0);
      return { stats: { markets: list.length, volumeWei: ethToWei(vol).toString(), holders: list.reduce((s, c) => s + c.holders, 0) }, markets };
    },

    async profile(handle) {
      await tick();
      const p = w.profile(normalizeHandle(handle));
      if (!p) throw notFound('Member');
      return p;
    },
    async profilePosts(handle) {
      return w.posts.filter((p) => p.author === handle).map((p) => w.post(p));
    },
    async holders(handle) {
      if (!w.C[handle]) throw notFound('Member');
      return w.holdersOf(handle);
    },
    async profileTrades(handle) {
      if (!w.C[handle]) throw notFound('Member');
      return w.tradesOf(handle);
    },
    async room(handle) {
      const c = w.C[handle];
      if (!c) throw notFound('Member');
      const oneKeyTotalWei = quoteWei(BigInt(Math.round(c.supply * 100)), 'buy', 100n, { level: w.level }).total.toString();
      if (!c.claimed) return { access: 'unclaimed', messages: [], oneKeyTotalWei };
      const held = (w.holdings[handle] || 0) >= 1 || !!c.isMe;
      if (!held) return { access: 'locked', messages: [], oneKeyTotalWei };
      return { access: 'open', messages: w.roomMsgs(handle).map((m) => w.msg(m)), oneKeyTotalWei };
    },
    async roomPost(handle, { text }) {
      const u = needUser(w);
      const c = w.C[handle];
      if (!c || !((w.holdings[handle] || 0) >= 1 || c.isMe)) throw new ApiRequestError(403, 'room_locked', 'Hold 1 key to enter');
      const m = { id: `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`, from: u.handle, text, at: Date.now() };
      w.roomMsgs(handle).push(m);
      const dto = w.msg(m);
      emitMock({ type: 'room', handle, data: dto });
      return dto;
    },
    async follow(handle) {
      needUser(w);
      w.following.has(handle) ? w.following.delete(handle) : w.following.add(handle);
      return { following: w.following.has(handle) };
    },
    async subscribe(handle, { txHash }) {
      needUser(w);
      const tx = w.txs.get(txHash);
      w.subs.add(handle);
      w.log('Subscribed to ' + (w.C[handle]?.name ?? handle), -(tx?.eth ?? 4 / ETH_USD), txHash);
      return { ok: true };
    },
    async tip(handle, { txHash }) {
      needUser(w);
      const tx = w.txs.get(txHash);
      w.log('Tipped ' + (w.C[handle]?.name ?? handle), -(tx?.eth ?? 5 / ETH_USD), txHash);
      return { ok: true };
    },
    async claimRequest() {
      return { ok: true };
    },

    async notifications({ tab }) {
      if (!w.user) return [];
      const f = tab === 'trades' ? (t: string) => t === 'trade' : tab === 'mentions' ? (t: string) => t === 'mention' || t === 'battle' : () => true;
      return w.notifs.filter((n) => f(n.type)).map((n) => w.notif(n));
    },
    async readAll() {
      needUser(w);
      w.notifs.forEach((n) => (n.read = true));
      return { ok: true };
    },
    async readOne(id) {
      needUser(w);
      const n = w.notifs.find((x) => x.id === id);
      if (n) n.read = true;
      return { ok: true };
    },
    async messages() {
      if (!w.user) return { rooms: [], dms: [] };
      return { rooms: w.roomThreads(), dms: w.threads.map((t) => w.thread(t)) };
    },
    async dmOpen({ handle }) {
      needUser(w);
      let t = w.threads.find((x) => x.with === handle);
      if (!t) {
        t = { id: 'd' + Date.now(), with: handle, unread: false, msgs: [] };
        w.threads.push(t);
      }
      return w.thread(t);
    },
    async dm(id) {
      needUser(w);
      const t = w.threads.find((x) => x.id === id);
      if (!t) throw notFound('Conversation');
      t.unread = false;
      return { thread: w.thread(t), messages: t.msgs.map((m) => w.msg(m)) };
    },
    async dmSend(id, { text }) {
      needUser(w);
      const t = w.threads.find((x) => x.id === id);
      if (!t) throw notFound('Conversation');
      return w.msg(w.sendDm(t, text));
    },

    async tasks() {
      if (!w.user) throw new ApiRequestError(401, 'auth_required', 'Connect X first');
      return { points: w.points(), tasks: w.taskList(), inviteLink: `sway.fam/i/${w.user.handle}`, invitesCredited: w.refs };
    },
    async taskVerify(id) {
      needUser(w);
      const def = w.taskList().find((t) => t.id === id);
      if (!def) throw notFound('Task');
      if (def.status === 'locked') throw new ApiRequestError(409, 'task_locked', 'Finish the previous task first');
      w.tasks[id] = { busy: true };
      setTimeout(() => {
        w.tasks[id] = { done: true, pts: def.pts };
        w.pushNotif({ type: 'points', from: 'swaydotfam', body: [{ t: 'Task verified on X: ' }, { t: def.title, b: true }, { t: `. +${def.pts.toLocaleString('en-US')} points.` }], link: '/tasks' });
      }, 1300);
      return { ...def, status: 'pending' };
    },
    async taskSkip(id) {
      needUser(w);
      w.tasks[id] = { done: true, pts: 0, skipped: true };
      return w.taskList().find((t) => t.id === id)!;
    },
    async wallet() {
      needUser(w);
      return w.wallet();
    },
    async withdrawLog({ label, amountWei, txHash }) {
      needUser(w);
      w.log(label, weiToEth(amountWei), txHash);
      const a = w.activity[w.activity.length - 1]!;
      return { id: a.id, label: a.label, amountWei, createdAt: new Date(a.at).toISOString(), txHash };
    },
    async faucet() {
      needUser(w);
      w.eth += 100 / ETH_USD;
      w.log('Deposit', 100 / ETH_USD);
      return { txHash: fakeHash('faucet' + Date.now()) };
    },

    async leaderboard({ tab }) {
      await tick();
      type Row = { handle: string; name: string; pts: number; won: number; fees: number; staked: number; me?: boolean };
      const rows: Row[] = w.LB.map((x) => ({ ...x }));
      if (w.user) rows.push({ handle: w.user.handle, name: w.user.name, pts: w.userPoints(), won: Math.max(0, w.battlePts), fees: w.claimable() + w.claimed, staked: w.staked, me: true });
      const key = ({ points: 'pts', creators: 'fees', stakers: 'staked', fighters: 'won' } as const)[tab];
      rows.sort((a, b) => b[key] - a[key]);
      const toRow = (r: Row, i: number): LeaderboardRow => ({
        rank: r.me && tab === 'points' ? w.myRank() : i + 1,
        user: w.ref(r.handle),
        points: r.pts,
        won: r.won,
        feesWei: ethToWei(r.fees).toString(),
        staked: r.staked,
        tier: w.tierName(r.pts),
        me: !!r.me,
      });
      const all = rows.map(toRow);
      return { rows: all.slice(0, 40), me: all.find((r) => r.me) ?? null };
    },
    async battles() {
      await tick();
      const all = [...w.myBattles, ...w.battles];
      return { weeklyPool: 184000, treasuryFeePct: 5, battles: all.map((b) => w.battle(b)) };
    },
    async createBattle({ opponent, theme, stake }) {
      const u = needUser(w);
      const opp = normalizeHandle(opponent || '');
      const c = w.C[opp];
      const b = c && !c.isMe && c.claimed ? opp : null;
      w.battlePts -= stake;
      const nb = { id: 'b' + Date.now(), a: u.handle, b, theme: theme || 'Best take of the week', tag: '#SwayBattle', stake, ends: Date.now() + 864e5, erA: 0.0001, erB: 0.0001, poolA: 0, poolB: 0 };
      w.myBattles.unshift(nb);
      return w.battle(nb);
    },
    async respondBattle(id) {
      needUser(w);
      const b = [...w.myBattles, ...w.battles].find((x) => x.id === id);
      if (!b) throw notFound('Battle');
      return w.battle(b);
    },
    async back(id, { side, amount }) {
      needUser(w);
      if (w.userPoints() < amount) throw new ApiRequestError(400, 'not_enough_points', 'Not enough points');
      const b = [...w.myBattles, ...w.battles].find((x) => x.id === id);
      if (!b) throw notFound('Battle');
      w.backed[id] = { side, amt: amount };
      w.battlePts -= amount;
      return w.battle(b);
    },
    async genesis() {
      await tick();
      const mr = w.user ? w.myRank() : null;
      const pts = w.userPoints();
      return {
        snapshotAt: new Date(w.snapshot).toISOString(),
        frozen: Date.now() >= w.snapshot,
        me: mr ? { rank: mr, points: pts, inCut: mr <= 500, sharePct: mr <= 500 ? w.genesisShare(mr) : 0, toCut: Math.max(0, w.ptsAtRank(500) - pts) } : null,
        split: [1, 10, 50, 100, 250, 500].map((r) => ({ rank: r, sharePct: w.genesisShare(r) })),
        top: w.LB.slice(0, 30).map((r, i) => ({ rank: i + 1, user: w.ref(r.handle), points: r.pts, sharePct: w.genesisShare(i + 1) })),
      };
    },
    async launchpad() {
      const u = w.user;
      return {
        symbol: u ? '$' + u.handle.replace(/[^a-z0-9]/g, '').slice(0, 6).toUpperCase() : '$YOU',
        score: u ? u.score : null,
        startCapUsd: u ? 2000 + u.score * 60 : null,
        launched: false,
        tokenAddress: null,
      };
    },
  };
  return api;
}
