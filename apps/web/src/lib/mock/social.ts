/**
 * [B] Mock mode for SOCIAL_ROUTES (post menu, boosts, reports, blocks, images, threads, settings, admin).
 * Admins are members whose handle starts with "admin" (connect as @admin to see /admin). Uploads stay in the
 * browser as object URLs. installSocialMock() also teaches createPost/post/profilePosts/messages about
 * images, replies, blocks and hidden posts.
 */
import { ethToWei, usdToWei } from '@sway/curve';
import { tierOf } from '@sway/scoring';
import {
  BOOST_HOURS,
  BOOST_USD_DEFAULT,
  POST_MAX,
  POST_MAX_STAKED,
  POST_MEDIA_MAX,
  UPLOAD_MAX_BYTES,
  deleteConfirmText,
  hash,
  normalizeHandle,
  type AccountExport,
  type Address,
  type AdminClaimDTO,
  type AdminMarketDTO,
  type AdminMemberDTO,
  type AdminReportDTO,
  type MarketCategory,
  type PriceHistoryResponse,
  type ReportReason,
  type ReportStatus,
  type UploadDTO,
  type UploadMime,
} from '@sway/shared';
import { ApiRequestError, notifyAuthRequired, type SwayApi } from '../api';
import { ETH_USD, OFFICIAL, fakeAddress, fakeHash, mkFan, type SeedPost } from './seed';
import type { MockWorld } from './state';

type SocialKeys =
  | 'deletePost' | 'boostQuote' | 'boostPost' | 'pinPost' | 'report' | 'block' | 'upload' | 'uploadFileUrl' | 'priceHistory'
  | 'card' | 'account' | 'exportData' | 'deleteAccount' | 'adminReports' | 'adminResolveReport' | 'adminHidePost'
  | 'adminClaims' | 'adminResolveClaim' | 'adminMembers' | 'adminBotFlag' | 'adminSetAdmin' | 'adminMarkets'
  | 'adminHaltMarket' | 'adminOpenFanMarket';

interface Report {
  id: string;
  reporter: string;
  postId: string | null;
  target: string;
  reason: ReportReason;
  note: string | null;
  status: ReportStatus;
  at: number;
}
interface Claim {
  id: string;
  handle: string;
  kind: 'claim' | 'takedown';
  contact: string;
  note: string | null;
  status: 'open' | 'resolved';
  from: string | null;
  at: number;
}
interface SocialState {
  reports: Report[];
  claims: Claim[];
  uploads: Map<string, UploadDTO>;
  usedTx: Set<string>;
  halted: Set<string>;
  bots: Map<string, string>;
  admins: Set<string>;
  repliesSeeded: Set<string>;
}

export const MOCK_TREASURY = fakeAddress('treasury');
const states = new WeakMap<MockWorld, SocialState>();
const err = (status: number, code: string, message: string) => new ApiRequestError(status, code, message);
let seq = 0;
const id = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const iso = (ms: number) => new Date(ms).toISOString();

function stateOf(w: MockWorld): SocialState {
  let s = states.get(w);
  if (!s) {
    const now = Date.now();
    const lb = w.LB;
    const posts = w.posts.filter((p) => !p.parentId);
    s = {
      // A small moderation queue so /admin has something to review.
      reports: [
        { id: 'r1', reporter: lb[4]!.handle, postId: posts[2]?.id ?? null, target: posts[2]?.author ?? 'makotrades', reason: 'spam', note: 'Same post in every room', status: 'open', at: now - 40 * 60000 },
        { id: 'r2', reporter: lb[9]!.handle, postId: null, target: 'tomasweld', reason: 'impersonation', note: 'Not the real Tomas', status: 'open', at: now - 15 * 60000 },
      ],
      claims: [{ id: 'c1', handle: 'orbitlabs', kind: 'takedown', contact: 'legal@orbitlabs.example', note: 'We did not authorize this market.', status: 'open', from: null, at: now - 3 * 3600000 }],
      uploads: new Map(),
      usedTx: new Set(),
      halted: new Set(),
      bots: new Map(),
      admins: new Set(),
      repliesSeeded: new Set(),
    };
    states.set(w, s);
  }
  return s;
}

function needUser(w: MockWorld) {
  if (!w.user) {
    notifyAuthRequired();
    throw err(401, 'auth_required', 'Connect X first');
  }
  return w.user;
}

function needAdmin(w: MockWorld) {
  const u = needUser(w);
  if (!w.isAdmin() && !stateOf(w).admins.has(u.handle)) throw err(403, 'forbidden', 'Admins only');
  return u;
}

const findPost = (w: MockWorld, pid: string): SeedPost | undefined =>
  pid === w.pinned.id ? w.pinned : w.posts.find((x) => x.id === pid);

/** Magic bytes, like the API (jpeg / png / gif / webp). */
async function sniff(f: File): Promise<UploadMime | null> {
  const b = new Uint8Array(await f.slice(0, 12).arrayBuffer());
  const s = String.fromCharCode(...b);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && s.slice(1, 4) === 'PNG') return 'image/png';
  if (/^GIF8[79]a/.test(s)) return 'image/gif';
  if (s.slice(0, 4) === 'RIFF' && s.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const REPLIES = [
  'Saving this for later.',
  'This is the kind of post I hold keys for.',
  'Underrated take. More of this.',
  'Source? Asking for my room.',
  'Ran the numbers, checks out.',
];

/** Seeded posts get a couple of replies the first time their thread opens. */
function seedReplies(w: MockWorld, p: SeedPost) {
  const s = stateOf(w);
  if (s.repliesSeeded.has(p.id) || !/^\d+$/.test(p.id)) return;
  s.repliesSeeded.add(p.id);
  const r = hash(p.id + 'replies');
  for (let i = 0; i < 2; i++) {
    const who = w.LB[(r + i * 7) % w.LB.length]!.handle;
    w.posts.push({
      id: `${p.id}r${i}`, author: who, text: REPLIES[(r + i) % REPLIES.length]!, t: 0, vis: 'public',
      likes: (r >> i) % 40, rp: 0, rep: 0, boost: false, at: p.at + (i + 1) * 7 * 60000, parentId: p.id,
    });
  }
}

export function socialMockApi(w: MockWorld): Pick<SwayApi, SocialKeys> {
  const s = () => stateOf(w);

  const reportDTO = (r: Report): AdminReportDTO => {
    const p = r.postId ? findPost(w, r.postId) : undefined;
    return {
      id: r.id,
      reason: r.reason,
      note: r.note,
      status: r.status,
      createdAt: iso(r.at),
      reporter: w.ref(r.reporter),
      post: p ? { id: p.id, text: p.text, media: p.media ?? [], visibility: p.vis, createdAt: iso(p.at), hidden: !!p.hidden, deleted: !!p.deleted } : null,
      target: { ...w.ref(r.target), botFlag: s().bots.has(r.target) },
    };
  };
  const claimDTO = (c: Claim): AdminClaimDTO => ({
    id: c.id,
    kind: c.kind,
    contact: c.contact,
    note: c.note,
    status: c.status,
    createdAt: iso(c.at),
    market: { ...w.ref(c.handle), subject: w.subjectOf(c.handle), halted: s().halted.has(c.handle) },
    from: c.from ? w.ref(c.from) : null,
  });
  const memberDTO = (h: string): AdminMemberDTO => {
    const c = w.C[h];
    const me = w.user?.handle === h;
    return {
      ...w.ref(h),
      id: 'u-' + h,
      memberNo: c?.memberNo ?? null,
      joinedAt: c ? iso(w.now0 - c.joined * 86400000) : null,
      followers: c?.followers ?? 0,
      score: c?.score ?? 0,
      botFlag: s().bots.has(h),
      botReason: s().bots.get(h) ?? null,
      isAdmin: (me && w.isAdmin()) || s().admins.has(h),
      deleted: false,
    };
  };
  const marketDTO = (h: string): AdminMarketDTO => {
    const m = w.market(w.C[h]!);
    return { ...w.ref(h), subject: m.subject, category: m.category, fan: !m.claimed, claimed: m.claimed, opened: true, halted: s().halted.has(h), supplyUnits: m.supplyUnits, holders: m.holders };
  };
  const matches = (h: string, q?: string) => {
    const qq = (q ?? '').trim().toLowerCase().replace(/^@/, '');
    return !qq || h.includes(qq) || (w.C[h]?.name ?? '').toLowerCase().includes(qq);
  };

  return {
    async deletePost(pid) {
      const u = needUser(w);
      const p = findPost(w, pid);
      if (!p || p.deleted) throw err(404, 'post_not_found', 'That post no longer exists');
      if (p.author !== u.handle && !w.isAdmin()) throw err(403, 'not_yours', 'You can only delete your own posts');
      p.deleted = true;
      const parent = p.parentId ? findPost(w, p.parentId) : undefined;
      if (parent) parent.rep = Math.max(0, parent.rep - 1);
      return { ok: true };
    },
    async boostQuote() {
      return { usd: BOOST_USD_DEFAULT, wei: usdToWei(BOOST_USD_DEFAULT, ETH_USD).toString(), treasury: MOCK_TREASURY, hours: BOOST_HOURS };
    },
    async boostPost(pid, { txHash }) {
      const u = needUser(w);
      const p = findPost(w, pid);
      if (!p || p.deleted) throw err(404, 'post_not_found', 'That post no longer exists');
      if (p.author !== u.handle) throw err(403, 'not_yours', 'You can only boost your own posts');
      if (s().usedTx.has(txHash)) throw err(409, 'tx_used', 'This payment was already used for a boost');
      const tx = w.txs.get(txHash);
      if (!tx) throw err(400, 'tx_not_found', 'That transaction was not found onchain');
      if (tx.to.toLowerCase() !== MOCK_TREASURY.toLowerCase()) throw err(400, 'wrong_recipient', 'That payment did not go to the Sway treasury');
      if (tx.eth * ETH_USD < BOOST_USD_DEFAULT * 0.98) throw err(400, 'underpaid', `A boost costs $${BOOST_USD_DEFAULT}`);
      s().usedTx.add(txHash);
      p.boostedUntil = Math.max(Date.now(), p.boostedUntil ?? 0) + BOOST_HOURS * 3600000;
      w.log('Boosted a post', -tx.eth, txHash);
      return { post: w.post(p) };
    },
    async report({ postId, handle, reason, note }) {
      const u = needUser(w);
      if (!!postId === !!handle) throw err(400, 'bad_target', 'Report either a post or an account');
      const p = postId ? findPost(w, postId) : undefined;
      if (postId && !p) throw err(404, 'post_not_found', 'That post no longer exists');
      const target = p ? p.author : normalizeHandle(handle!);
      if (target === u.handle) throw err(400, 'self', 'You can’t report yourself');
      const dup = s().reports.some((r) => r.reporter === u.handle && r.status === 'open' && r.postId === (postId ?? null) && r.target === target);
      if (!dup) s().reports.push({ id: id('r'), reporter: u.handle, postId: postId ?? null, target, reason, note: note || null, status: 'open', at: Date.now() });
      return { ok: true };
    },
    async block(handle) {
      const u = needUser(w);
      const h = normalizeHandle(handle);
      if (h === u.handle) throw err(400, 'self', 'You can’t block yourself');
      if (w.blocked.delete(h)) return { blocked: false };
      w.blocked.add(h);
      w.following.delete(h);
      return { blocked: true };
    },
    async upload(files) {
      needUser(w);
      if (!files.length) throw err(400, 'no_file', 'Pick an image first');
      if (files.length > POST_MEDIA_MAX) throw err(400, 'too_many_files', `Up to ${POST_MEDIA_MAX} images per post`);
      const out: UploadDTO[] = [];
      for (const f of files) {
        if (f.size > UPLOAD_MAX_BYTES) throw err(413, 'too_large', 'Images can be up to 5 MB');
        const mime = await sniff(f);
        if (!mime) throw err(400, 'bad_image', 'Only JPEG, PNG, WebP and GIF images');
        const name = `${fakeHash(f.name + f.size + id('u')).slice(2, 34)}.${mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1]}`;
        const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(f) : `blob:mock/${name}`;
        out.push({ url, name, mime, bytes: f.size });
      }
      for (const u of out) s().uploads.set(u.url, u);
      return { uploads: out };
    },
    uploadFileUrl: (name) => [...s().uploads.values()].find((u) => u.name === name)?.url ?? `/api/uploads/${name}`,
    async priceHistory(handle, { range }): Promise<PriceHistoryResponse> {
      const c = w.C[normalizeHandle(handle)];
      if (!c) throw err(404, 'user_not_found', 'Member not found');
      // The prototype keeps 40 hourly prices: spread them over the range.
      const n = range === '1h' ? 7 : range === '1d' ? 25 : c.hist.length;
      const span = range === '1h' ? 3600000 : range === '1d' ? 86400000 : 7 * 86400000;
      const pts = c.hist.slice(-n);
      const now = Date.now();
      return {
        range,
        points: pts.map((eth, i) => ({ t: iso(now - span + (i / Math.max(1, pts.length - 1)) * span), priceWei: ethToWei(eth).toString() })),
      };
    },
    async card(handle) {
      const h = normalizeHandle(handle);
      const c = w.C[h];
      if (!c) throw err(404, 'user_not_found', `No account @${h}`);
      const m = w.market(c);
      const pts = c.isMe ? w.userPoints() : (w.LBH[h]?.pts ?? 0);
      return { ...w.ref(h), score: c.score, reachValue: c.value, followers: c.followers, tier: tierOf(pts).name, memberNo: c.claimed ? c.memberNo : null, priceWei: m.priceWei };
    },
    async account() {
      const u = needUser(w);
      return {
        id: 'u-' + u.handle,
        handle: u.handle,
        name: u.name,
        avatarUrl: null,
        verified: u.verified,
        memberNo: u.memberNo,
        joinedAt: iso(w.account.createdAt),
        isAdmin: w.isAdmin(),
        blocked: [...w.blocked].map((h) => w.ref(h)),
      };
    },
    async exportData(): Promise<AccountExport> {
      const u = needUser(w);
      return {
        exportedAt: new Date().toISOString(),
        profile: { xId: String(hash(u.handle)), handle: u.handle, name: u.name, avatarUrl: null, bio: '', followers: u.followers, verified: u.verified, score: u.score, reachValue: u.value, scoreInputs: null, memberNo: u.memberNo, joinedAt: iso(w.account.createdAt), tier: w.points().tier },
        posts: w.posts.filter((p) => p.author === u.handle).map((p) => ({ id: p.id, text: p.text, visibility: p.vis, media: p.media ?? [], parentId: p.parentId ?? null, createdAt: iso(p.at), deletedAt: null, hiddenAt: null, boostedUntil: p.boostedUntil ? iso(p.boostedUntil) : null })),
        dmsSent: w.threads.flatMap((t) => t.msgs.filter((m) => m.from === u.handle).map((m) => ({ id: m.id, to: t.with, text: m.text, createdAt: iso(m.at) }))),
        notifications: w.notifs.map((n) => ({ id: n.id, type: n.type, body: n.body, link: n.link, createdAt: iso(n.at), read: n.read })),
        pointsLedger: [],
        wallets: [{ address: u.wallet as Address, kind: 'embedded', linked: false, createdAt: iso(w.account.createdAt) }],
        trades: [],
      };
    },
    async deleteAccount({ confirm }) {
      const u = needUser(w);
      if (confirm.trim().toLowerCase() !== deleteConfirmText(u.handle)) throw err(400, 'confirm_mismatch', `Type “${deleteConfirmText(u.handle)}” to confirm`);
      for (const p of w.posts) if (p.author === u.handle) Object.assign(p, { deleted: true, text: '', media: [] });
      w.logout();
      return { ok: true };
    },

    /* admin */
    async adminReports(q) {
      needAdmin(w);
      const status = q?.status ?? 'open';
      return s().reports.filter((r) => r.status === status).map(reportDTO);
    },
    async adminResolveReport(rid, { action }) {
      const u = needAdmin(w);
      const r = s().reports.find((x) => x.id === rid);
      if (!r) throw err(404, 'not_found', 'Report not found');
      if (action === 'hide') {
        const p = r.postId ? findPost(w, r.postId) : undefined;
        if (!p) throw err(400, 'no_post', 'This report is about an account, not a post');
        p.hidden = true;
        s().reports.filter((x) => x.postId === r.postId && x.status === 'open').forEach((x) => (x.status = 'actioned'));
      } else if (action === 'flag') {
        s().bots.set(r.target, 'admin');
        r.status = 'actioned';
      } else r.status = 'dismissed';
      console.info(`[mock admin] ${u.handle} ${action} report ${rid}`);
      return reportDTO(r);
    },
    async pinPost(pid, { pinned }) {
      const u = needUser(w);
      const p = findPost(w, pid);
      if (!p || p.deleted) throw err(404, 'post_not_found', 'That post no longer exists');
      if (p.author !== OFFICIAL.handle || p.parentId) throw err(400, 'not_pinnable', `Only top-level posts by @${OFFICIAL.handle} can be pinned`);
      if (!w.isMine(p.author) && !w.isAdmin() && !s().admins.has(u.handle)) throw err(403, 'not_yours', 'You can only pin your own posts');
      if (pinned && p !== w.pinned) {
        if (w.pinnedOn) w.posts.unshift(w.pinned);
        w.posts = w.posts.filter((x) => x !== p);
        w.pinned = p;
      }
      if (p === w.pinned) w.pinnedOn = pinned;
      return { pinned };
    },
    async adminHidePost(pid, { hidden }) {
      needAdmin(w);
      const p = findPost(w, pid);
      if (!p || p.deleted) throw err(404, 'post_not_found', 'That post no longer exists');
      p.hidden = hidden;
      if (hidden) s().reports.filter((x) => x.postId === pid && x.status === 'open').forEach((x) => (x.status = 'actioned'));
      return { hidden };
    },
    async adminClaims(q) {
      needAdmin(w);
      return s().claims.filter((c) => c.status === (q?.status ?? 'open')).map(claimDTO);
    },
    async adminResolveClaim(cid) {
      needAdmin(w);
      const c = s().claims.find((x) => x.id === cid);
      if (!c) throw err(404, 'not_found', 'Request not found');
      c.status = 'resolved';
      return claimDTO(c);
    },
    async adminMembers(q) {
      needAdmin(w);
      const handles = [...(w.user ? [w.user.handle] : []), ...w.creators().map((c) => c.handle)];
      return handles.filter((h) => matches(h, q?.q)).slice(0, 50).map(memberDTO);
    },
    async adminBotFlag(handle, { flagged }) {
      needAdmin(w);
      const h = normalizeHandle(handle);
      if (flagged) s().bots.set(h, 'admin');
      else s().bots.delete(h);
      return memberDTO(h);
    },
    async adminSetAdmin(handle, { admin }) {
      const u = needAdmin(w);
      const h = normalizeHandle(handle);
      if (h === u.handle && !admin) throw err(400, 'self', 'You can’t remove your own admin access');
      if (admin) s().admins.add(h);
      else s().admins.delete(h);
      return memberDTO(h);
    },
    async adminMarkets(q) {
      needAdmin(w);
      return Object.keys(w.C)
        .filter((h) => matches(h, q?.q))
        .sort((a, b) => Number(s().halted.has(b)) - Number(s().halted.has(a)) || w.C[b]!.volume - w.C[a]!.volume)
        .slice(0, 50)
        .map(marketDTO);
    },
    async adminHaltMarket(handle, { halted }) {
      needAdmin(w);
      const h = normalizeHandle(handle);
      if (!w.C[h]) throw err(404, 'no_market', `@${h} has no key market`);
      if (halted) s().halted.add(h);
      else s().halted.delete(h);
      return { txHash: fakeHash('halt' + h + Date.now()), status: 'success', halted };
    },
    async adminOpenFanMarket(b) {
      needAdmin(w);
      const h = normalizeHandle(b.handle);
      if (!h) throw err(400, 'invalid_handle', 'Handles use letters, digits and _');
      if (b.category === 'creators') throw err(400, 'bad_category', 'Fan markets are crypto, football, stocks or rwa');
      if (!/^\d{1,20}$/.test(b.xId) || /^0+$/.test(b.xId)) throw err(400, 'bad_xid', 'That is not an X user id');
      if (w.C[h]) throw err(409, 'market_exists', `@${h} already has a key market`);
      const c = mkFan(b.category as MarketCategory, b.name.trim() || h, h, Math.max(1, b.followers));
      Object.assign(c, { supply: 1, holders: 1, volume: 0, escrow: 0 });
      w.C[h] = c;
      return { txHash: fakeHash('fan' + h), status: 'success', market: marketDTO(h) };
    },
  };
}

/** Overrides of shared mock routes for images, replies, threads, blocks and hidden posts. */
export function installSocialMock(api: SwayApi, w: MockWorld): void {
  api.createPost = async ({ text, visibility, parentId, media }) => {
    needUser(w);
    const max = w.level >= 1 ? POST_MAX_STAKED : POST_MAX;
    const t = text.trim();
    const urls = [...new Set(media ?? [])];
    if (urls.length > POST_MEDIA_MAX) throw err(400, 'too_many_media', `Posts can have up to ${POST_MEDIA_MAX} images`);
    if (urls.some((u) => !stateOf(w).uploads.has(u))) throw err(400, 'bad_media', 'Attach images you uploaded to Sway');
    if (!t && !urls.length) throw err(400, 'empty_post', 'Write something first');
    if (t.length > max) throw err(400, 'too_long', `Posts are limited to ${max} characters`);
    const parent = parentId ? findPost(w, parentId) : undefined;
    if (parentId && (!parent || !w.visible(parent))) throw err(404, 'post_not_found', 'That post no longer exists');
    if (parent && w.locked(parent)) throw err(403, 'locked', 'You need access to this post to reply');
    const p = w.addPost(t, visibility);
    p.media = urls;
    if (parent) {
      p.parentId = parent.id;
      parent.rep += 1;
    }
    return w.post(p);
  };

  api.post = async (pid) => {
    const p = findPost(w, pid);
    if (!p || !w.visible(p)) throw err(404, 'post_not_found', 'That post no longer exists');
    seedReplies(w, p);
    const parents: SeedPost[] = [];
    let parentUnavailable = false;
    for (let q = p.parentId ? findPost(w, p.parentId) : undefined, n = 0; p.parentId && n < 20; n++) {
      if (!q || !w.visible(q)) {
        parentUnavailable = true;
        break;
      }
      parents.unshift(q);
      if (!q.parentId) break;
      q = findPost(w, q.parentId);
    }
    const kids = (id0: string) => w.posts.filter((x) => x.parentId === id0 && w.visible(x)).sort((a, b) => a.at - b.at);
    const replies = kids(p.id);
    const nested = replies.flatMap((r) => kids(r.id)).sort((a, b) => a.at - b.at);
    return {
      post: w.post(p, p === w.pinned && w.pinnedOn),
      parents: parents.map((x) => w.post(x, x === w.pinned && w.pinnedOn)),
      parentUnavailable,
      replies: replies.map((x) => w.post(x)),
      nested: nested.map((x) => w.post(x)),
    };
  };

  api.profilePosts = async (handle) => {
    const h = normalizeHandle(handle);
    return w.posts.filter((p) => p.author === h && !p.parentId && w.visible(p)).map((p) => w.post(p));
  };

  const baseMessages = api.messages;
  api.messages = async () => {
    const r = await baseMessages();
    return { ...r, dms: r.dms.filter((d) => !w.blocked.has(d.with.handle)) };
  };
  const baseDmOpen = api.dmOpen;
  api.dmOpen = async (b) => {
    if (w.blocked.has(normalizeHandle(b.handle))) throw err(403, 'blocked', 'You can’t message this account');
    return baseDmOpen(b);
  };
  const baseDmSend = api.dmSend;
  api.dmSend = async (tid, b) => {
    const t = w.threads.find((x) => x.id === tid);
    if (t && w.blocked.has(t.with)) throw err(403, 'blocked', 'You can’t message this account');
    return baseDmSend(tid, b);
  };
}
