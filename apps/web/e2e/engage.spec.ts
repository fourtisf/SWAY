import { expect, test, type Page } from '@playwright/test';

/**
 * [D] Watchlist alerts, the early-sell (anti-dump) fee in the trade sheet, the daily streak, referrals, ETH
 * airdrop claims and dark mode, in mock mode. Client-side navigation only after connecting (the mock world
 * lives in browser memory).
 */

test.beforeEach(async ({ page }) => {
  await page.route('**/api.dicebear.com/**', (r) => r.abort());
});

// `next dev` compiles routes on first visit; warm the ones used here before signing in.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  for (const path of ['/', '/novareyes', '/markets', '/watchlist', '/tasks', '/referrals', '/wallet', '/settings']) {
    await page.goto(path);
    await expect(page.locator('#main')).toBeVisible();
  }
  await page.close();
});

async function connect(page: Page, handle: string) {
  await page.goto('/');
  await page.locator('.sb').getByRole('button', { name: 'Connect X' }).click();
  await page.fill('#cx-h', handle);
  await page.locator('.modal').getByRole('button', { name: 'Authorize and continue' }).click();
  await expect(page.locator('.modal')).toContainText(`Scoring @${handle}`);
  await page.locator('.modal').getByRole('button', { name: 'Create a Sway wallet' }).click({ timeout: 20_000 });
  await expect(page.locator('.modal')).toContainText('Your Sway card is live', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Enter Sway' }).click();
  await expect(page.locator('.sb .me-chip')).toContainText(`@${handle}`);
}

const nav = (page: Page, label: string) => page.locator('.sb-nav').getByRole('link', { name: new RegExp('^' + label) }).click();

test('watch with an alert, early-sell fee, streak, referrals, airdrop claim and dark mode', async ({ page }) => {
  await connect(page, 'engager');
  await page.fill('#rs', 'nova');
  await page.locator('.sres .it', { hasText: 'Nova Reyes' }).click();
  await expect(page.locator('.p-name')).toContainText('Nova Reyes');

  // Star the key with a ±10% price alert.
  await page.locator('.p-acts .watch button').click();
  await page.locator('.watch-pop').getByRole('menuitemradio', { name: '±10%' }).click();
  await expect(page.locator('.toasts')).toContainText('Watching @novareyes: alert at ±10%');

  // Buy, then the sell side quotes the 5% early-sell fee for holders.
  await page.locator('.price-bar').getByRole('button', { name: 'Buy key' }).click();
  await page.locator('.modal').getByRole('button', { name: /^Buy 1 key for \$/ }).click();
  await expect(page.locator('.toasts')).toContainText('Bought 1 key of Nova Reyes');
  await page.locator('.price-bar').getByRole('button', { name: 'Sell' }).click();
  const sheet = page.locator('.modal');
  await expect(sheet.locator('#feeNote')).toContainText('less than 24 hours ago');
  await expect(sheet.locator('.fees-t')).toContainText('Includes 15% in fees');
  await page.keyboard.press('Escape');

  // Watchlist from the Markets header.
  await nav(page, 'Markets');
  await page.locator('#ch').getByRole('link', { name: 'Watchlist' }).click();
  await expect(page.locator('#watchlist')).toContainText('@novareyes · alert at ±10%');

  // Daily check-in, then the referral dashboard.
  await nav(page, 'Tasks');
  await page.locator('#streak').getByRole('button', { name: /Check in/ }).click();
  await expect(page.locator('.toasts')).toContainText('Day 1 streak · +100 points');
  await expect(page.locator('#streak')).toContainText('Checked in');
  await page.getByRole('link', { name: 'See who joined and what you earned' }).click();
  await expect(page.locator('.ref-hero')).toContainText('/i/engager');

  // A creator whose key you hold airdropped ETH: claim it from the wallet page.
  await nav(page, 'Wallet');
  await expect(page.locator('#drops')).toContainText('ETH airdrops to claim');
  await page.locator('#drops').getByRole('button', { name: 'Claim' }).click();
  await expect(page.locator('.toasts')).toContainText('Claimed airdrop from @novareyes');
  await expect(page.locator('#drops')).toHaveCount(0);

  // Dark mode sticks across pages.
  await nav(page, 'Settings');
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await nav(page, 'Home');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
});
