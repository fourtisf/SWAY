/**
 * Admin tool: open a fan market for an X account that hasn't joined Sway (brief §9).
 *
 *   pnpm --filter @sway/workers open-fan-market -- --handle orbitlabs --category crypto
 *   pnpm --filter @sway/workers open-fan-market -- --handle orbitlabs --category crypto --xid 123 --name "Orbit Labs" --followers 1200000
 *
 * With X_BEARER_TOKEN the profile is read from X; otherwise pass --xid/--name/--followers. Creates the
 * placeholder profile and KeyMarket row (category is offchain metadata), then calls
 * SwayKeys.openFanMarket(xId) with OPERATOR_PRIVATE_KEY (which must be a fan admin). The indexer marks
 * the market opened. The profile is labelled "Unclaimed fan market" everywhere until the owner claims.
 */
import { parseArgs } from 'node:util';
import { score } from '@sway/scoring';
import { fanSubject, MARKET_CATEGORIES, normalizeHandle, type MarketCategory } from '@sway/shared';
import { swayKeysAbi } from '@sway/shared/abi';
import { getRecentPosts, getUserByUsername, scoreXAccount } from '@sway/x';
import { prisma } from '@sway/db';
import { FAN_BIO } from '@sway/db/demo';
import { loadConfig } from '../config';
import { makeClients } from '../clients';
import { appXContext } from '../xctx';

async function main() {
  const { values } = parseArgs({
    options: { handle: { type: 'string' }, category: { type: 'string' }, xid: { type: 'string' }, name: { type: 'string' }, followers: { type: 'string' } },
  });
  const handle = normalizeHandle(values.handle ?? '');
  const category = values.category as MarketCategory;
  if (!handle || !MARKET_CATEGORIES.includes(category) || category === 'creators') {
    throw new Error('usage: --handle <x handle> --category crypto|football|stocks|rwa [--xid --name --followers]');
  }
  const cfg = loadConfig();
  const c = makeClients(cfg);
  if (!cfg.contracts.swayKeys || !c.operator) throw new Error('SWAY_KEYS_ADDRESS and OPERATOR_PRIVATE_KEY are required');

  let profile: { xId: string; name: string; followers: number; verified: boolean; avatarUrl: string | null; score: number; value: number; inputs: object };
  const ctx = appXContext(c);
  if (ctx) {
    const xu = await getUserByUsername(ctx, handle);
    if (!xu) throw new Error(`@${handle} not found on X`);
    const { inputs, result } = scoreXAccount(xu, await getRecentPosts(ctx, xu.id, 50));
    profile = { xId: xu.id, name: xu.name, followers: xu.followers, verified: xu.verified, avatarUrl: xu.profileImageUrl, score: result.score, value: result.value, inputs };
  } else {
    if (!values.xid || !values.name) throw new Error('without X_BEARER_TOKEN pass --xid and --name');
    const followers = Number(values.followers ?? 0);
    const inputs = { followers, er: 0, ppw: 0, age: 0, verified: true };
    const r = score(inputs);
    profile = { xId: values.xid, name: values.name, followers, verified: true, avatarUrl: null, score: r.score, value: r.value, inputs };
  }

  const existing = await prisma.user.findUnique({ where: { xId: profile.xId } });
  if (existing?.joinedAt) throw new Error(`@${handle} is already a member; members open their own market`);
  const user =
    existing ??
    (await prisma.user.create({
      data: {
        xId: profile.xId, handle, name: profile.name, bio: FAN_BIO, followers: profile.followers, verified: profile.verified,
        avatarUrl: profile.avatarUrl, score: profile.score, reachValue: profile.value, scoreInputs: profile.inputs, scoredAt: new Date(),
      },
    }));
  const subject = fanSubject(profile.xId).toLowerCase();
  await prisma.keyMarket.upsert({
    where: { xId: profile.xId },
    update: { category },
    create: { subject, userId: user.id, xId: profile.xId, fan: true, claimed: false, category, opened: false },
  });
  const hash = await c.operator.writeContract({ address: cfg.contracts.swayKeys, abi: swayKeysAbi, functionName: 'openFanMarket', args: [BigInt(profile.xId)] });
  const rcpt = await c.pub.waitForTransactionReceipt({ hash });
  console.log(`fan market for @${handle} (${category}) at ${subject}: tx ${hash} ${rcpt.status}`);
  await prisma.$disconnect();
  c.redis.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
