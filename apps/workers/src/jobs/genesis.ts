/**
 * Genesis snapshot (brief §8). At SNAPSHOT_AT: freeze points + wallets in one DB transaction, rank the
 * eligible top 500, split the pool with the integer 1/√rank recipe, store and publish the list hash,
 * then commit it onchain and mint the soulbound passes (tokenId = rank) within 24 hours.
 */
import { keccak256, toBytes } from 'viem';
import { allocateGenesis, rankGenesis, scorePoints, type GenesisCandidate } from '@sway/scoring';
import { genesisPassAbi } from '@sway/shared/abi';
import { dec } from '@sway/db';
import type { Clients } from '../clients';
import { withSenderLock } from '../txlock';

export interface SnapshotResult {
  snapshotId: string;
  entries: number;
  listHash: string;
}

export async function takeSnapshot(c: Clients, takenAt = c.cfg.snapshotAt): Promise<SnapshotResult | null> {
  const { prisma, cfg } = c;
  const existing = await prisma.genesisSnapshot.findUnique({ where: { takenAt } });
  if (existing) return null;
  return prisma.$transaction(
    async (tx) => {
      const members = await tx.user.findMany({
        where: { joinedAt: { not: null } },
        select: { id: true, score: true, heldPoints: true, botFlag: true, memberNo: true, wallet: { select: { address: true } } },
      });
      const sums = new Map(
        (await tx.pointsLedger.groupBy({ by: ['userId'], _sum: { amount: true } })).map((s) => [s.userId, s._sum.amount ?? 0]),
      );
      const verified = new Map(
        (await tx.taskCompletion.groupBy({ by: ['userId'], where: { status: { in: ['verified', 'trusted'] } }, _count: true })).map((g) => [g.userId, g._count]),
      );
      const cands: GenesisCandidate[] = members.map((m) => ({
        userId: m.id,
        points: scorePoints(m.score) + (sums.get(m.id) ?? 0) + m.heldPoints,
        wallet: m.wallet?.address ?? null,
        tasksVerified: verified.get(m.id) ?? 0,
        botFlag: m.botFlag,
        score: m.score,
        memberNo: m.memberNo ?? Number.MAX_SAFE_INTEGER,
      }));
      const ranked = rankGenesis(cands, cfg.genesisMinScore);
      const alloc = ranked.length ? allocateGenesis(cfg.genesisPoolUnits, ranked.length) : [];
      const list = ranked.map((r, i) => ({ rank: r.rank, wallet: r.wallet!, points: r.points, units: alloc[i]!.units.toString() }));
      const listHash = keccak256(toBytes(JSON.stringify(list)));
      const snap = await tx.genesisSnapshot.create({ data: { takenAt, listHash, poolUnits: dec(cfg.genesisPoolUnits), published: true } });
      if (list.length) {
        await tx.genesisEntry.createMany({
          data: ranked.map((r, i) => ({ snapshotId: snap.id, rank: r.rank, userId: r.userId, points: r.points, wallet: r.wallet!, units: dec(alloc[i]!.units) })),
        });
      }
      return { snapshotId: snap.id, entries: list.length, listHash };
    },
    { timeout: 120_000 },
  );
}

/** Commits the list hash once, then mints passes in batches of 50 for entries not yet minted. */
export async function mintPasses(c: Clients): Promise<number> {
  const { prisma, cfg } = c;
  const pass = cfg.contracts.genesisPass;
  const issuer = c.issuer;
  if (!pass || !issuer) return 0;
  const send = (args: Parameters<typeof issuer.writeContract>[0]) =>
    withSenderLock(c, issuer, async () => {
      const hash = await issuer.writeContract(args);
      await c.pub.waitForTransactionReceipt({ hash });
      return hash;
    });
  const snap = await prisma.genesisSnapshot.findFirst({ orderBy: { takenAt: 'desc' }, include: { entries: { where: { mintTx: null }, orderBy: { rank: 'asc' } } } });
  if (!snap) return 0;
  const committed = (await c.pub.readContract({ address: pass, abi: genesisPassAbi, functionName: 'snapshotHash' })) as `0x${string}`;
  if (/^0x0{64}$/.test(committed)) {
    await send({
      address: pass, abi: genesisPassAbi, functionName: 'commitSnapshot',
      args: [snap.listHash as `0x${string}`, BigInt(Math.floor(snap.takenAt.getTime() / 1000)), `${cfg.genesisListBaseUrl}/${snap.id}`],
    } as never);
  } else if (committed.toLowerCase() !== snap.listHash.toLowerCase()) {
    throw new Error(`GenesisPass committed ${committed} but the latest snapshot is ${snap.listHash}; refusing to mint`);
  }
  let minted = 0;
  for (let i = 0; i < snap.entries.length; i += 50) {
    const batch = snap.entries.slice(i, i + 50);
    const pending = [];
    for (const e of batch) {
      const owner = await c.pub.readContract({ address: pass, abi: genesisPassAbi, functionName: 'ownerOf', args: [BigInt(e.rank)] }).catch(() => null);
      if (!owner) pending.push(e);
    }
    if (!pending.length) continue;
    const hash = await send({
      address: pass, abi: genesisPassAbi, functionName: 'mintBatch',
      args: [pending.map((e) => e.wallet as `0x${string}`), pending.map((e) => BigInt(e.rank))],
    } as never);
    await prisma.genesisEntry.updateMany({ where: { snapshotId: snap.id, rank: { in: pending.map((e) => e.rank) } }, data: { mintTx: hash } });
    minted += pending.length;
  }
  return minted;
}

export async function genesisTick(c: Clients, now = new Date()): Promise<void> {
  if (now < c.cfg.snapshotAt) return;
  const r = await takeSnapshot(c);
  if (r) console.log(`[genesis] snapshot ${r.snapshotId}: ${r.entries} passes, list ${r.listHash}`);
  const n = await mintPasses(c);
  if (n) console.log(`[genesis] minted ${n} passes`);
}
