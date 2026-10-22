import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FeedResponse, PostDetailResponse, PostDTO } from '@sway/shared';
import { forYouScore, parseMentions, parseTags, teaser } from '../src/services/feed';
import { accessKey } from '../src/services/access';
import {
  login,
  makeApp,
  member,
  openMarketRow,
  prisma,
  resetState,
  type Member,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
beforeEach(async () => {
  await resetState(ctx.redis);
  ctx.chain.keys.clear();
});
afterAll(() => ctx.close());

const post = (cookie: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/posts', headers: { cookie }, payload });
const feed = (tab: string, cookie?: string, cursor?: string) =>
  ctx.app.inject({
    url: `/api/feed?tab=${tab}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    headers: cookie ? { cookie } : {},
  });

describe('posting', () => {
  it('limits posts to 500 characters, 2,000 with a staking level', async () => {
    const { cookie, user } = await login(ctx, 'writer');
    expect((await post(cookie, { text: 'a'.repeat(500), visibility: 'public' })).statusCode).toBe(200);
    const long = await post(cookie, { text: 'a'.repeat(501), visibility: 'public' });
    expect(long.statusCode).toBe(400);
    expect(long.json().error).toBe('too_long');
    expect((await post(cookie, { text: '   ', visibility: 'public' })).json().error).toBe('empty_post');
    await prisma.user.update({ where: { id: user.id }, data: { stakingLevel: 1 } });
    expect((await post(cookie, { text: 'b'.repeat(2000), visibility: 'public' })).statusCode).toBe(200);
    expect((await post(cookie, { text: 'b'.repeat(2001), visibility: 'public' })).statusCode).toBe(400);
  });

  it('parses #tags into PostTag and @mentions into mention notifications', async () => {
    expect(parseTags('gm #SwayDaily and #OpenModel #swaydaily x#no #123')).toEqual([
      'swaydaily',
      'openmodel',
    ]);
    expect(parseMentions('hey @Bob, @carol_1 and me@mail.com @bob')).toEqual(['bob', 'carol_1']);
    const bob = await login(ctx, 'bob');
    const { cookie } = await login(ctx, 'tagger');
    const res = await post(cookie, { text: 'hi @bob and @ghost #SwayDaily #Genesis', visibility: 'public' });
    const p = res.json<PostDTO>();
    expect((await prisma.postTag.findMany({ where: { postId: p.id } })).map((t) => t.tag).sort()).toEqual([
      'genesis',
      'swaydaily',
    ]);
    const n = await prisma.notification.findMany({ where: { userId: bob.user.id } });
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ type: 'mention', link: `/post/${p.id}` });
    expect(JSON.stringify(n[0]!.body)).toContain('mentioned you: “hi @bob');
    // Gated posts do not quote their text in the notification.
    await post(cookie, { text: '@bob secret alpha', visibility: 'holders' });
    const n2 = await prisma.notification.findFirst({
      where: { userId: bob.user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.stringify(n2!.body)).not.toContain('secret alpha');
    const tags = await ctx.app.inject('/api/explore?tab=tags&q=sway');
    expect(tags.json().tags[0]).toEqual({ tag: 'SwayDaily', posts: 1 });
  });

  it('replies bump replyCount and show in the thread', async () => {
    const a = await login(ctx, 'op');
    const b = await login(ctx, 'replier');
    const root = (await post(a.cookie, { text: 'root', visibility: 'public' })).json<PostDTO>();
    await post(b.cookie, { text: 'first', visibility: 'public', parentId: root.id });
    await post(a.cookie, { text: 'second', visibility: 'public', parentId: root.id });
    const t = (await ctx.app.inject(`/api/posts/${root.id}`)).json<PostDetailResponse>();
    expect(t.post.replies).toBe(2);
    // The author's own reply continues the post as a thread.
    expect(t.replies.map((r) => r.text)).toEqual(['first']);
    expect(t.thread.map((r) => r.text)).toEqual(['second']);
    expect(t.replies[0]!.parentId).toBe(root.id);
    // Replies stay out of the feed; the author is notified of the reply.
    const f = (await feed('latest')).json<FeedResponse>();
    expect(f.posts.map((p) => p.text)).toEqual(['root']);
    expect(await prisma.notification.count({ where: { userId: a.user.id, type: 'mention' } })).toBe(1);
    expect((await post(b.cookie, { text: 'x', visibility: 'public', parentId: 'missing' })).statusCode).toBe(
      404,
    );
  });
});

describe('gating', () => {
  let creator: Member;
  let fan: Member;
  let holderPost: PostDTO;
  let subsPost: PostDTO;
  const SECRET = 'The 3 wallets that front-ran every listing: 0xabc, 0xdef';
  const SUBS = 'Weekly macro note for subscribers only';

  beforeEach(async () => {
    creator = await member(ctx, 'novareyes');
    await openMarketRow(creator, 400n);
    fan = await member(ctx, 'fanboy');
    holderPost = (await post(creator.cookie, { text: SECRET, visibility: 'holders' })).json<PostDTO>();
    subsPost = (await post(creator.cookie, { text: SUBS, visibility: 'subs' })).json<PostDTO>();
    await post(creator.cookie, { text: 'public hello', visibility: 'public' });
  });

  const assertLocked = (p: PostDTO, len: number) => {
    expect(p.locked).toBe(true);
    expect(p.text).toBeNull();
    expect(p.teaser).toHaveLength(len);
  };

  it('locks holder and subscriber posts for guests without leaking the text', async () => {
    for (const tab of ['latest', 'foryou', 'trending']) {
      const res = await feed(tab);
      expect(res.body).not.toContain('front-ran');
      expect(res.body).not.toContain('macro note');
      const f = res.json<FeedResponse>();
      assertLocked(
        f.posts.find((p) => p.id === holderPost.id)!,
        SECRET.length,
      );
      assertLocked(
        f.posts.find((p) => p.id === subsPost.id)!,
        SUBS.length,
      );
      expect(f.posts.find((p) => p.text === 'public hello')!.locked).toBe(false);
    }
    for (const url of [`/api/posts/${holderPost.id}`, '/api/users/novareyes/posts']) {
      const r = await ctx.app.inject(url);
      expect(r.body).not.toContain('front-ran');
    }
    expect(teaser(5)).toBe('Hold ');
  });

  it('locks for members without keys, unlocks for holders with ≥ 100 units onchain', async () => {
    let f = (await feed('latest', fan.cookie)).json<FeedResponse>();
    assertLocked(
      f.posts.find((p) => p.id === holderPost.id)!,
      SECRET.length,
    );

    ctx.chain.setKeys(creator.address, fan.address, 99n);
    await ctx.redis.del(accessKey(creator.address, fan.address));
    f = (await feed('latest', fan.cookie)).json<FeedResponse>();
    expect(f.posts.find((p) => p.id === holderPost.id)!.locked).toBe(true);

    ctx.chain.setKeys(creator.address, fan.address, 100n);
    await ctx.redis.del(accessKey(creator.address, fan.address));
    f = (await feed('latest', fan.cookie)).json<FeedResponse>();
    const p = f.posts.find((x) => x.id === holderPost.id)!;
    expect(p).toMatchObject({ locked: false, text: SECRET, teaser: null });
    // Holding a key doesn't open subscriber posts.
    expect(f.posts.find((x) => x.id === subsPost.id)!.locked).toBe(true);
    // Balance cached for 60s: selling now still shows until the cache expires or a trade event clears it.
    expect(await ctx.redis.ttl(accessKey(creator.address, fan.address))).toBeGreaterThan(50);
  });

  it('batches access checks for a feed page (one read per market, then cache)', async () => {
    const other = await member(ctx, 'otherc');
    await openMarketRow(other);
    await post(other.cookie, { text: 'other holders post', visibility: 'holders' });
    await post(other.cookie, { text: 'other holders post 2', visibility: 'holders' });
    ctx.chain.balanceReads = 0;
    await feed('latest', fan.cookie);
    expect(ctx.chain.balanceReads).toBe(2);
    await feed('latest', fan.cookie);
    expect(ctx.chain.balanceReads).toBe(2);
  });

  it('unlocks subscriber posts with an unexpired subscription; authors always see their own', async () => {
    await prisma.subscription.create({
      data: {
        subscriberId: fan.user.id,
        creatorId: creator.user.id,
        txHash: '0x' + '1'.repeat(64),
        amountWei: '1',
        expiresAt: new Date(Date.now() + 86400e3),
      },
    });
    let f = (await feed('latest', fan.cookie)).json<FeedResponse>();
    expect(f.posts.find((p) => p.id === subsPost.id)).toMatchObject({ locked: false, text: SUBS });
    await prisma.subscription.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    f = (await feed('latest', fan.cookie)).json<FeedResponse>();
    expect(f.posts.find((p) => p.id === subsPost.id)!.locked).toBe(true);
    const mine = (await feed('latest', creator.cookie)).json<FeedResponse>();
    expect(mine.posts.every((p) => !p.locked && p.mine)).toBe(true);
  });
});

describe('likes and reposts', () => {
  it('toggle and keep the counters consistent, even under concurrency', async () => {
    const a = await login(ctx, 'liker');
    const b = await login(ctx, 'liker2');
    const p = (await post(a.cookie, { text: 'like me', visibility: 'public' })).json<PostDTO>();
    const like = (cookie: string) =>
      ctx.app.inject({ method: 'POST', url: `/api/posts/${p.id}/like`, headers: { cookie } });
    expect((await like(a.cookie)).json()).toEqual({ liked: true, count: 1 });
    expect((await like(b.cookie)).json()).toEqual({ liked: true, count: 2 });
    expect((await like(a.cookie)).json()).toEqual({ liked: false, count: 1 });
    await Promise.all(Array.from({ length: 6 }, () => like(a.cookie)));
    const row = await prisma.post.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.likeCount).toBe(await prisma.like.count({ where: { postId: p.id } }));
    const rp = await ctx.app.inject({
      method: 'POST',
      url: `/api/posts/${p.id}/repost`,
      headers: { cookie: b.cookie },
    });
    expect(rp.json()).toEqual({ reposted: true, count: 1 });
    const f = (await feed('latest', b.cookie)).json<FeedResponse>();
    expect(f.posts[0]).toMatchObject({ reposted: true, liked: true, reposts: 1 });
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/posts/nope/like', headers: { cookie: a.cookie } }))
        .statusCode,
    ).toBe(404);
  });
});

describe('ranking and tabs', () => {
  it('ranks For You with the prototype formula, Trending over 48h, Latest newest first', async () => {
    const hi = await login(ctx, 'highscore');
    const lo = await login(ctx, 'lowscore');
    await prisma.user.update({ where: { id: hi.user.id }, data: { score: 90 } });
    await prisma.user.update({ where: { id: lo.user.id }, data: { score: 10 } });
    const now = Date.now();
    const mk = (
      authorId: string,
      text: string,
      minsAgo: number,
      likes: number,
      reposts = 0,
      replies = 0,
      boosted = false,
    ) =>
      prisma.post.create({
        data: {
          authorId,
          text,
          createdAt: new Date(now - minsAgo * 60000),
          likeCount: likes,
          repostCount: reposts,
          replyCount: replies,
          boosted,
        },
      });
    await mk(lo.user.id, 'old viral', 60 * 72, 5000, 100);
    await mk(lo.user.id, 'fresh', 1, 10);
    await mk(hi.user.id, 'scored author', 30, 5);
    await mk(lo.user.id, 'boosted', 120, 0, 0, 0, true);

    const score = (
      p: { likeCount: number; repostCount: number; replyCount: number; boosted: boolean; createdAt: Date },
      s: number,
    ) => forYouScore(p, s, now);
    const rows = await prisma.post.findMany({ include: { author: true } });
    const expected = rows
      .sort((a, b) => score(b, b.author.score) - score(a, a.author.score))
      .map((r) => r.text);
    const fy = (await feed('foryou')).json<FeedResponse>();
    expect(fy.posts.map((p) => p.text)).toEqual(expected);
    expect(fy.posts[0]!.text).toBe('boosted');

    const tr = (await feed('trending')).json<FeedResponse>();
    expect(tr.posts.map((p) => p.text)).not.toContain('old viral');
    expect(tr.posts[0]!.text).toBe('fresh');

    const la = (await feed('latest')).json<FeedResponse>();
    expect(la.posts.map((p) => p.text)).toEqual(['fresh', 'scored author', 'boosted', 'old viral']);
  });

  it('paginates with cursors and pins the newest official post', async () => {
    const off = await prisma.user.create({
      data: {
        xId: '1',
        handle: 'swaydotfamily',
        name: 'Sway',
        official: true,
        verified: true,
        joinedAt: new Date(),
        memberNo: 99,
      },
    });
    await prisma.post.create({
      data: { authorId: off.id, text: 'old pin', pinned: true, createdAt: new Date(Date.now() - 1e6) },
    });
    const pin = await prisma.post.create({
      data: { authorId: off.id, text: 'Shipped today on Sway', pinned: true },
    });
    const { user } = await login(ctx, 'prolific');
    for (let i = 0; i < 45; i++)
      await prisma.post.create({
        data: { authorId: user.id, text: `p${i}`, createdAt: new Date(Date.now() - i * 1000) },
      });
    const p1 = (await feed('latest')).json<FeedResponse>();
    expect(p1.pinned?.id).toBe(pin.id);
    expect(p1.posts).toHaveLength(20);
    expect(p1.posts.some((p) => p.id === pin.id)).toBe(false);
    const p2 = (await feed('latest', undefined, p1.nextCursor!)).json<FeedResponse>();
    const p3 = (await feed('latest', undefined, p2.nextCursor!)).json<FeedResponse>();
    expect(p2.pinned).toBeNull();
    const all = [...p1.posts, ...p2.posts, ...p3.posts].map((p) => p.text);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(46);
    expect(p3.nextCursor).toBeNull();
    const fy1 = (await feed('foryou')).json<FeedResponse>();
    const fy2 = (await feed('foryou', undefined, fy1.nextCursor!)).json<FeedResponse>();
    expect(new Set([...fy1.posts, ...fy2.posts].map((p) => p.id)).size).toBe(40);
    expect((await feed('trending')).json<FeedResponse>().pinned).toBeNull();
  });

  it('the official account pins one post at a time; others cannot pin', async () => {
    const off = await login(ctx, 'swaydotfamily');
    await prisma.user.update({ where: { id: off.user.id }, data: { official: true } });
    const a = (await post(off.cookie, { text: 'welcome', visibility: 'public' })).json<PostDTO>();
    const b = (await post(off.cookie, { text: 'roadmap', visibility: 'public' })).json<PostDTO>();
    const pin = (cookie: string, id: string, pinned: boolean) =>
      ctx.app.inject({ method: 'POST', url: `/api/posts/${id}/pin`, headers: { cookie }, payload: { pinned } });

    expect((await pin(off.cookie, a.id, true)).json()).toEqual({ pinned: true });
    expect((await feed('foryou')).json<FeedResponse>().pinned?.id).toBe(a.id);
    await pin(off.cookie, b.id, true);
    const fy = (await feed('latest')).json<FeedResponse>();
    expect(fy.pinned?.id).toBe(b.id);
    expect(fy.posts.find((p) => p.id === a.id)?.pinned).toBe(false);
    await pin(off.cookie, b.id, false);
    expect((await feed('latest')).json<FeedResponse>().pinned).toBeNull();

    const other = await login(ctx, 'notofficial');
    const mine = (await post(other.cookie, { text: 'mine', visibility: 'public' })).json<PostDTO>();
    expect((await pin(other.cookie, mine.id, true)).json().error).toBe('not_pinnable');
    expect((await pin(other.cookie, a.id, true)).json().error).toBe('not_yours');
    await prisma.user.update({ where: { id: other.user.id }, data: { isAdmin: true } });
    expect((await pin(other.cookie, a.id, true)).statusCode).toBe(200);
    const reply = (await post(off.cookie, { text: 'thread', visibility: 'public', parentId: a.id })).json<PostDTO>();
    expect((await pin(off.cookie, reply.id, true)).json().error).toBe('not_pinnable');
  });

  it('Following shows followed authors, held markets and your own posts', async () => {
    const me = await member(ctx, 'follower');
    const followed = await login(ctx, 'followed');
    const held = await member(ctx, 'heldcreator');
    const hm = await openMarketRow(held);
    await login(ctx, 'stranger');
    for (const [h, c] of [
      ['follower', me.cookie],
      ['followed', followed.cookie],
      ['heldcreator', held.cookie],
    ] as const)
      await post(c, { text: `from ${h}`, visibility: 'public' });
    const s = await prisma.user.findUniqueOrThrow({ where: { handle: 'stranger' } });
    await prisma.post.create({ data: { authorId: s.id, text: 'from stranger' } });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/users/followed/follow',
      headers: { cookie: me.cookie },
    });
    await prisma.holding.create({ data: { marketId: hm.id, address: me.address, units: 50n } });
    const f = (await feed('following', me.cookie)).json<FeedResponse>();
    expect(f.posts.map((p) => p.text).sort()).toEqual(['from followed', 'from follower', 'from heldcreator']);
    expect((await feed('following')).json<FeedResponse>().posts).toEqual([]);
  });
});
