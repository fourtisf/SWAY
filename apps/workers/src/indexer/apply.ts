/**
 * Applies decoded contract events to the Postgres mirror. Every handler is idempotent (unique keys on
 * txHash + logIndex) and runs inside the indexer's per-batch transaction.
 */
import { LOCKED_UNITS, priceWei, quoteWei, unitsToKeys, weiToEth } from '@sway/curve';
import { tradedPoints } from '@sway/scoring';
import { makeFormat, type RichText } from '@sway/shared';
import { addr, dec, decToBig, type Prisma } from '@sway/db';
import { createNotification } from '../notify';

type Tx = Prisma.TransactionClient;

export interface LogMeta {
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
  ts: Date;
}

export interface ApplyContext {
  tx: Tx;
  ethUsd: number;
  fanEscrow: string | null;
  /** Bus events to publish after the transaction commits. */
  out: { trades: string[]; markets: Set<string>; notifications: string[] };
}

const keysLabel = (units: bigint) => {
  const k = unitsToKeys(units);
  const s = (Math.round(k * 100) / 100).toString();
  return `${s} key${k === 1 ? '' : 's'}`;
};

/** The member owning `address`: their account wallet or one of their linked wallets. */
export async function memberByAddress(tx: Tx, address: string) {
  const a = addr(address);
  const w = await tx.wallet.findUnique({ where: { address: a }, include: { user: true } });
  if (w) return w.user;
  const l = await tx.linkedWallet.findUnique({ where: { address: a }, include: { user: true } });
  return l?.user ?? null;
}

/** Percent change of price over the last 24 trades (the prototype's change), from the Trade mirror. */
export async function recentChange(tx: Tx, marketId: string, currentSupply: bigint): Promise<number> {
  const rows = await tx.trade.findMany({ where: { marketId }, orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }], take: 25, select: { supplyAfter: true } });
  const ref = rows.length >= 25 ? rows[24]!.supplyAfter : LOCKED_UNITS;
  const now = Number(priceWei(currentSupply));
  const then = Number(priceWei(ref));
  return then > 0 ? (now / then - 1) * 100 : 0;
}

export async function onMarketOpened(
  c: ApplyContext,
  m: LogMeta,
  a: { subject: string; owner: string; xId: bigint; fan: boolean },
): Promise<void> {
  const { tx } = c;
  const xId = a.xId.toString();
  const subject = addr(a.subject);
  let user = await tx.user.findUnique({ where: { xId } });
  if (!user) {
    // Opened outside the app (no profile yet). Keep the mirror consistent with a placeholder profile.
    console.warn(`[indexer] MarketOpened for unknown xId ${xId}; creating a placeholder profile`);
    user = await tx.user.create({ data: { xId, handle: `x${xId}`.slice(0, 32), name: `X account ${xId}` } });
  }
  const existing = await tx.keyMarket.findUnique({ where: { xId } });
  if (existing?.opened && existing.openTx === m.txHash) return;
  const data = {
    subject,
    userId: user.id,
    fan: a.fan,
    claimed: !a.fan,
    opened: true,
    openTx: m.txHash,
    openedAt: m.ts,
    openBlock: m.blockNumber,
    supplyUnits: LOCKED_UNITS,
    priceWei: dec(priceWei(LOCKED_UNITS)),
    holders: 1,
  };
  const market = existing
    ? await tx.keyMarket.update({ where: { id: existing.id }, data })
    : await tx.keyMarket.create({ data: { ...data, xId, category: 'creators' } });
  const lockHolder = a.fan ? c.fanEscrow : a.owner;
  if (lockHolder) {
    await tx.holding.upsert({
      where: { marketId_address: { marketId: market.id, address: addr(lockHolder) } },
      update: {},
      create: { marketId: market.id, address: addr(lockHolder), units: LOCKED_UNITS },
    });
  }
  c.out.markets.add(market.id);
}

export interface TradeArgs {
  trader: string;
  subject: string;
  isBuy: boolean;
  units: bigint;
  ethBase: bigint;
  creatorFee: bigint;
  protocolFee: bigint;
  holderFee: bigint;
  referralFee: bigint;
  supplyAfter: bigint;
}

export async function onTrade(c: ApplyContext, m: LogMeta, a: TradeArgs): Promise<void> {
  const { tx } = c;
  const dup = await tx.trade.findUnique({ where: { txHash_logIndex: { txHash: m.txHash, logIndex: m.logIndex } } });
  if (dup) return;
  const market = await tx.keyMarket.findUnique({ where: { subject: addr(a.subject) }, include: { user: true } });
  if (!market) {
    console.error(`[indexer] Trade for unknown market ${a.subject} (tx ${m.txHash}); skipped`);
    return;
  }
  const fees = a.creatorFee + a.protocolFee + a.holderFee + a.referralFee;
  const total = a.isBuy ? a.ethBase + fees : a.ethBase - fees;
  const trader = addr(a.trader);
  const trade = await tx.trade.create({
    data: {
      txHash: m.txHash, logIndex: m.logIndex, blockNumber: m.blockNumber, blockHash: m.blockHash, marketId: market.id, trader,
      isBuy: a.isBuy, units: a.units, baseWei: dec(a.ethBase), creatorFeeWei: dec(a.creatorFee), protocolFeeWei: dec(a.protocolFee),
      holderFeeWei: dec(a.holderFee), referralFeeWei: dec(a.referralFee), totalWei: dec(total), supplyAfter: a.supplyAfter, ts: m.ts,
    },
  });

  // Holding with average-cost basis.
  const h = await tx.holding.findUnique({ where: { marketId_address: { marketId: market.id, address: trader } } });
  const held = h?.units ?? 0n;
  const basis = decToBig(h?.costBasisWei);
  let units: bigint, newBasis: bigint, realized = decToBig(h?.realizedPnlWei);
  if (a.isBuy) {
    units = held + a.units;
    newBasis = basis + total;
  } else {
    units = held - a.units;
    const soldBasis = held > 0n ? (basis * a.units) / held : 0n;
    newBasis = basis - soldBasis;
    realized += total - soldBasis;
  }
  if (units < 0n) {
    console.error(`[indexer] negative holding for ${trader} in ${market.subject}; clamping (mirror out of sync)`);
    units = 0n;
  }
  await tx.holding.upsert({
    where: { marketId_address: { marketId: market.id, address: trader } },
    update: { units, costBasisWei: dec(newBasis), realizedPnlWei: dec(realized) },
    create: { marketId: market.id, address: trader, units, costBasisWei: dec(newBasis), realizedPnlWei: dec(realized) },
  });

  // Fees go to FanEscrow until the claim is onchain (claimBlock), even after the app has marked it claimed.
  const escrowed = market.fan && market.claimBlock === null;
  const holders = await tx.holding.count({ where: { marketId: market.id, units: { gt: 0n } } });
  await tx.keyMarket.update({
    where: { id: market.id },
    data: {
      supplyUnits: a.supplyAfter,
      priceWei: dec(priceWei(a.supplyAfter)),
      volumeWei: dec(decToBig(market.volumeWei) + a.ethBase),
      escrowWei: escrowed ? dec(decToBig(market.escrowWei) + a.creatorFee) : market.escrowWei,
      creatorFeesWei: escrowed ? market.creatorFeesWei : dec(decToBig(market.creatorFeesWei) + a.creatorFee),
      holders,
      lastTradeAt: m.ts,
      change: await recentChange(tx, market.id, a.supplyAfter),
    },
  });

  const F = makeFormat(c.ethUsd);
  const member = await memberByAddress(tx, trader);
  const ref = `trade:${m.txHash}:${m.logIndex}`;
  if (member) {
    await tx.activity.upsert({
      where: { ref },
      update: {},
      create: {
        userId: member.id, ref, txHash: m.txHash, createdAt: m.ts,
        label: `${a.isBuy ? 'Bought' : 'Sold'} ${keysLabel(a.units)} of ${market.user.name}`,
        amountWei: dec(a.isBuy ? -total : total),
      },
    });
    // Keys traded: 100K points per ETH of curve volume, own key excluded.
    if (member.id !== market.userId) {
      const pts = tradedPoints(weiToEth(a.ethBase));
      if (pts > 0) {
        await tx.pointsLedger.upsert({
          where: { userId_kind_ref: { userId: member.id, kind: 'trade_volume', ref } },
          update: {},
          create: { userId: member.id, kind: 'trade_volume', amount: pts, ref },
        });
      }
    }
  }

  // Tell the market owner (a member, not trading their own keys).
  if (market.claimed && market.user.joinedAt && member?.id !== market.userId) {
    const who = member?.name ?? `${trader.slice(0, 6)}…${trader.slice(-4)}`;
    const body: RichText = [
      { t: who, b: true },
      { t: ` ${a.isBuy ? 'bought' : 'sold'} ${F.keys(unitsToKeys(a.units))} of your keys. You earned ` },
      { t: F.$(weiToEth(a.creatorFee)), b: true },
      { t: '.' },
    ];
    c.out.notifications.push(
      await createNotification(tx, { userId: market.userId, type: 'trade', body, fromUserId: member?.id ?? null, link: '/wallet' }),
    );
  }

  c.out.trades.push(trade.id);
  c.out.markets.add(market.id);
}

export async function onFanMarketClaimed(c: ApplyContext, m: LogMeta, a: { subject: string; owner: string; escrowReleased: bigint }) {
  const { tx } = c;
  const market = await tx.keyMarket.findUnique({ where: { subject: addr(a.subject) } });
  // The app marks a fan market claimed at sign-up, before (or without) this event: claimBlock is the indexer's.
  if (!market || market.claimBlock !== null) return;
  await tx.keyMarket.update({
    where: { id: market.id },
    data: { claimed: true, claimBlock: m.blockNumber, escrowWei: dec(0), creatorFeesWei: dec(decToBig(market.creatorFeesWei) + a.escrowReleased) },
  });
  if (c.fanEscrow) {
    const lock = await tx.holding.findUnique({ where: { marketId_address: { marketId: market.id, address: addr(c.fanEscrow) } } });
    const units = lock?.units ?? LOCKED_UNITS;
    if (lock) await tx.holding.update({ where: { id: lock.id }, data: { units: 0n } });
    await tx.holding.upsert({
      where: { marketId_address: { marketId: market.id, address: addr(a.owner) } },
      update: { units: { increment: units } },
      create: { marketId: market.id, address: addr(a.owner), units },
    });
    await tx.keyMarket.update({ where: { id: market.id }, data: { holders: await tx.holding.count({ where: { marketId: market.id, units: { gt: 0n } } }) } });
  }
  const F = makeFormat(c.ethUsd);
  c.out.notifications.push(
    await createNotification(tx, {
      userId: market.userId,
      type: 'points',
      body: [{ t: 'Your fan market is yours. ' }, { t: F.$(weiToEth(a.escrowReleased)), b: true }, { t: ' of escrowed creator fees is ready to claim.' }],
      link: '/wallet',
    }),
  );
  c.out.markets.add(market.id);
}

export async function onMarketHalted(c: ApplyContext, _m: LogMeta, a: { subject: string; halted: boolean }) {
  const market = await c.tx.keyMarket.findUnique({ where: { subject: addr(a.subject) } });
  if (!market) return;
  await c.tx.keyMarket.update({ where: { id: market.id }, data: { halted: a.halted } });
  c.out.markets.add(market.id);
}

export async function onClaimed(
  c: ApplyContext,
  m: LogMeta,
  a: { account: string; creator: bigint; holder: bigint; referral: bigint; protocol: bigint },
) {
  const { tx } = c;
  const dup = await tx.earningsClaim.findUnique({ where: { txHash_logIndex: { txHash: m.txHash, logIndex: m.logIndex } } });
  if (dup) return;
  await tx.earningsClaim.create({
    data: {
      address: addr(a.account), creatorWei: dec(a.creator), holderWei: dec(a.holder), referralWei: dec(a.referral), protocolWei: dec(a.protocol),
      txHash: m.txHash, logIndex: m.logIndex, blockNumber: m.blockNumber, ts: m.ts,
    },
  });
  const member = await memberByAddress(tx, a.account);
  if (member) {
    const ref = `claim:${m.txHash}:${m.logIndex}`;
    await tx.activity.upsert({
      where: { ref },
      update: {},
      create: { userId: member.id, ref, txHash: m.txHash, createdAt: m.ts, label: 'Claimed earnings', amountWei: dec(a.creator + a.holder + a.referral + a.protocol) },
    });
  }
}

export async function onReferrerSet(c: ApplyContext, m: LogMeta, a: { user: string; referrer: string }) {
  const member = await memberByAddress(c.tx, a.user);
  if (!member) return;
  await c.tx.referral.updateMany({ where: { inviteeId: member.id }, data: { onchainTx: m.txHash } });
}

export async function onStake(
  c: ApplyContext,
  _m: LogMeta,
  a: { account: string; delta: bigint; level?: number; unlockAt?: bigint },
) {
  const { tx } = c;
  const member = await memberByAddress(tx, a.account);
  if (!member) return;
  const s = await tx.stake.findUnique({ where: { userId: member.id } });
  const amount = (decToBig(s?.amountWei) + a.delta) < 0n ? 0n : decToBig(s?.amountWei) + a.delta;
  const data = {
    address: addr(a.account),
    amountWei: dec(amount),
    ...(a.level !== undefined ? { level: a.level } : {}),
    ...(a.unlockAt !== undefined ? { unlockAt: new Date(Number(a.unlockAt) * 1000) } : {}),
  };
  await tx.stake.upsert({ where: { userId: member.id }, update: data, create: { userId: member.id, ...data } });
  if (a.level !== undefined) await tx.user.update({ where: { id: member.id }, data: { stakingLevel: a.level } });
}

export async function onGenesisMint(c: ApplyContext, m: LogMeta, a: { to: string; tokenId: bigint }) {
  const snap = await c.tx.genesisSnapshot.findFirst({ orderBy: { takenAt: 'desc' } });
  if (!snap) return;
  await c.tx.genesisEntry.updateMany({ where: { snapshotId: snap.id, rank: Number(a.tokenId), wallet: addr(a.to) }, data: { mintTx: m.txHash } });
}

/** Sell value after fees of `units` held in a market at `supply`, never counting the locked first key. */
export function sellValueWei(supply: bigint, units: bigint, isOwner: boolean): bigint {
  const sellable = units - (isOwner ? LOCKED_UNITS : 0n);
  const max = supply - LOCKED_UNITS;
  const u = sellable > max ? max : sellable;
  if (u <= 0n) return 0n;
  return quoteWei(supply, 'sell', u).total;
}

export async function onCreatorInactiveSet(c: ApplyContext, m: LogMeta, a: { subject: string; inactive: boolean }) {
  const market = await c.tx.keyMarket.findUnique({ where: { subject: addr(a.subject) } });
  if (!market || market.creatorInactive === a.inactive) return;
  await c.tx.keyMarket.update({ where: { id: market.id }, data: { creatorInactive: a.inactive, creatorInactiveSince: a.inactive ? m.ts : null } });
  c.out.markets.add(market.id);
}
