import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    env: {
      DATABASE_URL: process.env.WORKERS_TEST_DATABASE_URL ?? 'postgresql://sway:sway@localhost:5432/sway_test_workers',
      NODE_ENV: 'test',
    },
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
