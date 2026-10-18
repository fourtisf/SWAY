import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const URL = process.env.WORKERS_TEST_DATABASE_URL ?? 'postgresql://sway:sway@localhost:5432/sway_test_workers';

/**
 * Prepares the dedicated workers test database: creates it if missing, applies migrations
 * (non-destructive `migrate deploy`), then empties its tables (except migration-owned catalogue rows)
 * so each run starts clean.
 * Refuses any database whose name doesn't contain "test".
 */
export default async function setup() {
  const dbName = new globalThis.URL(URL).pathname.slice(1);
  if (!/test/i.test(dbName)) throw new Error(`refusing to reset non-test database "${dbName}"`);
  const admin = URL.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
  try {
    execSync(`psql "${admin}" -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'" | grep -q 1 || psql "${admin}" -c "CREATE DATABASE ${dbName}"`, { stdio: 'pipe', shell: '/bin/bash' });
  } catch {
    // createdb may race with another run; migrate deploy below reports real problems
  }
  execSync('node node_modules/prisma/build/index.js migrate deploy', {
    cwd: resolve(__dirname, '../../../packages/db'),
    env: { ...process.env, DATABASE_URL: URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = URL;
  const { PrismaClient } = await import('@sway/db');
  const p = new PrismaClient({ datasourceUrl: URL });
  const tables = await p.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'Task')`,
  );
  if (tables.length) await p.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  // Re-apply idempotent data migrations (catalogue rows) in case an earlier run removed them.
  const migrations = resolve(__dirname, '../../../packages/db/prisma/migrations');
  for (const dir of readdirSync(migrations).filter((d) => d.endsWith('_task_catalogue'))) {
    await p.$executeRawUnsafe(readFileSync(resolve(migrations, dir, 'migration.sql'), 'utf8'));
  }
  await p.$disconnect();
}
