import { expect, test, type Page } from '@playwright/test';

/**
 * Screenshots for design review (mock mode). Skipped unless VISUAL=1; run with `pnpm e2e:visual`.
 * Output: e2e/screenshots/*.png. Compare against docs/sway-prototype.html at the same widths.
 */
test.skip(!process.env.VISUAL, 'set VISUAL=1 to capture screenshots');

const OUT = 'e2e/screenshots';

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api.dicebear.com/**', (r) => r.abort());
  await page.goto('/');
  await expect(page.locator('.post').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const go = (page: Page, path: string) => page.evaluate((p) => (window as unknown as { __router: { push(p: string): void } }).__router.push(p), path);

test('desktop home, profile and trade sheet', async ({ page }) => {
  await open(page, 1440);
  await page.screenshot({ path: `${OUT}/desktop-home-1440.png` });
  await go(page, '/novareyes');
  await expect(page.locator('.p-name')).toContainText('Nova Reyes');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/desktop-profile-1440.png` });
  await page.locator('.price-bar').getByRole('button', { name: 'Buy key' }).click();
  await expect(page.locator('.modal .trade')).toBeVisible();
  await page.screenshot({ path: `${OUT}/desktop-trade-sheet-1440.png` });
});

test('tablet widths', async ({ page }) => {
  for (const w of [1200, 1000]) {
    await open(page, w);
    await page.screenshot({ path: `${OUT}/home-${w}.png` });
  }
});

test('mobile home, trade sheet and connect', async ({ page }) => {
  await open(page, 390);
  await page.screenshot({ path: `${OUT}/mobile-home-390.png` });
  await page.locator('.post .kchip').first().click();
  await expect(page.locator('.modal .trade')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/mobile-trade-sheet-390.png` });
  await page.locator('.modal').getByRole('button', { name: 'Close' }).click();
  await page.locator('.mtop').getByRole('button', { name: 'Connect' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/mobile-connect-390.png` });
});

test('signed-in desktop home and wallet', async ({ page }) => {
  await open(page, 1440);
  await page.locator('.sb').getByRole('button', { name: 'Connect X' }).click();
  await page.fill('#cx-h', 'demo');
  await page.locator('.modal').getByRole('button', { name: 'Authorize and continue' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Create a Sway wallet' }).click({ timeout: 20_000 });
  await expect(page.locator('.modal')).toContainText('Your Sway card is live', { timeout: 20_000 });
  await page.screenshot({ path: `${OUT}/desktop-card-live-1440.png` });
  await page.getByRole('button', { name: 'Enter Sway' }).click();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${OUT}/desktop-home-signed-in-1440.png` });
  await go(page, '/wallet');
  await expect(page.locator('.bal')).toBeVisible();
  await page.screenshot({ path: `${OUT}/desktop-wallet-1440.png` });
});
