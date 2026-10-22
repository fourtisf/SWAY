/**
 * Replays SwayLaunchpad's events into the mirror, for launches and trades it missed (say the workers ran without
 * LAUNCHPAD_ADDRESS, or the indexer moved past them). Every handler skips what the mirror already has, and the
 * curves are re-read from the chain at the end, so running it twice changes nothing.
 *
 *   pnpm --filter @sway/workers backfill:launchpad [fromBlock]
 *
 * fromBlock defaults to the launchpad's deploy block (contracts/broadcast/DeployLaunchpad.s.sol/<chain>/run-latest.json);
 * it replays up to the indexer's cursor, where the live indexer carries on.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseEventLogs, type Log } from 'viem';
import { addr } from '@sway/db';
import { swayLaunchpadAbi } from '@sway/shared/abi';
import { makeClients } from '../clients';
import { loadConfig } from '../config';
import type { ApplyContext, LogMeta } from '../indexer/apply';
import { CURSOR } from '../indexer/indexer';
import { onAirdropClaimed, onCreatorFeesClaimed, onGraduated, onLaunched, onLaunchTraded, resyncLaunches } from '../indexer/launchpad';

const cfg = loadConfig();
const c = makeClients(cfg);
const pad = cfg.contracts.launchpad;
if (!pad) throw new Error('LAUNCHPAD_ADDRESS is not set');

function deployBlock(): bigint | null {
  const f = new URL(`../../../../contracts/broadcast/DeployLaunchpad.s.sol/${cfg.chainId}/run-latest.json`, import.meta.url);
  if (!existsSync(f)) return null;
  const run = JSON.parse(readFileSync(f, 'utf8')) as { receipts?: Array<{ contractAddress?: string | null; blockNumber: string }> };
  const r = run.receipts?.find((x) => x.contractAddress?.toLowerCase() === pad!.toLowerCase());
  return r ? BigInt(r.blockNumber) : null;
}

const from = process.argv[2] ? BigInt(process.argv[2]) : deployBlock();
if (from === null) throw new Error('No deployment record for the launchpad: pass its deploy block, backfill:launchpad <fromBlock>');
const cursor = await c.prisma.indexerCursor.findUnique({ where: { name: CURSOR } });
const to = cursor?.blockNumber ?? (await c.pub.getBlockNumber());
if (from > to) {
  console.log(`The indexer is at block ${to}, before the launchpad (block ${from}): it will index those events itself.`);
  console.log('If it is far behind, check INDEXER_START_BLOCK in .env (bash scripts/apply-deployment.sh fixes it) and restart the workers.');
  process.exit(0);
}
console.log(`replaying launchpad ${pad} events, blocks ${from}-${to}`);

let span = BigInt(cfg.indexer.batchBlocks);
let replayed = 0;
for (let start = from; start <= to; ) {
  const end = start + span - 1n < to ? start + span - 1n : to;
  let raw: Log[];
  try {
    raw = await c.pub.getLogs({ address: pad, fromBlock: start, toBlock: end });
  } catch (e) {
    // Public RPCs cap the range of getLogs: halve it and retry.
    if (span <= 10n) throw e;
    span /= 2n;
    continue;
  }
  const events = parseEventLogs({ abi: swayLaunchpadAbi, logs: raw });
  if (events.length) {
    const ts = new Map<bigint, Date>();
    for (const e of events)
      if (!ts.has(e.blockNumber!)) ts.set(e.blockNumber!, new Date(Number((await c.pub.getBlock({ blockNumber: e.blockNumber! })).timestamp) * 1000));
    const ethUsd = await c.ethUsd();
    await c.prisma.$transaction(
      async (tx) => {
        const ctx: ApplyContext = { tx, ethUsd, fanEscrow: cfg.contracts.fanEscrow ? addr(cfg.contracts.fanEscrow) : null, out: { trades: [], markets: new Set(), notifications: [] } };
        for (const e of events) {
          const m: LogMeta = { txHash: e.transactionHash!, logIndex: e.logIndex!, blockNumber: e.blockNumber!, blockHash: e.blockHash!, ts: ts.get(e.blockNumber!)! };
          if (e.eventName === 'Launched') await onLaunched(ctx, m, e.args);
          else if (e.eventName === 'Traded') await onLaunchTraded(ctx, m, e.args);
          else if (e.eventName === 'Graduated') await onGraduated(ctx, m, e.args);
          else if (e.eventName === 'AirdropClaimed') await onAirdropClaimed(ctx, m, e.args);
          else if (e.eventName === 'CreatorFeesClaimed') await onCreatorFeesClaimed(ctx, m, e.args);
        }
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    replayed += events.length;
    console.log(`  blocks ${start}-${end}: ${events.length} events`);
  }
  start = end + 1n;
}
// Older trades replayed after newer ones leave older reserves behind: take the curves from the chain.
await resyncLaunches(c);
console.log(`done: ${replayed} launchpad events replayed up to block ${to}`);
await c.redis.quit();
await c.prisma.$disconnect();
