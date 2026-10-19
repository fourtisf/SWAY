import { expect, test, type Page } from '@playwright/test';

/**
 * Mock-mode walkthrough (NEXT_PUBLIC_API_MOCK=1). The mock world lives in browser memory, so after
 * connecting we only navigate client-side (clicks), never page.goto.
 */

test.beforeEach(async ({ page }) => {
  // Avatars fall back to initials; keep tests independent of api.dicebear.com.
  await page.route('**/api.dicebear.com/**', (r) => r.abort());
});

const GUEST_ROUTES: Array<[string, string | RegExp]> = [
  ['/', 'You’re browsing as a guest.'],
  ['/explore', 'Creators, tags and keys'],
  ['/markets', 'Every key market in one place'],
  ['/notifications', 'Connect X to get notified'],
  ['/messages', 'Connect X to message'],
  ['/messages/room-novareyes', 'Connect X to message'],
  ['/tasks', 'Connect X to start earning'],
  ['/wallet', 'Connect X to open your wallet'],
  ['/leaderboard', 'Fighters'],
  ['/battles', 'Engagement rate wins, not follower count.'],
  ['/launchpad', 'Turn your reach into a token with one switch.'],
  ['/genesis', 'Minted once to the top 500. Never sold.'],
  ['/model', 'Every account is scored by the same published function.'],
  ['/novareyes', 'Onchain sleuth.'],
  ['/orbitlabs', 'Unclaimed fan market'],
];

test('guest can visit every route', async ({ page }) => {
  for (const [path, text] of GUEST_ROUTES) {
    await page.goto(path);
    await expect(page.locator('.col')).toContainText(text);
  }
  // Static routes win over the profile route; a handle that doesn't exist shows an empty state.
  await page.goto('/nobody_here_123');
  await expect(page.locator('#main')).toContainText('This account doesn’t exist');
  // Fan market claim modal with the escrow copy.
  await page.goto('/orbitlabs');
  await page.getByRole('button', { name: 'This is my account' }).click();
  await expect(page.locator('.modal')).toContainText('of escrowed creator fees become yours');
  await page.keyboard.press('Escape');
  // Trade sheet as a guest asks to connect.
  await page.locator('.price-bar').getByRole('button', { name: 'Buy key' }).click();
  await expect(page.locator('.modal')).toContainText('Connect X to trade');
});

async function connect(page: Page, handle: string) {
  await page.goto('/');
  await page.locator('.sb').getByRole('button', { name: 'Connect X' }).click();
  await page.fill('#cx-h', handle);
  await page.locator('.modal').getByRole('button', { name: 'Authorize and continue' }).click();
  await expect(page.locator('.modal')).toContainText(`Scoring @${handle}`);
  // Step 4: the account wallet, made here or connected.
  await page.locator('.modal').getByRole('button', { name: 'Create a Sway wallet' }).click({ timeout: 20_000 });
  await expect(page.locator('.modal')).toContainText('Your Sway card is live', { timeout: 20_000 });
  await expect(page.locator('.modal .ic')).toContainText('Sway score');
  await page.getByRole('button', { name: 'Enter Sway' }).click();
  await expect(page.locator('.sb .me-chip')).toContainText(`@${handle}`);
}

async function nav(page: Page, label: string) {
  await page.locator('.sb-nav').getByRole('link', { name: new RegExp('^' + label) }).click();
}

test('connect, trade, room, post, task, claim', async ({ page }) => {
  await connect(page, 'e2etester');

  // Find Nova Reyes through the rail search and open the profile.
  await page.fill('#rs', 'nova');
  await page.locator('.sres .it', { hasText: 'Nova Reyes' }).click();
  await expect(page.locator('.p-name')).toContainText('Nova Reyes');

  // Room is locked until we hold a key.
  await page.locator('.ptabs').getByRole('tab', { name: 'Room' }).click();
  await expect(page.locator('#main')).toContainText('Hold 1 key to enter');

  // Buy 1 key from the trade sheet.
  await page.locator('.price-bar').getByRole('button', { name: 'Buy key' }).click();
  const sheet = page.locator('.modal');
  await expect(sheet.locator('.sum-r.tot')).toContainText('You pay');
  await sheet.locator('.fees-t').click();
  await expect(sheet.locator('.fees')).toContainText('Creator 6%');
  await sheet.getByRole('button', { name: /^Buy 1 key for \$/ }).click();
  await expect(page.locator('.toasts')).toContainText('Bought 1 key of Nova Reyes');
  await expect(page.locator('.modal')).toHaveCount(0);

  // The room unlocks: chat is open and we can talk.
  await expect(page.getByPlaceholder('Message holders of @novareyes')).toBeVisible();
  await page.getByPlaceholder('Message holders of @novareyes').fill('gm holders');
  await page.keyboard.press('Enter');
  await expect(page.locator('.room-msgs .msg.mine')).toContainText('gm holders');
  await expect(page.locator('.p-meta')).toContainText('keys held by you');

  // Post something from the home composer.
  await nav(page, 'Home');
  await page.fill('#compose', 'Hello from the e2e suite #SwayDaily');
  await expect(page.locator('#cnt')).toHaveText('35/500');
  await page.locator('#postBtn').click();
  await expect(page.locator('.toasts')).toContainText('Posted');
  await expect(page.locator('#ch .tab.on')).toHaveText('Latest');
  await expect(page.locator('.post').filter({ hasText: 'Hello from the e2e suite' })).toHaveCount(1);

  // Like a post (optimistic).
  const atlas = page.locator('.post').filter({ hasText: 'Open model update' });
  await atlas.locator('[data-act=like]').click();
  await expect(atlas.locator('[data-act=like]')).toHaveClass(/liked/);

  // Verify the first task: spinner, then Verified.
  await nav(page, 'Tasks');
  const follow = page.locator('.task').filter({ hasText: 'Follow @swaydotfamily on X' });
  await follow.getByRole('button', { name: 'Verify' }).click();
  await expect(follow.locator('.tag.aqua')).toHaveText('Verified', { timeout: 15_000 });
  await expect(page.locator('.toasts')).toContainText('Verified on X. +1,000 pts');
  // The next checklist task unlocked; the key task completed itself.
  await expect(page.locator('.task').filter({ hasText: 'Repost the launch post' }).getByRole('button', { name: 'Verify' })).toBeVisible();
  await expect(page.locator('.task').filter({ hasText: 'Hold a key you didn’t mint' }).locator('.tag.aqua')).toHaveText('Verified');

  // Earnings: run the live simulation until something is claimable, then claim it.
  await page.evaluate(() => {
    const w = (window as unknown as { __mockWorld: { simTick(): void; claimable(): number } }).__mockWorld;
    for (let i = 0; i < 500 && w.claimable() <= 0; i++) w.simTick();
  });
  await nav(page, 'Wallet');
  const claim = page.locator('.earn').getByRole('button', { name: 'Claim' });
  await expect(claim).toBeEnabled();
  await claim.click();
  await expect(page.locator('.toasts')).toContainText(/Claimed \$/);
  await expect(claim).toBeDisabled();
  await expect(page.locator('#main')).toContainText('Claimed earnings');
  await expect(page.locator('#main')).toContainText('Bought 1 key of Nova Reyes');

  // Deposit shows the address as a QR code; on the local chain it also hands out test funds.
  await page.getByRole('button', { name: 'Deposit' }).click();
  await expect(page.locator('.modal .qr img')).toBeVisible();
  await page.locator('.modal').getByRole('button', { name: 'Get test funds' }).click();
  await expect(page.locator('.toasts')).toContainText('Added $100 in demo funds');
  await page.keyboard.press('Escape');

  // Sell the key back from the wallet: the room locks again.
  await page.locator('.tr', { hasText: 'Nova Reyes' }).getByRole('button', { name: 'Sell' }).click();
  await page.locator('.modal').getByRole('button', { name: /^Sell 1 key for \$/ }).click();
  await expect(page.locator('.toasts')).toContainText('Sold 1 key of Nova Reyes');
  await expect(page.locator('#main')).toContainText('No keys yet.');
});

test('direct messages and notifications', async ({ page }) => {
  await connect(page, 'dmtester');
  await expect(page.locator('.sb .nv', { hasText: 'Messages' }).locator('.badge')).toHaveText('2');
  await nav(page, 'Messages');
  await page.locator('.thr', { hasText: 'Priya Sol' }).click();
  await expect(page.locator('#ch')).toContainText('@priyasol');
  await page.getByPlaceholder('Message @priyasol').fill('yes please');
  await page.keyboard.press('Enter');
  await expect(page.locator('.room-msgs')).toContainText('amazing, sending the link to your room', { timeout: 10_000 });

  await nav(page, 'Notifications');
  await expect(page.locator('#main')).toContainText('Your Sway score is');
  await page.getByRole('button', { name: 'Mark all read' }).click();
  // (the live simulation may add a fresh trade notification at any time, so check the seeded ones)
  await expect(page.locator('.nt.unread', { hasText: 'Your Sway score is' })).toHaveCount(0);
  await page.locator('.nt', { hasText: 'wants a friendly battle' }).click();
  await expect(page.locator('#ch')).toContainText('Engagement decides');

  // Back a side in a battle.
  await page.locator('.bt').first().locator('.backs').first().getByRole('button', { name: '100' }).click();
  await expect(page.locator('.toasts')).toContainText('Backed with 100 pts');
});

test('log out from the account menu', async ({ page }) => {
  await connect(page, 'logouttester');
  await page.locator('.sb .me-chip').getByRole('button', { name: 'Account menu' }).click();
  await page.getByText('Log out @logouttester').click();
  await expect(page.locator('.sb').getByRole('button', { name: 'Connect X' })).toBeVisible();
  await expect(page.locator('.guest')).toBeVisible();
});
