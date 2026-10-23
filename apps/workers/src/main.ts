/**
 * Sway workers process:
 * - indexer: chain → Postgres mirror (one active instance, guarded by a Redis lock)
 * - x-jobs queue: verify-task / refresh-score jobs enqueued by the API
 * - schedules (BullMQ job schedulers, so several processes never double-run them): ETH/USD price,
 *   points recount, referrals, battles, weekly prizes, score sweep, trusted-task re-checks, Genesis, bot flags,
 *   the activity bond, watchlist price alerts and web push delivery
 */
import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { loadConfig } from './config';
import { makeClients } from './clients';
import { Indexer } from './indexer/indexer';
import { refreshPrice } from './jobs/price';
import { recountPoints } from './jobs/points';
import { creditReferrals } from './jobs/referrals';
import { payWeeklyPrizes, refreshLiveBattles, simulatedBattleReader, tickBattles, xBattleReader } from './jobs/battles';
import { flagBots } from './jobs/bots';
import { enforceActivityBond } from './jobs/activity-bond';
import { checkPriceAlerts } from './jobs/alerts';
import { deliverPushes } from './jobs/push';
import { recordJob, startHealthServer } from './health';
import { genesisTick } from './jobs/genesis';
import { X_QUEUE, recheckTrusted, refreshScore, reopenStalePending, reopenTask, runVerifyTask, sweepScores, type VerifyTaskJob } from './jobs/xjobs';

const CRON_QUEUE = 'sway-cron';
const LOCK_KEY = 'lock:indexer';
const LOCK_MS = 30_000;

async function main() {
  const cfg = loadConfig();
  const c = makeClients(cfg);
  const connection = c.redis;
  const battleReader = xBattleReader(c) ?? simulatedBattleReader;
  if (battleReader.kind === 'simulated') console.warn('[battles] X_BEARER_TOKEN not set: battles settle with simulated engagement (dev only)');

  // ---- scheduled jobs
  const cron = new Queue(CRON_QUEUE, { connection });
  const every = (ms: number) => ({ every: ms });
  await cron.upsertJobScheduler('price', every(30_000));
  await cron.upsertJobScheduler('points', every(60_000));
  await cron.upsertJobScheduler('referrals', every(5 * 60_000));
  await cron.upsertJobScheduler('battles', every(60_000));
  await cron.upsertJobScheduler('weekly-prizes', { pattern: '0 0 * * 1', tz: 'UTC' });
  await cron.upsertJobScheduler('scores', every(15 * 60_000));
  await cron.upsertJobScheduler('trusted-recheck', every(30 * 60_000));
  await cron.upsertJobScheduler('stale-tasks', every(10 * 60_000));
  await cron.upsertJobScheduler('genesis', every(60_000));
  await cron.upsertJobScheduler('live-battles', every(10 * 60_000));
  await cron.upsertJobScheduler('bot-flags', every(10 * 60_000));
  await cron.upsertJobScheduler('activity-bond', every(5 * 60_000));
  await cron.upsertJobScheduler('price-alerts', every(60_000));
  await cron.upsertJobScheduler('push', every(10_000));

  const handlers: Record<string, () => Promise<unknown>> = {
    price: () => refreshPrice(c),
    points: () => recountPoints(c),
    referrals: () => creditReferrals(c),
    battles: () => tickBattles(c, battleReader),
    'weekly-prizes': () => payWeeklyPrizes(c),
    scores: () => sweepScores(c),
    'trusted-recheck': () => recheckTrusted(c),
    'stale-tasks': () => reopenStalePending(c),
    genesis: () => genesisTick(c),
    'live-battles': () => refreshLiveBattles(c, battleReader),
    'bot-flags': () => flagBots(c),
    'activity-bond': () => enforceActivityBond(c),
    'price-alerts': () => checkPriceAlerts(c),
    push: () => deliverPushes(c),
  };
  const cronWorker = new Worker(
    CRON_QUEUE,
    async (job: Job) => {
      const h = handlers[job.name];
      if (!h) throw new Error(`unknown scheduled job ${job.name}`);
      return h();
    },
    { connection, concurrency: 4 },
  );
  cronWorker.on('completed', (job) => recordJob.ok(job.name));
  cronWorker.on('failed', (job, err) => {
    if (job) recordJob.failed(job.name, err);
    console.error(`[cron] ${job?.name} failed:`, err.message);
  });

  // ---- X jobs from the API
  const xWorker = new Worker(
    X_QUEUE,
    async (job: Job) => {
      if (job.name === 'verify-task') return runVerifyTask(c, job.data as VerifyTaskJob);
      if (job.name === 'refresh-score') return refreshScore(c, (job.data as { userId: string }).userId);
      throw new Error(`unknown x job ${job.name}`);
    },
    { connection, concurrency: 2, limiter: { max: 10, duration: 1000 } },
  );
  xWorker.on('failed', (job, err) => {
    console.warn(`[x-jobs] ${job?.name} ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
    // Out of retries: give the task back instead of leaving it 'pending' for good.
    if (job?.name === 'verify-task' && job.attemptsMade >= (job.opts.attempts ?? 1))
      reopenTask(c, job.data as VerifyTaskJob, 'unavailable').catch((e) => console.error('[x-jobs] reopen failed', e));
  });

  // ---- indexer, single active instance
  const indexer = new Indexer(c);
  const me = randomUUID();
  let leading = false;
  const lockLoop = setInterval(async () => {
    try {
      if (leading) {
        if ((await c.redis.get(LOCK_KEY)) === me) await c.redis.pexpire(LOCK_KEY, LOCK_MS);
        else leading = false;
      } else if (await c.redis.set(LOCK_KEY, me, 'PX', LOCK_MS, 'NX')) {
        leading = true;
        indexer.run().catch((e) => console.error('[indexer] stopped', e));
      }
    } catch (e) {
      console.error('[indexer] lock error', e);
    }
  }, 5_000);
  if (await c.redis.set(LOCK_KEY, me, 'PX', LOCK_MS, 'NX')) {
    leading = true;
    indexer.run().catch((e) => console.error('[indexer] stopped', e));
  } else console.log('[indexer] another instance holds the lock; standing by');

  await refreshPrice(c);
  const health = startHealthServer(c);
  console.log(`[workers] up on chain ${cfg.chainId}`);

  const shutdown = async () => {
    console.log('[workers] shutting down');
    clearInterval(lockLoop);
    indexer.stop();
    health?.close();
    if (leading && (await c.redis.get(LOCK_KEY)) === me) await c.redis.del(LOCK_KEY);
    await Promise.allSettled([cronWorker.close(), xWorker.close(), cron.close()]);
    await c.prisma.$disconnect();
    c.redis.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
