/** [B] posts (delete, boost, images, threads), reports, blocks, hidden posts, admin, account export/deletion. */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { priceWei, usdToWei } from '@sway/curve';
import {
  SOCIAL_ROUTES,
  type AccountExport,
  type AdminMemberDTO,
  type AdminReportDTO,
  type FeedResponse,
  type PostDetailResponse,
  type PostDTO,
  type PriceHistoryResponse,
  type ProfileDTO,
  type UploadResponse,
} from '@sway/shared';
import { accessKey } from '../src/services/access';
import { sniffImage } from '../src/services/social';
import {
  fakeHash,
  login,
  makeApp,
  member,
  openMarketRow,
  prisma,
  resetState,
  type Member,
  type TestCtx,
} from './helpers';

const uploadDir = mkdtempSync(path.join(tmpdir(), 'sway-uploads-b-'));
const TREASURY = '0x00000000000000000000000000000000000000ee';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp({ env: { UPLOAD_DIR: uploadDir, ADMIN_HANDLES: 'boss, @Chief', BOOST_USD: '10' } });
});
beforeEach(async () => {
  await resetState(ctx.redis);
  ctx.chain.keys.clear();
  ctx.chain.txs.clear();
  ctx.chain.calls.length = 0;
});
afterAll(async () => {
  await ctx.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

const inject = (method: 'GET' | 'POST' | 'DELETE', url: string, cookie?: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: cookie ? { cookie } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const post = (cookie: string, payload: Record<string, unknown>) =>
  inject('POST', '/api/posts', cookie, payload);
const feed = (tab: string, cookie?: string) => inject('GET', `/api/feed?tab=${tab}`, cookie);
const texts = (r: { json: () => unknown }) => (r.json() as FeedResponse).posts.map((p) => p.text);

function multipart(files: Array<{ buf: Buffer; name?: string; type?: string }>) {
  const boundary = '----swaytest' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  files.forEach((f, i) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name ?? `img${i}.png`}"\r\n` +
          `Content-Type: ${f.type ?? 'image/png'}\r\n\r\n`,
      ),
      f.buf,
      Buffer.from('\r\n'),
    );
  });
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
const upload = (cookie: string, files: Array<{ buf: Buffer; name?: string; type?: string }>) => {
  const m = multipart(files);
  return ctx.app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { cookie, ...m.headers },
    payload: m.payload,
  });
};

describe('deleting posts', () => {
  it('soft-deletes for the author or an admin and keeps the reply count right', async () => {
    const a = await login(ctx, 'author');
    const b = await login(ctx, 'other');
    const boss = await login(ctx, 'boss');
    const root = (await post(a.cookie, { text: 'root post' })).json<PostDTO>();
    const reply = (await post(b.cookie, { text: 'a reply', parentId: root.id })).json<PostDTO>();
    expect((await prisma.post.findUniqueOrThrow({ where: { id: root.id } })).replyCount).toBe(1);

    expect((await inject('DELETE', `/api/posts/${root.id}`, b.cookie)).statusCode).toBe(403);
    expect((await inject('DELETE', `/api/posts/${reply.id}`, b.cookie)).json()).toEqual({ ok: true });
    expect((await prisma.post.findUniqueOrThrow({ where: { id: root.id } })).replyCount).toBe(0);
    expect((await inject('DELETE', `/api/posts/${reply.id}`, b.cookie)).statusCode).toBe(404);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: root.id } })).replyCount).toBe(0);

    expect((await inject('DELETE', `/api/posts/${root.id}`, boss.cookie)).statusCode).toBe(200);
    expect((await inject('GET', `/api/posts/${root.id}`)).statusCode).toBe(404);
    expect(texts(await feed('latest'))).toEqual([]);
    expect((await inject('POST', `/api/posts/${root.id}/like`, b.cookie)).statusCode).toBe(404);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: root.id } })).deletedAt).not.toBeNull();
  });
});

describe('threads', () => {
  it('returns the parent chain, replies and one level of nested replies, oldest first', async () => {
    const a = await login(ctx, 'threada');
    const b = await login(ctx, 'threadb');
    const root = (await post(a.cookie, { text: 'root' })).json<PostDTO>();
    const r1 = (await post(b.cookie, { text: 'r1', parentId: root.id })).json<PostDTO>();
    await post(a.cookie, { text: 'r2', parentId: root.id });
    const n1 = (await post(a.cookie, { text: 'n1', parentId: r1.id })).json<PostDTO>();
    const deep = (await post(b.cookie, { text: 'deep', parentId: n1.id })).json<PostDTO>();

    const t = (await inject('GET', `/api/posts/${root.id}`)).json<PostDetailResponse>();
    expect(t.parents).toEqual([]);
    expect(t.parentUnavailable).toBe(false);
    expect(t.replies.map((r) => r.text)).toEqual(['r1', 'r2']);
    expect(t.nested.map((r) => [r.text, r.parentId])).toEqual([['n1', r1.id]]);

    const d = (await inject('GET', `/api/posts/${deep.id}`)).json<PostDetailResponse>();
    expect(d.parents.map((p) => p.text)).toEqual(['root', 'r1', 'n1']);

    await inject('DELETE', `/api/posts/${r1.id}`, b.cookie);
    const d2 = (await inject('GET', `/api/posts/${deep.id}`)).json<PostDetailResponse>();
    expect(d2.parents.map((p) => p.text)).toEqual(['n1']);
    expect(d2.parentUnavailable).toBe(true);
  });
});

describe('boosts', () => {
  let author: Member;
  let postId: string;
  let wei: bigint;
  beforeEach(async () => {
    author = await member(ctx, 'booster');
    postId = (await post(author.cookie, { text: 'boost me' })).json<PostDTO>().id;
    wei = usdToWei(10, 3420);
  });
  const boost = (txHash: string, id = postId, cookie = author.cookie) =>
    inject('POST', `/api/posts/${id}/boost`, cookie, { txHash });

  it('quotes the price and the treasury', async () => {
    const q = (await inject('GET', '/api/boost')).json();
    expect(q).toEqual({ usd: 10, wei: wei.toString(), treasury: TREASURY, hours: 24 });
  });

  it('verifies the payment onchain, boosts for 24h and ranks the post', async () => {
    const quiet = await login(ctx, 'quiet');
    await prisma.user.update({ where: { id: quiet.user.id }, data: { score: 99 } });
    await post(quiet.cookie, { text: 'high score post' });
    expect(texts(await feed('foryou'))[0]).toBe('high score post');

    const tx = ctx.chain.addTx({
      from: author.address,
      to: TREASURY,
      value: (wei * 99n) / 100n,
      status: 'success',
    });
    const res = await boost(tx);
    expect(res.statusCode).toBe(200);
    const p = res.json<{ post: PostDTO }>().post;
    expect(p.boosted).toBe(true);
    const until = new Date(p.boostedUntil!).getTime();
    expect(Math.abs(until - (Date.now() + 24 * 3600e3))).toBeLessThan(10_000);
    const f = (await feed('foryou')).json<FeedResponse>();
    expect(f.posts[0]).toMatchObject({ text: 'boost me', boosted: true });
    expect((await prisma.activity.findUniqueOrThrow({ where: { ref: `boost:${tx}` } })).label).toBe(
      'Boosted a post',
    );

    // The window ends: no longer boosted, and the ranking falls back.
    await prisma.post.update({ where: { id: postId }, data: { boostedUntil: new Date(Date.now() - 1000) } });
    const f2 = (await feed('foryou')).json<FeedResponse>();
    expect(f2.posts[0]!.text).toBe('high score post');
    expect(f2.posts.find((x) => x.id === postId)!.boosted).toBe(false);
  });

  it('rejects the wrong recipient, too little, a reused tx and someone else’s wallet', async () => {
    const wrong = ctx.chain.addTx({
      from: author.address,
      to: '0x00000000000000000000000000000000000000aa',
      value: wei,
      status: 'success',
    });
    expect((await boost(wrong)).json().error).toBe('wrong_recipient');

    const little = ctx.chain.addTx({
      from: author.address,
      to: TREASURY,
      value: (wei * 97n) / 100n,
      status: 'success',
    });
    expect((await boost(little)).json().error).toBe('underpaid');

    const stranger = await member(ctx, 'stranger');
    const notMine = ctx.chain.addTx({ from: stranger.address, to: TREASURY, value: wei, status: 'success' });
    const r = await boost(notMine);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('tx_not_yours');

    const reverted = ctx.chain.addTx({ from: author.address, to: TREASURY, value: wei, status: 'reverted' });
    expect((await boost(reverted)).json().error).toBe('tx_reverted');
    expect((await boost(fakeHash())).json().error).toBe('tx_not_found');

    const ok = ctx.chain.addTx({ from: author.address, to: TREASURY, value: wei, status: 'success' });
    expect((await boost(ok)).statusCode).toBe(200);
    const again = await boost(ok);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('tx_used');
    // A second boost replaces Post.boostTx, but the first tx still can't be reused on another post.
    const second = ctx.chain.addTx({ from: author.address, to: TREASURY, value: wei, status: 'success' });
    expect((await boost(second)).statusCode).toBe(200);
    const other = (await post(author.cookie, { text: 'another' })).json<PostDTO>();
    expect((await boost(ok, other.id)).json().error).toBe('tx_used');

    // Only your own posts.
    const tx = ctx.chain.addTx({ from: stranger.address, to: TREASURY, value: wei, status: 'success' });
    expect((await boost(tx, postId, stranger.cookie)).json().error).toBe('not_yours');
  });

  it('accepts payments from a linked wallet and extends a running boost', async () => {
    const linked = `0x${'7'.repeat(40)}` as const;
    await prisma.linkedWallet.create({ data: { userId: author.user.id, address: linked } });
    const t1 = ctx.chain.addTx({ from: linked, to: TREASURY, value: wei, status: 'success' });
    const p1 = (await boost(t1)).json<{ post: PostDTO }>().post;
    const t2 = ctx.chain.addTx({ from: author.address, to: TREASURY, value: wei, status: 'success' });
    const p2 = (await boost(t2)).json<{ post: PostDTO }>().post;
    expect(new Date(p2.boostedUntil!).getTime() - new Date(p1.boostedUntil!).getTime()).toBeGreaterThan(
      23.9 * 3600e3,
    );
  });
});

describe('reports', () => {
  it('reports a post or an account once per target; never yourself', async () => {
    const a = await login(ctx, 'spammer');
    const r = await login(ctx, 'reporter');
    const p = (await post(a.cookie, { text: 'buy my coin' })).json<PostDTO>();
    const report = (payload: object, cookie = r.cookie) => inject('POST', '/api/reports', cookie, payload);
    expect((await report({ postId: p.id, reason: 'spam', note: 'scam link' })).json()).toEqual({ ok: true });
    expect((await report({ postId: p.id, reason: 'spam' })).statusCode).toBe(200);
    expect((await report({ handle: '@spammer', reason: 'impersonation' })).statusCode).toBe(200);
    const rows = await prisma.report.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      postId: p.id,
      reportedUserId: a.user.id,
      reason: 'spam',
      note: 'scam link',
      status: 'open',
    });
    expect(rows[1]).toMatchObject({ postId: null, reportedUserId: a.user.id, reason: 'impersonation' });
    expect((await report({ postId: p.id, handle: 'spammer', reason: 'spam' })).json().error).toBe(
      'bad_target',
    );
    expect((await report({ reason: 'spam' })).json().error).toBe('bad_target');
    expect((await report({ handle: 'spammer', reason: 'nonsense' })).statusCode).toBe(400);
    expect((await report({ postId: p.id, reason: 'spam' }, a.cookie)).json().error).toBe('self');
    expect(
      (await inject('POST', '/api/reports', undefined, { postId: p.id, reason: 'spam' })).statusCode,
    ).toBe(401);
  });
});

describe('blocks', () => {
  it('hides the blocked account’s posts and replies from the blocker, shows it on the profile and refuses DMs both ways', async () => {
    const me = await login(ctx, 'blocker');
    const troll = await login(ctx, 'troll');
    const friend = await login(ctx, 'friend');
    const root = (await post(friend.cookie, { text: 'friend post' })).json<PostDTO>();
    await post(troll.cookie, { text: 'troll post' });
    await post(troll.cookie, { text: 'troll reply', parentId: root.id });
    await post(me.cookie, { text: 'my post' });
    await inject('POST', '/api/users/troll/follow', me.cookie);
    const thread = (await inject('POST', '/api/messages/dm', troll.cookie, { handle: 'blocker' })).json<{
      id: string;
    }>();
    await inject('POST', `/api/messages/dm/${thread.id}`, troll.cookie, { text: 'hi' });

    expect((await inject('POST', '/api/users/troll/block', me.cookie)).json()).toEqual({ blocked: true });
    expect(await prisma.follow.count()).toBe(0);
    for (const tab of ['latest', 'foryou', 'trending'])
      expect(texts(await feed(tab, me.cookie)).sort()).toEqual(['friend post', 'my post']);
    // Only the blocker's view changes.
    expect(texts(await feed('latest', friend.cookie))).toContain('troll post');
    expect(texts(await feed('latest'))).toContain('troll post');
    const t = (await inject('GET', `/api/posts/${root.id}`, me.cookie)).json<PostDetailResponse>();
    expect(t.replies).toEqual([]);
    expect(
      (await inject('GET', `/api/posts/${root.id}`, friend.cookie)).json<PostDetailResponse>().replies,
    ).toHaveLength(1);
    expect((await inject('GET', '/api/users/troll/posts', me.cookie)).json()).toEqual([]);
    expect((await inject('GET', '/api/users/troll', me.cookie)).json<ProfileDTO>().blocked).toBe(true);
    expect((await inject('GET', '/api/users/troll', friend.cookie)).json<ProfileDTO>().blocked).toBe(false);

    // DMs are refused both ways; the thread disappears from the blocker's list.
    const send = await inject('POST', `/api/messages/dm/${thread.id}`, troll.cookie, { text: 'again' });
    expect(send.statusCode).toBe(403);
    expect(send.json().error).toBe('blocked');
    expect(
      (await inject('POST', `/api/messages/dm/${thread.id}`, me.cookie, { text: 'no' })).json().error,
    ).toBe('blocked');
    expect((await inject('POST', '/api/messages/dm', me.cookie, { handle: 'troll' })).json().error).toBe(
      'blocked',
    );
    expect((await inject('POST', '/api/messages/dm', troll.cookie, { handle: 'blocker' })).json().error).toBe(
      'blocked',
    );
    expect((await inject('GET', '/api/messages', me.cookie)).json().dms).toEqual([]);
    expect((await inject('GET', '/api/me', me.cookie)).json().unreadMessages).toBe(0);
    // No follows or replies across the block.
    expect((await inject('POST', '/api/users/blocker/follow', troll.cookie)).json().error).toBe('blocked');
    const mine = (await feed('latest', me.cookie))
      .json<FeedResponse>()
      .posts.find((p) => p.text === 'my post')!;
    expect((await post(troll.cookie, { text: 'reply', parentId: mine.id })).json().error).toBe('blocked');

    expect((await inject('POST', '/api/users/troll/block', me.cookie)).json()).toEqual({ blocked: false });
    expect(texts(await feed('latest', me.cookie))).toContain('troll post');
    expect(
      (await inject('POST', `/api/messages/dm/${thread.id}`, troll.cookie, { text: 'ok' })).statusCode,
    ).toBe(200);
    expect((await inject('POST', '/api/users/blocker/block', me.cookie)).json().error).toBe('self');
  });
});

describe('hidden posts', () => {
  it('vanish for everyone except admins and the author', async () => {
    const a = await login(ctx, 'hiddenauthor');
    const viewer = await login(ctx, 'someone');
    const boss = await login(ctx, 'boss');
    const p = (await post(a.cookie, { text: 'borderline' })).json<PostDTO>();
    await inject('POST', '/api/reports', viewer.cookie, { postId: p.id, reason: 'abuse' });
    expect(
      (await inject('POST', `/api/admin/posts/${p.id}/hide`, viewer.cookie, { hidden: true })).statusCode,
    ).toBe(403);
    expect(
      (await inject('POST', `/api/admin/posts/${p.id}/hide`, boss.cookie, { hidden: true })).json(),
    ).toEqual({ hidden: true });
    expect((await prisma.report.findFirstOrThrow()).status).toBe('actioned');

    expect(texts(await feed('latest'))).toEqual([]);
    expect(texts(await feed('latest', viewer.cookie))).toEqual([]);
    expect((await inject('GET', `/api/posts/${p.id}`, viewer.cookie)).statusCode).toBe(404);
    expect((await inject('GET', '/api/users/hiddenauthor/posts')).json()).toEqual([]);
    expect((await inject('POST', `/api/posts/${p.id}/like`, viewer.cookie)).statusCode).toBe(404);
    const own = (await feed('latest', a.cookie)).json<FeedResponse>().posts;
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ text: 'borderline', hidden: true });
    expect((await feed('latest', boss.cookie)).json<FeedResponse>().posts[0]!.hidden).toBe(true);
    expect((await inject('GET', `/api/posts/${p.id}`, boss.cookie)).statusCode).toBe(200);

    await inject('POST', `/api/admin/posts/${p.id}/hide`, boss.cookie, { hidden: false });
    expect(texts(await feed('latest'))).toEqual(['borderline']);
  });
});

describe('images', () => {
  it('sniffs jpeg/png/webp/gif by magic bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe(
      'image/webp',
    );
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('<html>'))).toBeNull();
  });

  it('stores uploads under random names and serves them with safe headers', async () => {
    const a = await login(ctx, 'uploader');
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/uploads', ...multipart([{ buf: PNG }]) }))
        .statusCode,
    ).toBe(401);
    const res = await upload(a.cookie, [
      { buf: PNG, name: '../../evil.png' },
      { buf: PNG, name: 'b.jpg', type: 'image/jpeg' },
    ]);
    expect(res.statusCode).toBe(200);
    const ups = res.json<UploadResponse>().uploads;
    expect(ups).toHaveLength(2);
    for (const u of ups) {
      expect(u.name).toMatch(/^[a-f0-9]{32}\.png$/); // the stored type comes from the bytes, not the client
      expect(u.url).toBe(`/api/uploads/${u.name}`);
      expect(existsSync(path.join(uploadDir, u.name))).toBe(true);
    }
    expect(await prisma.upload.count({ where: { userId: a.user.id } })).toBe(2);
    const g = await inject('GET', ups[0]!.url);
    expect(g.statusCode).toBe(200);
    expect(g.headers['content-type']).toBe('image/png');
    expect(g.headers['x-content-type-options']).toBe('nosniff');
    expect(g.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(String(g.headers['cache-control'])).toContain('max-age=31536000');
    expect(g.rawPayload.equals(PNG)).toBe(true);
    expect((await inject('GET', '/api/uploads/../../etc/passwd')).statusCode).toBe(404);
    expect((await inject('GET', `/api/uploads/${'0'.repeat(32)}.png`)).statusCode).toBe(404);
  });

  it('rejects bad magic bytes, files over 5 MB and more than 4 files', async () => {
    const a = await login(ctx, 'badupload');
    const bad = await upload(a.cookie, [{ buf: Buffer.from('<svg onload=alert(1)>'), name: 'x.png' }]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('bad_image');
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const tooBig = await upload(a.cookie, [{ buf: big }]);
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error).toBe('too_large');
    const many = await upload(
      a.cookie,
      Array.from({ length: 5 }, () => ({ buf: PNG })),
    );
    expect(many.statusCode).toBe(400);
    expect(many.json().error).toBe('too_many_files');
    // Nothing was stored for the rejected requests.
    expect(await prisma.upload.count()).toBe(0);
  });

  it('attaches only your own uploads, at most 4, and never leaks media of locked posts', async () => {
    const creator = await member(ctx, 'imgcreator');
    await openMarketRow(creator);
    const other = await login(ctx, 'imgother');
    const mine = (
      await upload(
        creator.cookie,
        Array.from({ length: 4 }, () => ({ buf: PNG })),
      )
    ).json<UploadResponse>().uploads;
    const theirs = (await upload(other.cookie, [{ buf: PNG }])).json<UploadResponse>().uploads;
    const pubImg = (await upload(creator.cookie, [{ buf: PNG }])).json<UploadResponse>().uploads[0]!;
    const urls = mine.map((u) => u.url);

    expect((await post(creator.cookie, { text: 'x', media: [theirs[0]!.url] })).json().error).toBe(
      'bad_media',
    );
    expect(
      (await post(creator.cookie, { text: 'x', media: ['https://evil.example/a.png'] })).json().error,
    ).toBe('bad_media');
    expect((await post(creator.cookie, { text: 'x', media: [...urls, theirs[0]!.url] })).json().error).toBe(
      'too_many_media',
    );
    const pub = (await post(creator.cookie, { text: '', media: [pubImg.url, pubImg.url] })).json<PostDTO>();
    expect(pub.media).toEqual([pubImg.url]);

    const gated = (
      await post(creator.cookie, { text: 'holders only pics', visibility: 'holders', media: urls })
    ).json<PostDTO>();
    expect(gated.media).toEqual(urls);
    for (const res of [
      await feed('latest'),
      await feed('latest', other.cookie),
      await inject('GET', `/api/posts/${gated.id}`),
      await inject('GET', '/api/users/imgcreator/posts'),
    ]) {
      for (const u of mine) expect(res.body).not.toContain(u.name);
    }
    const lockedDto = (await feed('latest')).json<FeedResponse>().posts.find((p) => p.id === gated.id)!;
    expect(lockedDto).toMatchObject({ locked: true, media: [] });

    const fan = await member(ctx, 'imgfan');
    ctx.chain.setKeys(creator.address, fan.address, 100n);
    await ctx.redis.del(accessKey(creator.address, fan.address));
    const open = (await feed('latest', fan.cookie))
      .json<FeedResponse>()
      .posts.find((p) => p.id === gated.id)!;
    expect(open).toMatchObject({ locked: false, media: urls });
  });
});

describe('admin', () => {
  it('guards every admin route and bootstraps admins from ADMIN_HANDLES', async () => {
    const user = await login(ctx, 'normie');
    const chief = await login(ctx, 'chief');
    expect(chief.me.isAdmin).toBe(true);
    expect(user.me.isAdmin).toBe(false);
    const adminRoutes = Object.values(SOCIAL_ROUTES).filter((r) => r.includes('/api/admin/'));
    expect(adminRoutes.length).toBeGreaterThanOrEqual(11);
    for (const r of adminRoutes) {
      const [method, tpl] = r.split(' ') as ['GET' | 'POST', string];
      const url = tpl.replace(/:(\w+)/g, 'x');
      expect((await inject(method, url, user.cookie, method === 'POST' ? {} : undefined)).statusCode, r).toBe(
        403,
      );
      expect((await inject(method, url, undefined, method === 'POST' ? {} : undefined)).statusCode, r).toBe(
        401,
      );
    }
    expect((await inject('GET', '/api/admin/reports', chief.cookie)).statusCode).toBe(200);
  });

  it('resolves reports: hide, dismiss, flag the author as a bot', async () => {
    const boss = await login(ctx, 'boss');
    const a = await login(ctx, 'badactor');
    const r = await login(ctx, 'goodcitizen');
    const p1 = (await post(a.cookie, { text: 'spam 1', visibility: 'holders' })).json<PostDTO>();
    const p2 = (await post(a.cookie, { text: 'spam 2' })).json<PostDTO>();
    for (const id of [p1.id, p2.id])
      await inject('POST', '/api/reports', r.cookie, { postId: id, reason: 'spam' });
    await inject('POST', '/api/reports', r.cookie, { handle: 'badactor', reason: 'other', note: 'farm' });

    const list = (await inject('GET', '/api/admin/reports', boss.cookie)).json<AdminReportDTO[]>();
    expect(list).toHaveLength(3);
    const first = list.find((x) => x.post?.id === p1.id)!;
    // Admins see the full post whatever its visibility.
    expect(first).toMatchObject({
      reason: 'spam',
      post: { text: 'spam 1', visibility: 'holders', hidden: false },
      target: { handle: 'badactor', botFlag: false },
    });

    const hid = (
      await inject('POST', `/api/admin/reports/${first.id}`, boss.cookie, { action: 'hide' })
    ).json<AdminReportDTO>();
    expect(hid).toMatchObject({ status: 'actioned', post: { hidden: true } });
    const second = list.find((x) => x.post?.id === p2.id)!;
    expect(
      (
        await inject('POST', `/api/admin/reports/${second.id}`, boss.cookie, { action: 'dismiss' })
      ).json<AdminReportDTO>().status,
    ).toBe('dismissed');
    const acct = list.find((x) => !x.post)!;
    expect(
      (await inject('POST', `/api/admin/reports/${acct.id}`, boss.cookie, { action: 'hide' })).json().error,
    ).toBe('no_post');
    const flagged = (
      await inject('POST', `/api/admin/reports/${acct.id}`, boss.cookie, { action: 'flag' })
    ).json<AdminReportDTO>();
    expect(flagged).toMatchObject({ status: 'actioned', target: { botFlag: true } });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).toMatchObject({
      botFlag: true,
      botReason: 'admin',
    });
    expect((await inject('GET', '/api/admin/reports', boss.cookie)).json()).toEqual([]);
    expect((await inject('GET', '/api/admin/reports?status=actioned', boss.cookie)).json()).toHaveLength(2);
  });

  it('resolves claim requests, searches members and toggles bot and admin flags', async () => {
    const boss = await login(ctx, 'boss');
    const fan = await member(ctx, 'claimer');
    const xid = '424242';
    const u = await prisma.user.create({ data: { xId: xid, handle: 'orbitlabs', name: 'Orbit Labs' } });
    const m = await prisma.keyMarket.create({
      data: {
        subject: '0x' + 'ab'.repeat(20),
        userId: u.id,
        xId: xid,
        fan: true,
        claimed: false,
        opened: true,
        category: 'crypto',
      },
    });
    await inject('POST', '/api/users/orbitlabs/claim-request', fan.cookie, {
      kind: 'takedown',
      contact: 'legal@orbit.example',
      note: 'not us',
    });
    const claims = (await inject('GET', '/api/admin/claims', boss.cookie)).json();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      kind: 'takedown',
      contact: 'legal@orbit.example',
      market: { handle: 'orbitlabs', subject: m.subject },
      from: { handle: 'claimer' },
    });
    expect(
      (await inject('POST', `/api/admin/claims/${claims[0].id}/resolve`, boss.cookie)).json().status,
    ).toBe('resolved');
    expect((await inject('GET', '/api/admin/claims', boss.cookie)).json()).toEqual([]);

    const found = (await inject('GET', '/api/admin/members?q=claim', boss.cookie)).json<AdminMemberDTO[]>();
    expect(found.map((x) => x.handle)).toEqual(['claimer']);
    expect(
      (
        await inject('POST', '/api/admin/members/claimer/bot', boss.cookie, { flagged: true })
      ).json<AdminMemberDTO>(),
    ).toMatchObject({ botFlag: true, botReason: 'admin' });
    expect(
      (
        await inject('POST', '/api/admin/members/claimer/bot', boss.cookie, { flagged: false })
      ).json<AdminMemberDTO>(),
    ).toMatchObject({ botFlag: false, botReason: 'admin_cleared' });
    expect(
      (
        await inject('POST', '/api/admin/members/claimer/admin', boss.cookie, { admin: true })
      ).json<AdminMemberDTO>().isAdmin,
    ).toBe(true);
    expect((await inject('GET', '/api/admin/reports', fan.cookie)).statusCode).toBe(200);
    expect(
      (await inject('POST', '/api/admin/members/boss/admin', boss.cookie, { admin: false })).json().error,
    ).toBe('self');
  });

  it('halts markets onchain through the operator and opens fan markets', async () => {
    const boss = await login(ctx, 'boss');
    const c = await member(ctx, 'haltme');
    await openMarketRow(c);
    const h = (await inject('POST', '/api/admin/markets/haltme/halt', boss.cookie, { halted: true })).json();
    expect(h).toMatchObject({ halted: true, status: 'success' });
    expect(ctx.chain.calls).toContainEqual({ fn: 'setMarketHalted', args: [c.address, true] });
    // The mirror is written by the indexer, not the API.
    expect((await prisma.keyMarket.findUniqueOrThrow({ where: { subject: c.address } })).halted).toBe(false);
    await inject('POST', '/api/admin/markets/haltme/halt', boss.cookie, { halted: false });
    expect(ctx.chain.calls).toContainEqual({ fn: 'setMarketHalted', args: [c.address, false] });
    expect(
      (await inject('GET', '/api/admin/markets?q=halt', boss.cookie))
        .json()
        .map((m: { handle: string }) => m.handle),
    ).toEqual(['haltme']);

    const body = { handle: '@NewCo', name: 'New Co', xId: '1234567', followers: 50000, category: 'stocks' };
    const r = await inject('POST', '/api/admin/fan-markets', boss.cookie, body);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      status: 'success',
      market: { handle: 'newco', fan: true, claimed: false, category: 'stocks', opened: false },
    });
    expect(ctx.chain.calls).toContainEqual({ fn: 'openFanMarket', args: [1234567n] });
    const u = await prisma.user.findUniqueOrThrow({ where: { xId: '1234567' }, include: { market: true } });
    expect(u).toMatchObject({ handle: 'newco', name: 'New Co', followers: 50000, joinedAt: null });
    expect(u.bio).toContain('Fan market');
    expect(
      (await inject('POST', '/api/admin/fan-markets', boss.cookie, { ...body, category: 'creators' })).json()
        .error,
    ).toBe('bad_category');
    expect(
      (
        await inject('POST', '/api/admin/fan-markets', boss.cookie, { ...body, handle: 'haltme', xId: '99' })
      ).json().error,
    ).toBe('handle_taken');
    expect(
      (
        await inject('POST', '/api/admin/fan-markets', boss.cookie, { ...body, handle: 'x', xId: c.user.xId })
      ).json().error,
    ).toBe('member');
    expect(
      (await inject('POST', '/api/admin/fan-markets', boss.cookie, { handle: 'lookmeup', category: 'crypto' })).json().error,
    ).toBe('x_lookup_unavailable');
  });

  it('reads a fan market\'s X id, name, followers and avatar from X when only the handle is given', async () => {
    const asked: string[] = [];
    const xFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      asked.push(`${url.pathname} ${new Headers(init?.headers).get('authorization')}`);
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      // X matches usernames case-insensitively; the API asks with the normalized (lower-case) handle.
      if (url.pathname.toLowerCase() === '/2/users/by/username/coindesk')
        return ok({
          data: {
            id: '1333467482',
            username: 'CoinDesk',
            name: 'CoinDesk',
            profile_image_url: 'https://pbs.twimg.com/cd_normal.jpg',
            created_at: '2013-04-15T00:00:00Z',
            verified: true,
            public_metrics: { followers_count: 3_400_000, following_count: 1, tweet_count: 1 },
          },
        });
      return ok({ errors: [{ title: 'Not Found Error' }] });
    }) as typeof fetch;
    const x = await makeApp({ env: { ADMIN_HANDLES: 'boss', X_BEARER_TOKEN: 'app-bearer' }, xFetch });
    try {
      const boss = await login(x, 'boss');
      const r = await x.app.inject({
        method: 'POST',
        url: '/api/admin/fan-markets',
        headers: { cookie: boss.cookie },
        payload: { handle: '@CoinDesk', category: 'crypto' },
      });
      expect(r.statusCode).toBe(200);
      expect(asked).toEqual(['/2/users/by/username/coindesk Bearer app-bearer']);
      const u = await prisma.user.findUniqueOrThrow({ where: { xId: '1333467482' } });
      expect(u).toMatchObject({ handle: 'coindesk', name: 'CoinDesk', followers: 3_400_000, avatarUrl: 'https://pbs.twimg.com/cd_400x400.jpg', verified: true, joinedAt: null });
      expect(u.score).toBeGreaterThan(0);
      const miss = await x.app.inject({
        method: 'POST',
        url: '/api/admin/fan-markets',
        headers: { cookie: boss.cookie },
        payload: { handle: 'nobodyhere', category: 'crypto' },
      });
      expect(miss.json().error).toBe('x_user_not_found');
    } finally {
      await x.close();
    }
  });
});

describe('profile price history', () => {
  it('returns the start price, a point per trade in range and the current price', async () => {
    const c = await member(ctx, 'charted');
    const m = await openMarketRow(c, 400n);
    const now = Date.now();
    await prisma.keyMarket.update({ where: { id: m.id }, data: { openedAt: new Date(now - 30 * 86400e3) } });
    const trade = (minsAgo: number, supplyAfter: bigint, units = 100n) =>
      prisma.trade.create({
        data: {
          txHash: fakeHash(),
          logIndex: 0,
          blockNumber: BigInt(now - minsAgo),
          blockHash: '0x',
          marketId: m.id,
          trader: c.address,
          isBuy: true,
          units,
          baseWei: '1',
          creatorFeeWei: '0',
          protocolFeeWei: '0',
          holderFeeWei: '0',
          referralFeeWei: '0',
          totalWei: '1',
          supplyAfter,
          ts: new Date(now - minsAgo * 60000),
        },
      });
    await trade(60 * 30, 200n);
    await trade(90, 300n);
    await trade(10, 400n);
    const h1 = (await inject('GET', '/api/users/charted/history?range=1h')).json<PriceHistoryResponse>();
    expect(h1.range).toBe('1h');
    expect(h1.points.map((p) => p.priceWei)).toEqual(
      [priceWei(300n), priceWei(400n), priceWei(400n)].map(String),
    );
    const d1 = (await inject('GET', '/api/users/charted/history?range=1d')).json<PriceHistoryResponse>();
    expect(d1.points.map((p) => p.priceWei)).toEqual(
      [priceWei(200n), priceWei(300n), priceWei(400n), priceWei(400n)].map(String),
    );
    const w = (await inject('GET', '/api/users/charted/history?range=7d')).json<PriceHistoryResponse>();
    expect(w.points).toHaveLength(5);
    expect((await inject('GET', '/api/users/charted/history?range=1y')).statusCode).toBe(400);
  });
});

describe('account', () => {
  it('shows account info and exports everything as one JSON file', async () => {
    const me = await member(ctx, 'exporter');
    const other = await login(ctx, 'pal');
    await post(me.cookie, { text: 'exported post' });
    const t = (await inject('POST', '/api/messages/dm', me.cookie, { handle: 'pal' })).json<{ id: string }>();
    await inject('POST', `/api/messages/dm/${t.id}`, me.cookie, { text: 'secret dm' });
    await inject('POST', `/api/messages/dm/${t.id}`, other.cookie, { text: 'their reply' });
    await prisma.pointsLedger.create({
      data: { userId: me.user.id, kind: 'task', amount: 1000, ref: 'task:follow' },
    });
    await inject('POST', '/api/users/pal/block', me.cookie);

    const acct = (await inject('GET', '/api/me/account', me.cookie)).json();
    expect(acct).toMatchObject({ handle: 'exporter', isAdmin: false, blocked: [{ handle: 'pal' }] });
    expect(acct.memberNo).toBeGreaterThan(0);

    const res = await inject('GET', '/api/me/export', me.cookie);
    expect(res.headers['content-disposition']).toBe('attachment; filename="sway-exporter-export.json"');
    const x = res.json<AccountExport>();
    expect(x.profile).toMatchObject({ handle: 'exporter', xId: me.user.xId });
    expect(x.posts.map((p) => p.text)).toEqual(['exported post']);
    expect(x.dmsSent).toEqual([expect.objectContaining({ to: 'pal', text: 'secret dm' })]);
    expect(x.pointsLedger).toEqual([expect.objectContaining({ kind: 'task', amount: 1000 })]);
    expect(x.wallets).toEqual([expect.objectContaining({ address: me.address, linked: false })]);
    expect(res.body).not.toContain('their reply');
    expect((await inject('GET', '/api/me/export')).statusCode).toBe(401);
  });

  it('deletes personal data, revokes every session and keeps the market and the ledger', async () => {
    const me = await member(ctx, 'leaver');
    const second = await login(ctx, 'leaver'); // a second session
    const m = await openMarketRow(me, 300n);
    const pal = await member(ctx, 'stayer');
    await prisma.holding.create({ data: { marketId: m.id, address: pal.address, units: 200n } });
    await prisma.trade.create({
      data: {
        txHash: fakeHash(),
        logIndex: 0,
        blockNumber: 1n,
        blockHash: '0x',
        marketId: m.id,
        trader: pal.address,
        isBuy: true,
        units: 200n,
        baseWei: '1',
        creatorFeeWei: '0',
        protocolFeeWei: '0',
        holderFeeWei: '0',
        referralFeeWei: '0',
        totalWei: '1',
        supplyAfter: 300n,
        ts: new Date(),
      },
    });
    await prisma.pointsLedger.create({
      data: { userId: me.user.id, kind: 'task', amount: 1000, ref: 'task:follow' },
    });
    const img = (await upload(me.cookie, [{ buf: PNG }])).json<UploadResponse>().uploads[0]!;
    const mine = (await post(me.cookie, { text: 'my words #gone', media: [img.url] })).json<PostDTO>();
    const theirs = (await post(pal.cookie, { text: 'pal post' })).json<PostDTO>();
    await post(me.cookie, { text: 'my reply', parentId: theirs.id });
    await post(pal.cookie, { text: 'reply to leaver', parentId: mine.id });
    await inject('POST', `/api/posts/${theirs.id}/like`, me.cookie);
    await inject('POST', `/api/posts/${theirs.id}/repost`, me.cookie);
    await inject('POST', '/api/users/stayer/follow', me.cookie);
    await inject('POST', '/api/users/leaver/follow', pal.cookie);
    const t = (await inject('POST', '/api/messages/dm', me.cookie, { handle: 'stayer' })).json<{
      id: string;
    }>();
    await inject('POST', `/api/messages/dm/${t.id}`, me.cookie, { text: 'bye' });
    await inject('POST', '/api/reports', me.cookie, { postId: theirs.id, reason: 'other' });
    await post(pal.cookie, { text: 'hey @leaver' });

    const wrong = await inject('DELETE', '/api/me', me.cookie, { confirm: 'delete @someoneelse' });
    expect(wrong.json().error).toBe('confirm_mismatch');
    const del = await inject('DELETE', '/api/me', me.cookie, { confirm: 'delete @leaver' });
    expect(del.statusCode).toBe(200);

    // Every session is gone.
    for (const c of [me.cookie, second.cookie]) {
      expect((await inject('GET', '/api/me', c)).statusCode).toBe(401);
      expect((await post(c, { text: 'ghost' })).statusCode).toBe(401);
    }
    expect(await ctx.redis.exists(`usess:${me.user.id}`)).toBe(0);

    const u = await prisma.user.findUniqueOrThrow({ where: { id: me.user.id } });
    expect(u).toMatchObject({
      name: 'Deleted account',
      avatarUrl: null,
      bio: '',
      scoreInputs: null,
      joinedAt: null,
      memberNo: null,
    });
    expect(u.handle).toMatch(/^deleted_/);
    expect(u.deletedAt).not.toBeNull();
    const posts = await prisma.post.findMany({ where: { authorId: me.user.id } });
    expect(posts.every((p) => p.text === '' && p.media.length === 0 && p.deletedAt)).toBe(true);
    expect(await prisma.postTag.count({ where: { tag: 'gone' } })).toBe(0);
    const pp = await prisma.post.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(pp).toMatchObject({ likeCount: 0, repostCount: 0, replyCount: 0 });
    for (const n of [
      prisma.like.count({ where: { userId: me.user.id } }),
      prisma.follow.count(),
      prisma.dmThread.count(),
      prisma.dmMessage.count(),
      prisma.report.count(),
      prisma.notification.count({ where: { OR: [{ userId: me.user.id }, { fromUserId: me.user.id }] } }),
      prisma.upload.count(),
    ])
      expect(await n).toBe(0);
    expect(existsSync(path.join(uploadDir, img.name))).toBe(false);
    expect((await inject('GET', img.url)).statusCode).toBe(404);

    // Kept: market, holdings, trades, ledger, wallet. The market shows "Deleted account".
    expect(await prisma.keyMarket.count({ where: { id: m.id } })).toBe(1);
    expect(await prisma.holding.count({ where: { marketId: m.id } })).toBe(1);
    expect(await prisma.trade.count({ where: { marketId: m.id } })).toBe(1);
    expect(await prisma.pointsLedger.count({ where: { userId: me.user.id } })).toBe(1);
    expect(await prisma.wallet.count({ where: { userId: me.user.id } })).toBe(1);
    const prof = (await inject('GET', `/api/users/${u.handle}`, pal.cookie)).json<ProfileDTO>();
    expect(prof).toMatchObject({ name: 'Deleted account', deleted: true, ownerAddress: null });
    const thread = (await inject('GET', `/api/posts/${mine.id}`)).statusCode;
    expect(thread).toBe(404);
    expect(texts(await feed('latest'))).toEqual(['hey @leaver', 'pal post']);
    expect((await inject('GET', `/api/users/${u.handle}/card`)).statusCode).toBe(404);

    // Signing in again starts a fresh profile on the same X id.
    const back = await login(ctx, 'leaver');
    expect(back.user.id).toBe(me.user.id);
    expect(back.user.deletedAt).toBeNull();
    expect(back.user.joinedAt).not.toBeNull();
    expect(back.user.scoreInputs).not.toBeNull();
    expect((await inject('GET', '/api/me', back.cookie)).statusCode).toBe(200);
    expect((await inject('GET', '/api/users/leaver/posts')).json()).toEqual([]);
  });
});

describe('share card', () => {
  it('serves the public card data', async () => {
    const c = await member(ctx, 'carded');
    await openMarketRow(c, 300n);
    const card = (await inject('GET', '/api/users/carded/card')).json();
    expect(card).toMatchObject({ handle: 'carded', tier: 'Murmur', score: c.user.score, claimed: true });
    expect(card.priceWei).not.toBeNull();
  });
});
