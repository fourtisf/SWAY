import { expect, test, type Page } from '@playwright/test';

/**
 * [A] Several wallets per member in mock mode: connect wallets from the picker (each with its logo), switch the
 * paying wallet in the trade sheet, buy from the second wallet, deposit QR, Sway wallet backup and import.
 * The mock world lives in browser memory: after connecting, navigate client-side only.
 */

test.beforeEach(async ({ page }) => {
  await page.route('**/api.dicebear.com/**', (r) => r.abort());
});

// `next dev` compiles routes on first visit and may reload the page, which would wipe the in-memory mock world
// mid-test. Visit the routes these tests use once, as a guest, before signing in.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  for (const path of ['/', '/wallet', '/novareyes', '/explore']) {
    await page.goto(path);
    await expect(page.locator('#main')).toBeVisible();
  }
  await page.close();
});

async function signIn(page: Page, handle: string, wallet: 'create' | 'connect' = 'create') {
  await page.goto('/');
  await page.locator('.sb').getByRole('button', { name: 'Connect X' }).click();
  await page.fill('#cx-h', handle);
  await page.locator('.modal').getByRole('button', { name: 'Authorize and continue' }).click();
  await expect(page.locator('.modal')).toContainText(`Scoring @${handle}`);
  await page
    .locator('.modal')
    .getByRole('button', { name: wallet === 'create' ? 'Create a Sway wallet' : 'Connect a wallet' })
    .click({ timeout: 20_000 });
}

async function enter(page: Page, handle: string) {
  await expect(page.locator('.modal')).toContainText('Your Sway card is live', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Enter Sway' }).click();
  await expect(page.locator('.sb .me-chip')).toContainText(`@${handle}`);
}

const nav = (page: Page, label: string) => page.locator('.sb-nav').getByRole('link', { name: new RegExp('^' + label) }).click();
const row = (page: Page, connector: string) => page.locator(`.wl-list .tr.wl[data-wallet="${connector}"]`);

async function addWallet(page: Page, connector: string, name: string) {
  await page.getByRole('button', { name: 'Add wallet' }).click();
  const opt = page.locator(`.modal .wopt[data-wallet="${connector}"]`);
  await expect(opt.locator('img')).toHaveAttribute('src', /^data:image\//);
  await opt.click();
  await expect(page.locator('.toasts')).toContainText(`${name} added`, { timeout: 15_000 });
  await expect(page.locator('.modal')).toHaveCount(0);
}

test('connect two wallets with their logos, switch in the trade sheet and buy from the second', async ({ page }) => {
  await signIn(page, 'walletfan');
  await enter(page, 'walletfan');
  await nav(page, 'Wallet');
  await expect(page.locator('.wl-list .tr.wl')).toHaveCount(1);
  await expect(row(page, 'sway')).toContainText('Account');
  // Each wallet's address can be copied straight from the list.
  await row(page, 'sway').getByRole('button', { name: /^Copy the address of/ }).click();
  await expect(page.locator('.toasts')).toContainText('Address copied');

  // The picker lists the Sway wallet, detected browser wallets and the curated apps, each with a logo.
  await page.getByRole('button', { name: 'Add wallet' }).click();
  const modal = page.locator('.modal');
  await expect(modal.locator('h3')).toHaveText('Add a wallet');
  for (const id of ['metaMask', 'coinbaseWallet', 'rabby', 'rainbow', 'trust', 'okx', 'phantom', 'zerion', 'walletConnect'])
    await expect(modal.locator(`.wopt[data-wallet="${id}"] img`)).toHaveAttribute('src', /^data:image\//);
  await expect(modal.locator('.wopt[data-wallet="sway"] .wlogo.sway')).toBeVisible();
  await expect(modal.locator('.wopt[data-wallet="metaMask"]')).toContainText('Detected');
  await page.keyboard.press('Escape');

  await addWallet(page, 'metaMask', 'MetaMask');
  await addWallet(page, 'rabby', 'Rabby');
  await expect(page.locator('.wl-list .tr.wl')).toHaveCount(3);
  for (const id of ['metaMask', 'rabby']) {
    const img = row(page, id).locator('.wlogo img');
    await expect(img).toHaveCount(1);
    expect(await img.getAttribute('src')).toMatch(/^data:image\/.+/);
    await expect(row(page, id)).toContainText('Linked');
  }
  // The wallet added last is active.
  await expect(row(page, 'rabby')).toContainText('Active');

  // Trade sheet: pay with Rabby, switch to MetaMask, buy from it.
  await page.fill('#rs', 'nova');
  await page.locator('.sres .it', { hasText: 'Nova Reyes' }).click();
  await expect(page.locator('.p-name')).toContainText('Nova Reyes');
  await page.locator('.price-bar').getByRole('button', { name: 'Buy key' }).click();
  const sheet = page.locator('.modal');
  await expect(sheet.locator('.wsel')).toContainText('Rabby');
  await expect(sheet.locator('.wsel .wlogo img')).toHaveAttribute('src', /^data:image\//);
  await sheet.locator('.wsel').click();
  await expect(sheet.locator('.wsel-o')).toHaveCount(3);
  await sheet.locator('.wsel-o', { hasText: 'MetaMask' }).click();
  await expect(sheet.locator('.wsel')).toContainText('MetaMask');
  await sheet.getByRole('button', { name: /^Buy 1 key for \$/ }).click();
  await expect(page.locator('.toasts')).toContainText('Bought 1 key of Nova Reyes');
  await expect(page.locator('.p-meta')).toContainText('keys held by you');

  // Both wallets are listed; the key sits in MetaMask and is counted for the member.
  await nav(page, 'Wallet');
  await expect(page.locator('.wl-list .tr.wl')).toHaveCount(3);
  await expect(row(page, 'metaMask')).toContainText('Active');
  await expect(row(page, 'metaMask')).toContainText('in keys');
  const holding = page.locator('.tr.clickable', { hasText: 'Nova Reyes' });
  await expect(holding).toContainText('MetaMask');
  await expect(holding.locator('.wl-in img')).toHaveAttribute('src', /^data:image\//);
  await expect(holding.locator('.num small')).toHaveText(/^[+−]\d+\.\d%$/);

  // Sell it back from the wallet page: the sheet sells from the wallet that holds it.
  await holding.getByRole('button', { name: 'Sell' }).click();
  await expect(page.locator('.modal .wsel')).toContainText('MetaMask');
  await page.locator('.modal').getByRole('button', { name: /^Sell 1 key for \$/ }).click();
  await expect(page.locator('.toasts')).toContainText('Sold 1 key of Nova Reyes');
});

test('deposit QR per wallet, Sway wallet backup and import, rename and remove', async ({ page }) => {
  await signIn(page, 'keykeeper');
  await enter(page, 'keykeeper');
  await nav(page, 'Wallet');
  await addWallet(page, 'rabby', 'Rabby');

  // Deposit: QR + address of the chosen wallet, network and chain id, test funds.
  await page.getByRole('button', { name: 'Deposit' }).click();
  const modal = page.locator('.modal');
  await expect(modal.locator('.qr img')).toHaveAttribute('src', /^data:image\/png/);
  await expect(modal.locator('.dep-i')).toContainText('Chain ID');
  await modal.locator('.wchip', { hasText: 'Sway wallet' }).click();
  const swayAddr = await modal.locator('input.field').inputValue();
  await modal.locator('.wchip', { hasText: 'Rabby' }).click();
  const rabbyAddr = await modal.locator('input.field').inputValue();
  expect(rabbyAddr).not.toBe(swayAddr);
  await modal.getByRole('button', { name: 'Get test funds' }).click();
  await expect(page.locator('.toasts')).toContainText('Added $100 in demo funds');
  await page.keyboard.press('Escape');

  // Back up the Sway wallet: the key only shows after the warning is acknowledged.
  await row(page, 'sway').getByRole('button', { name: /Wallet menu/ }).click();
  await page.getByRole('menuitem', { name: 'Back up Sway wallet' }).click();
  await expect(modal).toContainText('Anyone with this key controls the wallet');
  await expect(modal.getByRole('button', { name: 'Show private key' })).toBeDisabled();
  await modal.getByRole('checkbox').check();
  await modal.getByRole('button', { name: 'Show private key' }).click();
  await expect(modal.getByTestId('private-key')).toHaveText(/^0x[0-9a-f]{64}$/);
  await modal.getByRole('button', { name: 'Done' }).click();

  // Import a Sway wallet from a key: added as a new wallet.
  await page.getByRole('button', { name: 'Import Sway wallet' }).first().click();
  await modal.locator('#imp-k').fill('0x' + '7'.repeat(63) + '1');
  await expect(modal).toContainText('it will be added to your wallets');
  await modal.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.locator('.toasts')).toContainText('Sway wallet imported');
  await expect(page.locator('.wl-list .tr.wl')).toHaveCount(3);

  // Rename and remove a linked wallet.
  await row(page, 'rabby').getByRole('button', { name: /Wallet menu/ }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await modal.locator('#wl-n').fill('Trading');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(row(page, 'rabby')).toContainText('Trading');
  await row(page, 'rabby').getByRole('button', { name: /Wallet menu/ }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await modal.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.toasts')).toContainText('Wallet removed');
  await expect(page.locator('.wl-list .tr.wl')).toHaveCount(2);
});

test('a linked wallet app becomes the account wallet; the Sway wallet stays added', async ({ page }) => {
  await signIn(page, 'switchfan');
  await enter(page, 'switchfan');
  await nav(page, 'Wallet');
  await addWallet(page, 'rabby', 'Rabby');
  await expect(row(page, 'sway')).toContainText('Account');
  await row(page, 'rabby').getByRole('button', { name: /Wallet menu/ }).click();
  await page.getByRole('menuitem', { name: 'Make account wallet' }).click();
  const modal = page.locator('.modal');
  await expect(modal).toContainText('stays added, with its money and keys');
  await modal.getByRole('button', { name: 'Make account wallet' }).click();
  await expect(page.locator('.toasts')).toContainText('That’s your account wallet now');
  await expect(row(page, 'rabby')).toContainText('Account');
  await expect(row(page, 'sway')).not.toContainText('Account');
  await expect(page.locator('.wl-list .tr.wl')).toHaveCount(2);
});

test('onboarding can connect a wallet app as the account wallet', async ({ page }) => {
  await signIn(page, 'wcfan', 'connect');
  const modal = page.locator('.modal');
  await expect(modal.locator('h3')).toHaveText('Connect a wallet');
  await expect(modal.locator('.wopt[data-wallet="sway"]')).toHaveCount(0);
  await modal.locator('.wopt[data-wallet="walletConnect"]').click();
  await expect(modal.locator('.qr img')).toBeVisible();
  await enter(page, 'wcfan');
  await nav(page, 'Wallet');
  await expect(page.locator('.wl-list .tr.wl')).toHaveCount(1);
  await expect(row(page, 'walletConnect')).toContainText('Account');
  await expect(row(page, 'walletConnect').locator('.wlogo img')).toHaveAttribute('src', /^data:image\//);
});
