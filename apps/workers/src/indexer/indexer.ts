/**
 * Chain → Postgres mirror. Polls confirmed blocks, decodes SwayKeys / SwayStaking / GenesisPass events,
 * applies them in one transaction per batch, then publishes bus events. Reorg-safe: the cursor stores
 * the last block hash; on mismatch it walks back through IndexedBlock to the common ancestor, deletes
 * mirrored rows above it, rebuilds affected markets from their remaining trades and writes compensating
 * (append-only) points entries.
 */
import { parseEventLogs, type Log } from 'viem';
import { genesisPassAbi, swayKeysAbi, swayLaunchpadAbi, swayStakingAbi } from '@sway/shared/abi';
import { addr } from '@sway/db';
import type { Clients } from '../clients';
import { publishNotifications } from '../notify';
import {
  onClaimed,
  onCreatorInactiveSet,
  onFanMarketClaimed,
  onGenesisMint,
  onMarketHalted,
  onMarketOpened,
  onReferrerSet,
  onStake,
  onTrade,
  type ApplyContext,
  type LogMeta,
} from './apply';
import { rebuildMarket } from './rebuild';
import { onAirdropClaimed, onCreatorFeesClaimed, onGraduated, onLaunched, onLaunchTraded, resyncLaunches } from './launchpad';

export const CURSOR = 'sway';
const KEEP_BLOCKS = 2_000n;

export interface TickResult {
  from: bigint;
  to: bigint;
  logs: number;
  reorgedTo?: bigint;
}

export class Indexer {
  private stopped = false;

  constructor(private readonly c: Clients) {}

  private get addresses(): `0x${string}`[] {
    const { swayKeys, swayStaking, genesisPass, launchpad } = this.c.cfg.contracts;
    return [swayKeys, swayStaking, genesisPass, launchpad].filter(Boolean) as `0x${string}`[];
  }

  async run(): Promise<void> {
    if (!this.c.cfg.contracts.swayKeys) {
      console.warn('[indexer] SWAY_KEYS_ADDRESS not set; indexer idle');
      return;
    }
    console.log(`[indexer] watching ${this.addresses.join(', ')} on chain ${this.c.cfg.chainId}`);
    while (!this.stopped) {
      try {
        const r = await this.tick();
        if (r && r.to - r.from >= BigInt(this.c.cfg.indexer.batchBlocks) - 1n) continue; // catching up
      } catch (e) {
        console.error('[indexer] tick failed', e);
      }
      await new Promise((res) => setTimeout(res, this.c.cfg.indexer.pollMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** Processes the next batch of confirmed blocks. Returns null when there is nothing new. */
  async tick(): Promise<TickResult | null> {
    const { prisma, pub, cfg } = this.c;
    const head = await pub.getBlockNumber({ cacheTime: 0 });
    const safe = head - BigInt(cfg.indexer.confirmations);
    let cursor = await prisma.indexerCursor.findUnique({ where: { name: CURSOR } });

    let reorgedTo: bigint | undefined;
    if (cursor) {
      const onChain = cursor.blockNumber <= head ? await pub.getBlock({ blockNumber: cursor.blockNumber }).catch(() => null) : null;
      if (!onChain || onChain.hash !== cursor.blockHash) {
        reorgedTo = await this.rollback(cursor.blockNumber);
        cursor = await prisma.indexerCursor.findUnique({ where: { name: CURSOR } });
      }
    }

    const from = cursor ? cursor.blockNumber + 1n : cfg.indexer.startBlock;
    if (from > safe) return reorgedTo !== undefined ? { from, to: from - 1n, logs: 0, reorgedTo } : null;
    const to = safe < from + BigInt(cfg.indexer.batchBlocks) - 1n ? safe : from + BigInt(cfg.indexer.batchBlocks) - 1n;

    const raw = await pub.getLogs({ address: this.addresses, fromBlock: from, toBlock: to });
    const blockNumbers = new Set<bigint>([to, ...raw.map((l) => l.blockNumber!)]);
    const blocks = new Map<bigint, { hash: string; parentHash: string; ts: Date }>();
    for (const n of blockNumbers) {
      const b = await pub.getBlock({ blockNumber: n });
      blocks.set(n, { hash: b.hash!, parentHash: b.parentHash, ts: new Date(Number(b.timestamp) * 1000) });
    }
    for (const l of raw) {
      if (blocks.get(l.blockNumber!)!.hash !== l.blockHash) throw new Error(`block ${l.blockNumber} changed while indexing; retrying`);
    }

    const events = this.decode(raw);
    const ethUsd = await this.c.ethUsd();
    const out: ApplyContext['out'] = { trades: [], markets: new Set(), notifications: [] };
    await prisma.$transaction(
      async (tx) => {
        const ctx: ApplyContext = { tx, ethUsd, fanEscrow: cfg.contracts.fanEscrow ? addr(cfg.contracts.fanEscrow) : null, out };
        for (const e of events) {
          const b = blocks.get(e.log.blockNumber!)!;
          await this.apply(ctx, e, { txHash: e.log.transactionHash!, logIndex: e.log.logIndex!, blockNumber: e.log.blockNumber!, blockHash: b.hash, ts: b.ts });
        }
        for (const [number, b] of blocks) {
          await tx.indexedBlock.upsert({ where: { number }, update: { hash: b.hash, parentHash: b.parentHash }, create: { number, hash: b.hash, parentHash: b.parentHash } });
        }
        const end = blocks.get(to)!;
        await tx.indexerCursor.upsert({ where: { name: CURSOR }, update: { blockNumber: to, blockHash: end.hash }, create: { name: CURSOR, blockNumber: to, blockHash: end.hash } });
        await tx.indexedBlock.deleteMany({ where: { number: { lt: to - KEEP_BLOCKS } } });
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    for (const tradeId of out.trades) await this.c.publish({ kind: 'trade', tradeId });
    for (const marketId of out.markets) await this.c.publish({ kind: 'market', marketId });
    await publishNotifications(this.c, out.notifications);
    if (events.length) console.log(`[indexer] blocks ${from}-${to}: ${events.length} events`);
    return { from, to, logs: events.length, reorgedTo };
  }

  private decode(raw: Log[]) {
    const { swayKeys, swayStaking, genesisPass, launchpad } = this.c.cfg.contracts;
    const pick = (a: string | null) => raw.filter((l) => a && l.address.toLowerCase() === a.toLowerCase());
    const all = [
      ...parseEventLogs({ abi: swayKeysAbi, logs: pick(swayKeys) }).map((e) => ({ src: 'keys' as const, e, log: e as Log })),
      ...parseEventLogs({ abi: swayStakingAbi, logs: pick(swayStaking) }).map((e) => ({ src: 'staking' as const, e, log: e as Log })),
      ...parseEventLogs({ abi: genesisPassAbi, logs: pick(genesisPass) }).map((e) => ({ src: 'genesis' as const, e, log: e as Log })),
      ...parseEventLogs({ abi: swayLaunchpadAbi, logs: pick(launchpad) }).map((e) => ({ src: 'launchpad' as const, e, log: e as Log })),
    ];
    return all.sort((x, y) => (x.log.blockNumber === y.log.blockNumber ? x.log.logIndex! - y.log.logIndex! : x.log.blockNumber! < y.log.blockNumber! ? -1 : 1));
  }

  private async apply(ctx: ApplyContext, ev: ReturnType<Indexer['decode']>[number], m: LogMeta): Promise<void> {
    if (ev.src === 'keys') {
      const e = ev.e as ReturnType<typeof parseEventLogs<typeof swayKeysAbi>>[number];
      switch (e.eventName) {
        case 'MarketOpened':
          return onMarketOpened(ctx, m, e.args);
        case 'Trade':
          return onTrade(ctx, m, e.args);
        case 'FanMarketClaimed':
          return onFanMarketClaimed(ctx, m, e.args);
        case 'MarketHalted':
          return onMarketHalted(ctx, m, e.args);
        case 'CreatorInactiveSet':
          return onCreatorInactiveSet(ctx, m, e.args);
        case 'Claimed':
          return onClaimed(ctx, m, e.args);
        case 'ReferrerSet':
          return onReferrerSet(ctx, m, e.args);
        default:
          return;
      }
    }
    if (ev.src === 'staking') {
      const e = ev.e as ReturnType<typeof parseEventLogs<typeof swayStakingAbi>>[number];
      switch (e.eventName) {
        case 'Staked':
          return onStake(ctx, m, { account: e.args.account, delta: e.args.amount, level: e.args.level });
        case 'UnstakeRequested':
          return onStake(ctx, m, { account: e.args.account, delta: -e.args.amount, level: e.args.level, unlockAt: e.args.unlockAt });
        default:
          return;
      }
    }
    if (ev.src === 'launchpad') {
      const e = ev.e as ReturnType<typeof parseEventLogs<typeof swayLaunchpadAbi>>[number];
      switch (e.eventName) {
        case 'Launched':
          return onLaunched(ctx, m, e.args);
        case 'Traded':
          return onLaunchTraded(ctx, m, e.args);
        case 'Graduated':
          return onGraduated(ctx, m, e.args);
        case 'AirdropClaimed':
          return onAirdropClaimed(ctx, m, e.args);
        case 'CreatorFeesClaimed':
          return onCreatorFeesClaimed(ctx, m, e.args);
        default:
          return;
      }
    }
    const e = ev.e as ReturnType<typeof parseEventLogs<typeof genesisPassAbi>>[number];
    if (e.eventName === 'Transfer' && /^0x0{40}$/i.test(e.args.from)) return onGenesisMint(ctx, m, { to: e.args.to, tokenId: e.args.tokenId });
  }

  /** Finds the common ancestor at or below `fromBlock`, undoes everything above it and moves the cursor. */
  async rollback(fromBlock: bigint): Promise<bigint> {
    const { prisma, pub, cfg } = this.c;
    const known = await prisma.indexedBlock.findMany({ where: { number: { lte: fromBlock } }, orderBy: { number: 'desc' }, take: 500 });
    let ancestor: { number: bigint; hash: string } | null = null;
    for (const b of known) {
      const onChain = await pub.getBlock({ blockNumber: b.number }).catch(() => null);
      if (onChain?.hash === b.hash) {
        ancestor = b;
        break;
      }
    }
    const to = ancestor?.number ?? cfg.indexer.startBlock - 1n;
    console.warn(`[indexer] reorg detected at ${fromBlock}; rolling back to ${to}`);
    const fanEscrow = cfg.contracts.fanEscrow ? addr(cfg.contracts.fanEscrow) : null;
    await prisma.$transaction(
      async (tx) => {
        const dropped = await tx.trade.findMany({ where: { blockNumber: { gt: to } }, select: { txHash: true, logIndex: true, marketId: true } });
        const affected = new Set(dropped.map((d) => d.marketId));
        for (const d of dropped) {
          const ref = `trade:${d.txHash}:${d.logIndex}`;
          const entries = await tx.pointsLedger.findMany({ where: { ref, kind: 'trade_volume' } });
          for (const p of entries) {
            await tx.pointsLedger.upsert({
              where: { userId_kind_ref: { userId: p.userId, kind: 'reorg_correction', ref: `reorg:${ref}` } },
              update: {},
              create: { userId: p.userId, kind: 'reorg_correction', amount: -p.amount, ref: `reorg:${ref}` },
            });
          }
          await tx.activity.deleteMany({ where: { ref } });
        }
        await tx.trade.deleteMany({ where: { blockNumber: { gt: to } } });
        const claims = await tx.earningsClaim.findMany({ where: { blockNumber: { gt: to } } });
        for (const cl of claims) await tx.activity.deleteMany({ where: { ref: `claim:${cl.txHash}:${cl.logIndex}` } });
        await tx.earningsClaim.deleteMany({ where: { blockNumber: { gt: to } } });
        const reclaimed = await tx.keyMarket.findMany({ where: { claimBlock: { gt: to } } });
        for (const mk of reclaimed) {
          await tx.keyMarket.update({ where: { id: mk.id }, data: { claimed: false, claimBlock: null } });
          affected.add(mk.id);
        }
        const reopened = await tx.keyMarket.findMany({ where: { openBlock: { gt: to } } });
        for (const mk of reopened) {
          await tx.keyMarket.update({ where: { id: mk.id }, data: { opened: false, openTx: null, openBlock: null, openedAt: null } });
          affected.add(mk.id);
        }
        for (const id of affected) await rebuildMarket(tx, id, fanEscrow);
        await tx.indexedBlock.deleteMany({ where: { number: { gt: to } } });
        const anc = await tx.indexedBlock.findUnique({ where: { number: to } });
        if (anc) await tx.indexerCursor.update({ where: { name: CURSOR }, data: { blockNumber: to, blockHash: anc.hash } });
        else await tx.indexerCursor.delete({ where: { name: CURSOR } }).catch(() => undefined);
      },
      { timeout: 120_000 },
    );
    await resyncLaunches(this.c).catch((e) => console.error('[indexer] launch resync after reorg failed', e));
    return to;
  }
}
