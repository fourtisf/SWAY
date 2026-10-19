/**
 * Workers health and metrics on WORKERS_HEALTH_PORT (default 4100), for uptime checks and alerting:
 *   GET /healthz  200 when DB, Redis and the RPC answer and the indexer is within INDEXER_MAX_LAG blocks,
 *                 503 otherwise; JSON body with the details.
 *   GET /metrics  Prometheus text: indexer head/lag, job last success and failure counts.
 */
import { createServer, type Server } from 'node:http';
import type { Clients } from './clients';
import { CURSOR } from './indexer/indexer';

interface JobStat {
  lastSuccess: number | null;
  lastFailure: number | null;
  failures: number;
  lastError: string | null;
}

const jobs = new Map<string, JobStat>();
const stat = (name: string): JobStat => {
  let s = jobs.get(name);
  if (!s) jobs.set(name, (s = { lastSuccess: null, lastFailure: null, failures: 0, lastError: null }));
  return s;
};

export const recordJob = {
  ok(name: string) {
    stat(name).lastSuccess = Date.now();
  },
  failed(name: string, err: unknown) {
    const s = stat(name);
    s.lastFailure = Date.now();
    s.failures++;
    s.lastError = err instanceof Error ? err.message.slice(0, 300) : String(err);
  },
};

async function snapshot(c: Clients) {
  const out = { db: false, redis: false, rpc: false, head: null as number | null, indexed: null as number | null, lag: null as number | null };
  await Promise.all([
    c.prisma.$queryRaw`SELECT 1`.then(() => (out.db = true)).catch(() => undefined),
    c.redis.ping().then(() => (out.redis = true)).catch(() => undefined),
    c.pub.getBlockNumber({ cacheTime: 0 }).then((n) => {
      out.rpc = true;
      out.head = Number(n);
    }).catch(() => undefined),
  ]);
  if (out.db) {
    const cur = await c.prisma.indexerCursor.findUnique({ where: { name: CURSOR } }).catch(() => null);
    out.indexed = cur ? Number(cur.blockNumber) : null;
  }
  if (out.head !== null && out.indexed !== null) out.lag = Math.max(0, out.head - out.indexed);
  return out;
}

export function startHealthServer(c: Clients, port = Number(process.env.WORKERS_HEALTH_PORT || 4100)): Server | null {
  if (!port) return null;
  const maxLag = Number(process.env.INDEXER_MAX_LAG || 60);
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/healthz') {
        const s = await snapshot(c);
        const indexerOk = !c.cfg.contracts.swayKeys || (s.lag !== null && s.lag <= maxLag);
        const ok = s.db && s.redis && s.rpc && indexerOk;
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok, ...s, maxLag, jobs: Object.fromEntries(jobs) }));
        return;
      }
      if (req.url === '/metrics') {
        const s = await snapshot(c);
        const lines = [
          '# HELP sway_up Whether DB, Redis and RPC answer (1/0).',
          '# TYPE sway_up gauge',
          `sway_up{dep="db"} ${s.db ? 1 : 0}`,
          `sway_up{dep="redis"} ${s.redis ? 1 : 0}`,
          `sway_up{dep="rpc"} ${s.rpc ? 1 : 0}`,
          '# HELP sway_indexer_lag_blocks Chain head minus the last indexed block.',
          '# TYPE sway_indexer_lag_blocks gauge',
          `sway_indexer_lag_blocks ${s.lag ?? -1}`,
          '# HELP sway_indexer_block Last indexed block.',
          '# TYPE sway_indexer_block gauge',
          `sway_indexer_block ${s.indexed ?? -1}`,
          '# HELP sway_job_last_success_seconds Unix time of each scheduled job\'s last success.',
          '# TYPE sway_job_last_success_seconds gauge',
          ...[...jobs].map(([n, j]) => `sway_job_last_success_seconds{job="${n}"} ${j.lastSuccess ? Math.floor(j.lastSuccess / 1000) : 0}`),
          '# HELP sway_job_failures_total Failed runs per job since start.',
          '# TYPE sway_job_failures_total counter',
          ...[...jobs].map(([n, j]) => `sway_job_failures_total{job="${n}"} ${j.failures}`),
        ];
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(lines.join('\n') + '\n');
        return;
      }
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
  });
  server.on('error', (e) => console.warn(`[health] ${(e as Error).message}`));
  server.listen(port, '0.0.0.0', () => console.log(`[health] /healthz and /metrics on :${port}`));
  return server;
}
