/**
 * SwayLaunchpad mirror: launches, curve trades (events carry the absolute reserves after each trade, so
 * re-processing is idempotent), graduation, airdrop and creator-fee claims.
 */
import { swayLaunchpadAbi } from '@sway/shared/abi';
import { addr, dec, decToBig, type Prisma } from '@sway/db';
import type { Clients } from '../clients';
import { createNotification } from '../notify';
import type { ApplyContext, LogMeta } from './apply';

type Tx = Prisma.TransactionClient;
const CURVE_SUPPLY = 900_000_000n * 10n ** 18n;

const fmtTokens = (wei: bigint) => {
  const v = Number(wei / 10n ** 18n);
  return v >= 1e6 ? `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}K` : String(v);
};

async function memberByAddress(tx: Tx, address: string) {
  const a = addr(address);
  const w = await tx.wallet.findUnique({ where: { address: a }, include: { user: true } });
  if (w) return w.user;
  return (await tx.linkedWallet.findUnique({ where: { address: a }, include: { user: true } }))?.user ?? null;
}

const byToken = (tx: Tx, token: string) => tx.launchToken.findUnique({ where: { tokenAddress: addr(token) }, include: { user: true } });

async function activity(tx: Tx, userId: string, ref: string, label: string, amountWei: bigint, m: LogMeta) {
  await tx.activity.upsert({ where: { ref }, update: {}, create: { userId, ref, label, amountWei: dec(amountWei), txHash: m.txHash, createdAt: m.ts } });
}

export async function onLaunched(
  c: ApplyContext,
  m: LogMeta,
  a: { creator: string; token: string; symbol: string; startCapWei: bigint; graduationCapWei: bigint; airdropRoot: string },
) {
  const { tx } = c;
  const creator = await memberByAddress(tx, a.creator);
  if (!creator) {
    console.warn(`[indexer] Launched by ${a.creator}, who has no Sway account; skipped`);
    return;
  }
  const existing = await tx.launchToken.findUnique({ where: { userId: creator.id } });
  if (existing?.tokenAddress === addr(a.token)) return;
  if (existing?.airdropRoot && existing.airdropRoot.toLowerCase() !== a.airdropRoot.toLowerCase()) {
    console.warn(`[indexer] launch of ${a.symbol}: onchain airdrop root differs from the stored attestation; claims need the matching proofs`);
  }
  const data = {
    symbol: a.symbol.replace(/^\$/, ''),
    tokenAddress: addr(a.token),
    launchTx: m.txHash,
    launchedAt: m.ts,
    startCapWei: dec(a.startCapWei),
    graduationCapWei: dec(a.graduationCapWei),
    airdropRoot: a.airdropRoot,
    tokenReserve: dec(CURVE_SUPPLY),
    ethReserveWei: dec(0),
    previewOn: true,
  };
  const row = existing
    ? await tx.launchToken.update({ where: { id: existing.id }, data })
    : await tx.launchToken.create({ data: { ...data, userId: creator.id, name: creator.name } });
  await activity(tx, creator.id, `launch:${m.txHash}:${m.logIndex}`, `Launched $${data.symbol}`, 0n, m);

  // Tell key holders who received part of the 10% airdrop.
  const drops = await tx.launchAirdrop.findMany({ where: { launchTokenId: row.id, claimTx: null } });
  const notified = new Set<string>();
  for (const d of drops) {
    const holder = await memberByAddress(tx, d.address);
    if (!holder || holder.id === creator.id || notified.has(holder.id)) continue;
    notified.add(holder.id);
    c.out.notifications.push(
      await createNotification(tx, {
        userId: holder.id, type: 'points', fromUserId: creator.id, link: '/launchpad',
        body: [{ t: creator.name, b: true }, { t: ` launched $${data.symbol}. You have ` }, { t: `${fmtTokens(decToBig(d.amount))} $${data.symbol}`, b: true }, { t: ' to claim as a key holder.' }],
      }),
    );
  }
}

export async function onLaunchTraded(
  c: ApplyContext,
  m: LogMeta,
  a: { token: string; trader: string; isBuy: boolean; ethAmount: bigint; tokenAmount: bigint; creatorFee: bigint; ethReserve: bigint; tokenReserve: bigint },
) {
  const { tx } = c;
  const lt = await byToken(tx, a.token);
  if (!lt) return;
  const ref = `launchtrade:${m.txHash}:${m.logIndex}`;
  if (await tx.activity.findUnique({ where: { ref } })) return;
  await tx.launchToken.update({
    where: { id: lt.id },
    data: {
      ethReserveWei: dec(a.ethReserve),
      tokenReserve: dec(a.tokenReserve),
      volumeWei: dec(decToBig(lt.volumeWei) + a.ethAmount),
      creatorFeesWei: dec(decToBig(lt.creatorFeesWei) + a.creatorFee),
    },
  });
  const trader = await memberByAddress(tx, a.trader);
  const label = `${a.isBuy ? 'Bought' : 'Sold'} ${fmtTokens(a.tokenAmount)} $${lt.symbol}`;
  if (trader) await activity(tx, trader.id, ref, label, a.isBuy ? -a.ethAmount : a.ethAmount, m);
  else await tx.activity.create({ data: { userId: lt.userId, ref, label: `${label} (external wallet)`, amountWei: dec(0), txHash: m.txHash, createdAt: m.ts } });
}

export async function onGraduated(c: ApplyContext, m: LogMeta, a: { token: string; ethReserve: bigint; tokenReserve: bigint }) {
  const lt = await byToken(c.tx, a.token);
  if (!lt || lt.graduated) return;
  await c.tx.launchToken.update({ where: { id: lt.id }, data: { graduated: true, ethReserveWei: dec(a.ethReserve), tokenReserve: dec(a.tokenReserve) } });
  c.out.notifications.push(
    await createNotification(c.tx, {
      userId: lt.userId, type: 'points', link: '/launchpad',
      body: [{ t: `$${lt.symbol}`, b: true }, { t: ' graduated: its liquidity is now in a Uniswap pool, where it trades from here.' }],
    }),
  );
}

export async function onAirdropClaimed(c: ApplyContext, m: LogMeta, a: { token: string; account: string; amount: bigint }) {
  const lt = await byToken(c.tx, a.token);
  if (!lt) return;
  await c.tx.launchAirdrop.updateMany({ where: { launchTokenId: lt.id, address: addr(a.account) }, data: { claimTx: m.txHash } });
  const holder = await memberByAddress(c.tx, a.account);
  if (holder) await activity(c.tx, holder.id, `airdrop:${m.txHash}:${m.logIndex}`, `Claimed ${fmtTokens(a.amount)} $${lt.symbol} airdrop`, 0n, m);
}

export async function onCreatorFeesClaimed(c: ApplyContext, m: LogMeta, a: { creator: string; amount: bigint }) {
  const member = await memberByAddress(c.tx, a.creator);
  if (member) await activity(c.tx, member.id, `launchfees:${m.txHash}:${m.logIndex}`, 'Claimed token creator fees', a.amount, m);
}

/** After a reorg: re-read every launched token's curve from the chain (and drop launches that vanished). */
export async function resyncLaunches(c: Clients): Promise<void> {
  const pad = c.cfg.contracts.launchpad;
  if (!pad) return;
  const tokens = await c.prisma.launchToken.findMany({ where: { tokenAddress: { not: null } }, include: { user: { include: { wallet: true } } } });
  for (const lt of tokens) {
    const owner = lt.user.wallet?.address as `0x${string}` | undefined;
    const onchain = owner ? ((await c.pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'tokenOf', args: [owner] })) as string) : null;
    if (!onchain || /^0x0{40}$/i.test(onchain)) {
      await c.prisma.launchToken.update({ where: { id: lt.id }, data: { tokenAddress: null, launchTx: null, launchedAt: null, graduated: false } });
      continue;
    }
    const curve = (await c.pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'curves', args: [onchain as `0x${string}`] })) as readonly unknown[];
    await c.prisma.launchToken.update({
      where: { id: lt.id },
      data: { ethReserveWei: dec(curve[2] as bigint), tokenReserve: dec(curve[3] as bigint), graduated: curve[6] as boolean },
    });
  }
}
