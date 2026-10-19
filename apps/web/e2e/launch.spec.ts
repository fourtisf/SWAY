import { expect, test, type Page } from '@playwright/test';

/**
 * [C] Launchpad, creator tokens, key-holder airdrops, $SWAY staking and the Genesis list in mock mode.
 * The mock world lives in browser memory: after connecting, navigate client-side only (clicks or __router).
 */

test.beforeEach(async ({ page }) => {
  await page.route('**/api.dicebear.com/**', (r) => r.abort());
});

async function connect(page: Page, handle: string) {
  await page.goto('/');
  await page.locator('.sb').getByRole('button', { name: 'Connect X' }).click();
  await page.fill('#cx-h', handle);
  await page.locator('.modal').getByRole('button', { name: 'Authorize and continue' }).click();
  await expect(page.locator('.modal')).toContainText(`Scoring @${handle}`);
  // Onboarding may stop at the wallet choice (create or connect) before the card.
  const create = page.locator('.modal').getByRole('button', { name: 'Create a Sway wallet' });
  const live = page.locator('.modal').getByText('Your Sway card is live');
  await expect(create.or(live)).toBeVisible({ timeout: 20_000 });
  if (await create.isVisible()) await create.click();
  await expect(live).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Enter Sway' }).click();
  await expect(page.locator('.sb .me-chip')).toContainText(`@${handle}`);
}

const nav = (page: Page, label: string) => page.locator('.sb-nav').getByRole('link', { name: new RegExp('^' + label) }).click();
const go = (page: Page, path: string) => page.evaluate((p) => (window as unknown as { __router: { push(p: string): void } }).__router.push(p), path);
const mock = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as unknown as { __mockLaunch: Record<string, (...x: unknown[]) => T> }).__mockLaunch[f as string]!(...(a as unknown[])), [fn, args] as const);

test('launch my token, trade it and claim creator fees', async ({ page }) => {
  await connect(page, 'launchtester');
  await nav(page, 'Launchpad');
  await expect(page.locator('#main')).toContainText('Turn your reach into a token with one switch.');
  await page.locator('#main').getByRole('switch', { name: 'Launch your reach as a token' }).click();
  await expect(page.locator('.tok .tag')).toHaveText('Ready');
  await page.getByRole('button', { name: 'Launch $LAUNCH' }).click();

  const sheet = page.locator('.modal');
  await expect(sheet).toContainText('Launch $LAUNCH?');
  await expect(sheet).toContainText('Start cap');
  // The live simulation may have sold someone one of our keys already.
  await expect(sheet).toContainText(/Nobody else holds your keys yet|10% to \d+ holder/);
  await sheet.getByRole('button', { name: 'Launch $LAUNCH' }).click();
  await expect(page.locator('.toasts')).toContainText('$LAUNCH is live');
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('#main')).toContainText('$LAUNCH is live.');

  const box = page.locator('#tokenBox');
  await expect(box).toContainText('Progress to graduation');
  await box.getByRole('button', { name: '0.05 ETH' }).click();
  await box.getByRole('button', { name: /^Buy \$LAUNCH for \$/ }).click();
  await expect(page.locator('.toasts')).toContainText(/Bought .* \$LAUNCH/);

  await box.locator('.tside').getByRole('button', { name: 'Sell' }).click();
  await box.getByRole('button', { name: 'Max' }).click();
  await box.getByRole('button', { name: /^Sell .* \$LAUNCH$/ }).click();
  await expect(page.locator('.toasts')).toContainText(/Sold .* \$LAUNCH/);
  await expect(box).toContainText('You hold 0');

  await box.getByRole('button', { name: 'Claim creator fees' }).click();
  await expect(page.locator('.toasts')).toContainText('Claimed creator fees');
  await expect(box.getByRole('button', { name: 'Claim creator fees' })).toBeDisabled();
});

test('a creator whose keys I hold launches: claim the airdrop, trade another token', async ({ page }) => {
  await connect(page, 'droptester');
  await page.fill('#rs', 'nova');
  await page.locator('.sres .it', { hasText: 'Nova Reyes' }).click();
  await page.locator('.price-bar').getByRole('button', { name: 'Buy key' }).click();
  await page.locator('.modal').getByRole('button', { name: /^Buy 1 key for \$/ }).click();
  await expect(page.locator('.toasts')).toContainText('Bought 1 key of Nova Reyes');

  await mock(page, 'launchCreator', 'novareyes');
  await nav(page, 'Wallet');
  const card = page.locator('#airdrops');
  await expect(card).toContainText('Token airdrops to claim');
  await expect(card).toContainText('$NOVARE');
  await card.getByRole('button', { name: 'Claim' }).click();
  await expect(page.locator('.toasts')).toContainText(/Claimed .* \$NOVARE/);
  await expect(page.locator('#airdrops')).toHaveCount(0);

  // The token page of any creator; the claimed tokens are in my balance.
  await go(page, '/launchpad/novareyes');
  const box = page.locator('#tokenBox');
  await expect(box).toContainText('$NOVARE');
  await box.locator('.tside').getByRole('button', { name: 'Sell' }).click();
  await expect(box).not.toContainText('You hold 0');

  await go(page, '/launchpad/makotrades');
  await expect(page.locator('#tokenBox')).toContainText('$MAKOTR');
  await page.locator('#tokenBox').getByRole('button', { name: /^Buy \$MAKOTR for \$/ }).click();
  await expect(page.locator('.toasts')).toContainText(/Bought .* \$MAKOTR/);
  await page.locator('#tokenBox .tside').getByRole('button', { name: 'Sell' }).click();
  await page.locator('#tokenBox').getByRole('button', { name: '50%' }).click();
  await page.locator('#tokenBox').getByRole('button', { name: /^Sell .* \$MAKOTR$/ }).click();
  await expect(page.locator('.toasts')).toContainText(/Sold .* \$MAKOTR/);

  await go(page, '/launchpad/kenjionchain');
  await expect(page.locator('#main')).toContainText('hasn’t launched a token yet');
});

test('stake $SWAY, request unstake, withdraw after the cooldown', async ({ page }) => {
  await connect(page, 'staketester');
  await nav(page, 'Wallet');
  await page.locator('#stakeCard').click();
  await expect(page.locator('#ch')).toContainText('Staking');
  await expect(page.locator('#main')).toContainText('No level yet');
  await page.getByRole('button', { name: 'Get test $SWAY' }).click();
  await expect(page.locator('.toasts')).toContainText('10,000 $SWAY');

  await page.fill('#stakeAmt', '1000');
  await expect(page.locator('#stakeForm')).toContainText('1 Beat');
  await page.getByRole('button', { name: 'Approve and stake 1K $SWAY' }).click();
  await expect(page.locator('.toasts')).toContainText('Staked 1K $SWAY');
  await expect(page.locator('.bal .tag')).toHaveText('Level 1 Beat');
  await expect(page.locator('.tr.me')).toContainText('Your level');

  const form = page.locator('#stakeForm');
  await form.getByRole('button', { name: 'Unstake' }).click();
  await form.getByRole('button', { name: 'Max' }).click();
  await form.getByRole('button', { name: 'Request unstake of 1K $SWAY' }).click();
  await expect(page.locator('.toasts')).toContainText('Unstaking 1K $SWAY');
  await expect(page.locator('#main')).toContainText(/Unstaking, unlocks in (7d|6d 23h)/);
  await expect(page.locator('.bal .tag')).toHaveText('No level yet');
  await expect(page.getByRole('button', { name: 'Withdraw' })).toBeDisabled();

  await mock(page, 'warp', 7 * 86400 + 60);
  await nav(page, 'Wallet');
  await page.locator('#stakeCard').click();
  await expect(page.locator('#main')).toContainText('Ready to withdraw');
  await page.getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.locator('.toasts')).toContainText('Withdrew your unstaked $SWAY');
});

test('the frozen Genesis list', async ({ page }) => {
  // Guests can open a published list (the URI GenesisPass commits).
  await page.goto('/genesis/list/demo');
  await expect(page.locator('#main')).toContainText('The Genesis list');
  await expect(page.locator('#main')).toContainText('#0001');
  await expect(page.locator('#main')).toContainText('List hash');

  await connect(page, 'genesistester');
  await nav(page, 'Genesis pass');
  await expect(page.locator('#main')).toContainText('Live until the freeze');
  await mock(page, 'freezeGenesis');
  await nav(page, 'Home');
  await nav(page, 'Genesis pass');
  await expect(page.locator('#main')).toContainText('Top 30 at the snapshot');
  await page.locator('#main').getByRole('link', { name: 'See the full list' }).first().click();
  await expect(page.locator('#main')).toContainText('The Genesis list');
  await expect(page.locator('#main')).toContainText('Your pass');
  await expect(page.locator('.tr.me')).toContainText('genesistester');
});
