/**
 * SwayDrops mirror: creator ETH drops to key holders. CreatorDrop rows come only from events; the allocations
 * (DropPlan/DropAllocation) were written by the API when the creator built the tree, and get their claimTx here.
 */
import { weiToEth } from '@sway/curve';
import { swayDropsAbi } from '@sway/shared/abi';
import { makeFormat } from '@sway/shared';
import { addr, dec, decToBig, type Prisma } from '@sway/db';
import type { Clients } from '../clients';
import { createNotification } from '../notify';
import { memberByAddress, type ApplyContext, type LogMeta } from './apply';

type Tx = Prisma.TransactionClient;

async function activity(tx: Tx, userId: string, ref: string, label: string, amountWei: bigint, m: LogMeta) {
  await tx.activity.upsert({ where: { ref }, update: {}, create: { userId, ref, label, amountWei: dec(amountWei), txHash: m.txHash, createdAt: m.ts } });
}

export async function onDropCreated(
  c: ApplyContext,
  m: LogMeta,
  a: { id: bigint; creator: string; root: string; total: bigint; expiresAt: bigint },
): Promise<void> {
  const { tx } = c;
  const id = Number(a.id);
  if (await tx.creatorDrop.findUnique({ where: { id } })) return;
  const root = a.root.toLowerCase();
  await tx.creatorDrop.create({
    data: {
      id, creator: addr(a.creator), root, totalWei: dec(a.total), expiresAt: new Date(Number(a.expiresAt) * 1000),
      txHash: m.txHash, blockNumber: m.blockNumber, createdAt: m.ts,
    },
  });
  const creator = await memberByAddress(tx, a.creator);
  if (!creator) return;
  await activity(tx, creator.id, `drop:${m.txHash}:${m.logIndex}`, 'Airdropped ETH to your holders', -a.total, m);
  const plan = await tx.dropPlan.findUnique({ where: { root }, include: { allocations: { where: { userId: { not: null } } } } });
  if (!plan || plan.creatorId !== creator.id) return;
  const f = makeFormat(c.ethUsd);
  const notified = new Set<string>();
  for (const al of plan.allocations) {
    if (!al.userId || notified.has(al.userId) || al.userId === creator.id) continue;
    notified.add(al.userId);
    const amount = plan.allocations.filter((x) => x.userId === al.userId).reduce((s, x) => s + decToBig(x.amountWei), 0n);
    c.out.notifications.push(
      await createNotification(tx, {
        userId: al.userId, type: 'points', fromUserId: creator.id, link: '/wallet',
        body: [{ t: `@${creator.handle}`, b: true }, { t: ` airdropped ${f.eth(weiToEth(amount))} ETH to you for holding their key. Claim it on your Wallet page.` }],
      }),
    );
  }
}

export async function onDropClaimed(c: ApplyContext, m: LogMeta, a: { id: bigint; account: string; amount: bigint }): Promise<void> {
  const { tx } = c;
  const drop = await tx.creatorDrop.findUnique({ where: { id: Number(a.id) } });
  if (!drop) return;
  const ref = `dropclaim:${m.txHash}:${m.logIndex}`;
  if (await tx.activity.findUnique({ where: { ref } })) return;
  await tx.creatorDrop.update({ where: { id: drop.id }, data: { claimedWei: dec(decToBig(drop.claimedWei) + a.amount) } });
  await tx.dropAllocation.updateMany({ where: { root: drop.root, address: addr(a.account) }, data: { claimTx: m.txHash, claimBlock: m.blockNumber } });
  const holder = await memberByAddress(tx, a.account);
  const creator = await memberByAddress(tx, drop.creator);
  if (holder) await activity(tx, holder.id, ref, `Claimed airdrop${creator ? ` from @${creator.handle}` : ''}`, a.amount, m);
}

export async function onDropReclaimed(c: ApplyContext, m: LogMeta, a: { id: bigint; creator: string; amount: bigint }): Promise<void> {
  const { tx } = c;
  const drop = await tx.creatorDrop.findUnique({ where: { id: Number(a.id) } });
  if (!drop || drop.reclaimed) return;
  await tx.creatorDrop.update({ where: { id: drop.id }, data: { reclaimed: true } });
  const creator = await memberByAddress(tx, a.creator);
  if (creator) await activity(tx, creator.id, `dropreclaim:${m.txHash}:${m.logIndex}`, 'Took back unclaimed airdrop', a.amount, m);
}

/** Inside the rollback transaction: forget drops and claims above `to`. */
export async function rollbackDrops(tx: Tx, to: bigint): Promise<void> {
  const claims = await tx.dropAllocation.findMany({ where: { claimBlock: { gt: to } }, select: { claimTx: true } });
  const txs = claims.map((x) => x.claimTx!).filter(Boolean);
  if (txs.length) await tx.activity.deleteMany({ where: { txHash: { in: txs }, ref: { startsWith: 'dropclaim:' } } });
  await tx.dropAllocation.updateMany({ where: { claimBlock: { gt: to } }, data: { claimTx: null, claimBlock: null } });
  const gone = await tx.creatorDrop.findMany({ where: { blockNumber: { gt: to } }, select: { txHash: true } });
  if (gone.length) await tx.activity.deleteMany({ where: { txHash: { in: gone.map((g) => g.txHash) }, ref: { startsWith: 'drop:' } } });
  await tx.creatorDrop.deleteMany({ where: { blockNumber: { gt: to } } });
}

/** After a reorg: re-read claimed totals and reclaim flags of the drops that survived. */
export async function resyncDrops(c: Clients): Promise<void> {
  const address = c.cfg.contracts.drops;
  if (!address) return;
  for (const d of await c.prisma.creatorDrop.findMany()) {
    const r = (await c.pub.readContract({ address, abi: swayDropsAbi, functionName: 'drops', args: [BigInt(d.id)] })) as readonly unknown[];
    await c.prisma.creatorDrop.update({ where: { id: d.id }, data: { claimedWei: dec(r[4] as bigint), reclaimed: r[5] as boolean } });
  }
}
