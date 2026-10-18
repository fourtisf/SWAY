import { defineConfig } from 'vitest/config';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://sway:sway@localhost:5432/sway_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // One shared Postgres database: run files one after another.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL, TEST_REDIS_URL, PRISMA_LOG: '0' },
  },
});
