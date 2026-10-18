/**
 * Local demo seed: the prototype's members, fan accounts, posts, leaderboard and battles.
 * Key markets are NOT created for members here: markets come from the chain. Run
 * `pnpm --filter @sway/workers seed:chain` against anvil afterwards to open markets and trade keys, and
 * the indexer mirrors them. Fan-market rows are pre-created (category is offchain metadata) and get
 * opened by seed:chain. Refuses to run when NODE_ENV=production.
 */
import { PrismaClient } from '@prisma/client';
import { scorePoints, tierOf } from '@sway/scoring';
import { fanSubject, TASKS } from '@sway/shared';
import {
  demoBattles,
  demoCreators,
  demoFans,
  demoLeaderboard,
  demoPosts,
  demoXId,
  makeUser,
  OFFICIAL,
} from '../src/demo';

if (process.env.NODE_ENV === 'production') throw new Error('refusing to seed demo data in production');

const prisma = new PrismaClient();
const DAY = 86400e3;
const ONE_OFF = new Date('1970-01-01T00:00:00Z');

async function main() {
  const now = Date.now();
  const existing = await prisma.user.count();
  if (existing > 0 && !process.argv.includes('--force')) {
    console.log(`database already has ${existing} users; run \`pnpm --filter @sway/db reset\` first or pass --force`);
    return;
  }
  for (const t of TASKS) {
    await prisma.task.upsert({ where: { id: t.id }, update: { title: t.title, pts: t.pts, group: t.group }, create: { id: t.id, title: t.title, pts: t.pts, group: t.group } });
  }

  const ids = new Map<string, string>();
  const usedMemberNos = new Set<number>([1]);
  const memberNo = (n: number) => {
    while (usedMemberNos.has(n)) n++;
    usedMemberNos.add(n);
    return n;
  };

  const official = await prisma.user.create({
    data: {
      xId: demoXId(OFFICIAL.handle), handle: OFFICIAL.handle, name: OFFICIAL.name, bio: OFFICIAL.bio, official: true,
      verified: true, followers: 88_000, score: 70, reachValue: 0, memberNo: 1, joinedAt: new Date(now - 60 * DAY),
    },
  });
  ids.set(official.handle, official.id);

  for (const c of demoCreators()) {
    const u = await prisma.user.create({
      data: {
        xId: c.xId, handle: c.handle, name: c.name, bio: c.bio, followers: c.followers, verified: c.verified,
        score: c.score, reachValue: c.value, scoreInputs: c.inputs, scoredAt: new Date(now),
        xCreatedAt: new Date(now - c.inputs.age * 365.25 * DAY),
        memberNo: memberNo(c.memberNo), joinedAt: new Date(now - c.joinedDaysAgo * DAY),
      },
    });
    ids.set(c.handle, u.id);
  }

  for (const f of demoFans()) {
    const u = await prisma.user.create({
      data: {
        xId: f.xId, handle: f.handle, name: f.name, bio: f.bio, followers: f.followers, verified: true,
        score: f.score, reachValue: f.value, scoreInputs: f.inputs, scoredAt: new Date(now),
        xCreatedAt: new Date(now - f.inputs.age * 365.25 * DAY),
      },
    });
    ids.set(f.handle, u.id);
    await prisma.keyMarket.create({
      data: { subject: fanSubject(f.xId).toLowerCase(), userId: u.id, xId: f.xId, fan: true, claimed: false, category: f.category, opened: false },
    });
  }

  // Leaderboard members: everyone who isn't a demo creator becomes a member with ledger points.
  for (const [i, row] of demoLeaderboard().entries()) {
    let userId = ids.get(row.handle);
    let score = 0;
    if (!userId) {
      const p = makeUser(row.handle);
      const u = await prisma.user.create({
        data: {
          xId: demoXId(row.handle), handle: row.handle, name: row.name, followers: p.followers, verified: p.verified,
          score: p.score, reachValue: p.value, scoreInputs: p.inputs, scoredAt: new Date(now),
          xCreatedAt: new Date(now - p.inputs.age * 365.25 * DAY),
          memberNo: memberNo(19_000 + i * 7), joinedAt: new Date(now - (5 + (i % 30)) * DAY),
        },
      });
      userId = u.id;
      score = p.score;
      ids.set(row.handle, userId);
    } else {
      score = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).score;
    }
    const ledger = Math.max(0, row.pts - scorePoints(score));
    await prisma.pointsLedger.create({ data: { userId, kind: 'seed', amount: ledger, ref: 'seed:leaderboard' } });
    await prisma.taskCompletion.create({
      data: { userId, taskId: 'follow', day: ONE_OFF, status: 'verified', points: 0, verifiedAt: new Date(now - DAY) },
    });
    await prisma.user.update({ where: { id: userId }, data: { ledgerPoints: ledger, tier: tierOf(row.pts).name } });
    if (row.staked > 0) {
      // Mirror rows normally written by the indexer; demo only until $SWAY exists.
      await prisma.stake.create({ data: { userId, address: `0xdemo${i.toString().padStart(36, '0')}`, amountWei: `${row.staked}000000000000000000`, level: row.staked >= 250_000 ? 4 : row.staked >= 50_000 ? 3 : row.staked >= 10_000 ? 2 : row.staked >= 1_000 ? 1 : 0 } });
    }
  }

  for (const p of demoPosts()) {
    const authorId = ids.get(p.author);
    if (!authorId) continue;
    const post = await prisma.post.create({
      data: {
        authorId, text: p.text, visibility: p.visibility, pinned: !!p.pinned, boosted: p.boosted,
        likeCount: p.likes, repostCount: p.reposts, replyCount: p.replies, createdAt: new Date(now - p.minutesAgo * 60e3),
      },
    });
    const tags = [...new Set([...p.text.matchAll(/#(\w+)/g)].map((m) => m[1]!.toLowerCase()))];
    if (tags.length) await prisma.postTag.createMany({ data: tags.map((tag) => ({ postId: post.id, tag })) });
  }

  const backers = demoLeaderboard().filter((r) => !r.creator).slice(0, 12);
  for (const [bi, b] of demoBattles().entries()) {
    const aId = ids.get(b.a)!;
    const bId = ids.get(b.b)!;
    const endsAt = new Date(now + b.endsInHours * 3600e3);
    const battle = await prisma.battle.create({
      data: {
        aId, bId, theme: b.theme, stake: b.stake, status: 'live', acceptedAt: new Date(endsAt.getTime() - DAY), endsAt,
        expiresAt: new Date(endsAt.getTime() - DAY + 2 * DAY), erA: b.erA, erB: b.erB,
      },
    });
    if (b.stake > 0) {
      for (const uid of [aId, bId]) {
        await prisma.pointsLedger.create({ data: { userId: uid, kind: 'battle_stake', amount: -b.stake, ref: `battle:${battle.id}:stake` } });
      }
    }
    // three backers a side whose amounts add up to the prototype's pools
    for (const [side, pool] of [['a', b.poolA], ['b', b.poolB]] as const) {
      const parts = [Math.round(pool * 0.5), Math.round(pool * 0.3)];
      parts.push(pool - parts[0]! - parts[1]!);
      for (const [k, amount] of parts.entries()) {
        const backer = backers[(bi * 4 + k + (side === 'b' ? 2 : 0)) % backers.length]!;
        const userId = ids.get(backer.handle)!;
        const dup = await prisma.battleBacking.findUnique({ where: { battleId_userId: { battleId: battle.id, userId } } });
        if (dup) continue;
        await prisma.battleBacking.create({ data: { battleId: battle.id, userId, side, amount } });
        await prisma.pointsLedger.create({ data: { userId, kind: 'battle_back', amount: -amount, ref: `battle:${battle.id}:back` } });
      }
    }
  }

  const counts = await Promise.all([prisma.user.count(), prisma.post.count(), prisma.keyMarket.count(), prisma.battle.count()]);
  console.log(`seeded users=${counts[0]} posts=${counts[1]} fanMarkets=${counts[2]} battles=${counts[3]}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
