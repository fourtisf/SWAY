/**
 * Creates the `sway_test` database if needed and applies the Prisma migrations to it
 * (prisma migrate deploy against DATABASE_URL=sway_test).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '@sway/db';
import { TEST_DATABASE_URL } from '../vitest.config';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPkg = path.resolve(here, '../../../packages/db');

export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name) || !name.includes('test'))
    throw new Error(`Refusing to use ${name} as the test database`);
  const admin = new URL(TEST_DATABASE_URL);
  admin.pathname = '/postgres';
  const p = new PrismaClient({ datasourceUrl: admin.toString() });
  try {
    const rows = await p.$queryRaw<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${name}`;
    if (!rows[0]?.n) await p.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await p.$disconnect();
  }
  execFileSync(
    process.execPath,
    [
      path.join(dbPkg, 'node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      path.join(dbPkg, 'prisma/schema.prisma'),
    ],
    {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: 'pipe',
    },
  );
}
