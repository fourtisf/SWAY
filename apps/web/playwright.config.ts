import { defineConfig, devices } from '@playwright/test';

/**
 * e2e runs against the web app in mock mode (NEXT_PUBLIC_API_MOCK=1): no API, chain or wallet needed.
 * Default: `next dev`. E2E_PROD=1 builds and serves a production bundle instead (into .next-e2e).
 * Chromium comes from PLAYWRIGHT_BROWSERS_PATH in the dev container (never run `playwright install` there);
 * CI installs it in the web-e2e job.
 */
const PORT = Number(process.env.E2E_PORT || 3100);
const prod = process.env.E2E_PROD === '1';

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    navigationTimeout: 120_000,
  },
  webServer: {
    command: prod ? `npx next build && npx next start -p ${PORT}` : `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 600_000,
    // NEXT_DIST_DIR from the environment lets parallel e2e runs use separate build folders.
    env: { NEXT_PUBLIC_API_MOCK: '1', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR || (prod ? '.next-e2e' : '.next-dev') },
  },
});
