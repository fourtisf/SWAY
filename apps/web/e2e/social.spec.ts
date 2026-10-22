import { expect, test, type Page } from '@playwright/test';

/**
 * [B] Mock-mode e2e: post menu (delete, report, block, boost, hide), images, post page replies, settings and
 * account deletion, legal pages, the admin panel and the share card. The mock world lives in browser memory,
 * so after connecting we only navigate client-side.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test.beforeEach(async ({ page }) => {
  await page.route('**/api.dicebear.com/**', (r) => r.abort());
});

async function connect(page: Page, handle: string) {
  await page.goto('/');
  await page.locator('.sb').getByRole('button', { name: 'Connect X' }).click();
  await expect(page.locator('.modal')).toContainText('By continuing you agree to the Terms and the Privacy Policy');
  await page.fill('#cx-h', handle);
  await page.locator('.modal').getByRole('button', { name: 'Authorize and continue' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Create a Sway wallet' }).click({ timeout: 20_000 });
  await expect(page.locator('.modal')).toContainText('Your Sway card is live', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Enter Sway' }).click();
  await expect(page.locator('.sb .me-chip')).toContainText(`@${handle}`);
}

const nav = (page: Page, label: string) => page.locator('.sb-nav').getByRole('link', { name: new RegExp('^' + label) }).click();
const postBy = (page: Page, text: string) => page.locator('#main .post').filter({ hasText: text }).first();
async function menu(page: Page, text: string) {
  await postBy(page, text).getByRole('button', { name: 'More' }).click();
  return page.locator('.pmenu');
}

test('post menu: delete your post, report and block others', async ({ page }) => {
  await connect(page, 'menutester');
  await expect(page.locator('.sb-nav')).toContainText('Settings');
  await expect(page.locator('.sb-nav')).not.toContainText('Admin');

  await page.fill('#compose', 'Delete me please');
  await page.locator('#postBtn').click();
  await expect(postBy(page, 'Delete me please')).toBeVisible();
  let m = await menu(page, 'Delete me please');
  await expect(m.getByRole('menuitem')).toHaveText(['Delete', 'Boost', 'Copy link']);
  await m.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.locator('.modal')).toContainText('Delete post?');
  await page.locator('.modal').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.toasts')).toContainText('Post deleted');
  await expect(page.locator('#main .post', { hasText: 'Delete me please' })).toHaveCount(0);

  m = await menu(page, 'Open model update');
  await expect(m.getByRole('menuitem')).toHaveText(['Copy link', 'Report post', 'Block @atlas_rsch']);
  await m.getByRole('menuitem', { name: 'Report post' }).click();
  const send = page.locator('.modal').getByRole('button', { name: 'Send report' });
  await expect(send).toBeDisabled();
  await page.locator('.modal').getByRole('radio', { name: /^Spam/ }).click();
  await page.fill('#rp-n', 'Looks like a bot');
  await send.click();
  await expect(page.locator('.toasts')).toContainText('Thanks. Our moderators will take a look.');

  m = await menu(page, 'Battle accepted vs @vexcapital');
  await m.getByRole('menuitem', { name: 'Block @makotrades' }).click();
  await expect(page.locator('.toasts')).toContainText('You blocked @makotrades');
  await expect(page.locator('#main .post', { hasText: 'Battle accepted vs @vexcapital' })).toHaveCount(0);

  // The profile says so and offers Unblock.
  await page.fill('#rs', 'mako');
  await page.locator('.sres .it', { hasText: 'Mako' }).click();
  await expect(page.locator('#main')).toContainText('You blocked @makotrades.');
  await expect(page.locator('.ptabs')).toContainText('You blocked @makotrades');
  await page.locator('.p-acts').getByRole('button', { name: 'Unblock' }).click();
  await expect(page.locator('.toasts')).toContainText('Unblocked @makotrades');
  await expect(page.locator('.p-acts').getByRole('button', { name: 'Follow' })).toBeVisible();
});

test('boost your post through the wallet', async ({ page }) => {
  await connect(page, 'boostertest');
  await page.fill('#compose', 'Boost this one');
  await page.locator('#postBtn').click();
  const m = await menu(page, 'Boost this one');
  await m.getByRole('menuitem', { name: 'Boost' }).click();
  const sheet = page.locator('.modal');
  await expect(sheet).toContainText('Boost post');
  await expect(sheet.locator('.sum-r.tot')).toContainText('$10.00');
  await sheet.getByRole('button', { name: 'Boost for $10.00' }).click();
  await expect(page.locator('.toasts')).toContainText('Boosted for 24 hours');
  await expect(postBy(page, 'Boost this one').locator('.boost')).toContainText('Boosted');
});

test('images: pick, preview, remove, post the grid; bad files are refused', async ({ page }) => {
  await connect(page, 'imgtester');
  await page.setInputFiles('#img-in', { name: 'evil.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload=alert(1)>') });
  await expect(page.locator('.toasts')).toContainText('Only JPEG, PNG, WebP and GIF images');
  await expect(page.locator('.cmedia')).toHaveCount(0);

  await page.setInputFiles('#img-in', [
    { name: 'a.png', mimeType: 'image/png', buffer: PNG },
    { name: 'b.png', mimeType: 'image/png', buffer: PNG },
    { name: 'c.png', mimeType: 'image/png', buffer: PNG },
  ]);
  await expect(page.locator('.cmedia .cm img')).toHaveCount(3);
  await page.getByRole('button', { name: 'Remove image 2' }).click();
  await expect(page.locator('.cmedia .cm img')).toHaveCount(2);
  await page.fill('#compose', 'Two pictures');
  await page.locator('#postBtn').click();
  await expect(page.locator('.toasts')).toContainText('Posted');
  await expect(page.locator('.cmedia')).toHaveCount(0);
  await expect(postBy(page, 'Two pictures').locator('.pm.pm2 img')).toHaveCount(2);
});

test('video: one per post, plays inline in the feed', async ({ page }) => {
  await connect(page, 'vidtester');
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
  await page.setInputFiles('#img-in', [
    { name: 'a.png', mimeType: 'image/png', buffer: PNG },
    { name: 'clip.mp4', mimeType: 'video/mp4', buffer: MP4 },
  ]);
  await expect(page.locator('.toasts')).toContainText('A video goes in a post on its own');
  await expect(page.locator('.cmedia')).toHaveCount(0);

  await page.setInputFiles('#img-in', { name: 'clip.mp4', mimeType: 'video/mp4', buffer: MP4 });
  await expect(page.locator('.cmedia .cm video')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add image' }).first()).toBeDisabled();
  await page.fill('#compose', 'Watch the tour');
  await page.locator('#postBtn').click();
  await expect(page.locator('.toasts')).toContainText('Posted');
  await expect(postBy(page, 'Watch the tour').locator('.pm.pmv video')).toHaveCount(1);
});

test('post page: thread, replies and the reply composer', async ({ page }) => {
  await connect(page, 'replytester');
  await postBy(page, 'Open model update').locator('[data-act=reply]').click();
  await expect(page).toHaveURL(/\/post\//);
  await expect(page.locator('#ch')).toContainText('Post');
  await expect(page.locator('#main .post.focus')).toContainText('Open model update');
  await expect(page.locator('#replies .post')).toHaveCount(2);
  await expect(page.locator('#main')).toContainText('Replying to @atlas_rsch');
  await page.fill('#reply-box', 'Great update, forking it now');
  await page.locator('#replyBtn').click();
  await expect(page.locator('.toasts')).toContainText('Your reply was sent');
  await expect(page.locator('#replies .post').last()).toContainText('Great update, forking it now');

  // Open the reply's own page: the post above it is shown as its parent.
  await page.locator('#replies .post', { hasText: 'Great update' }).locator('.pt-time').click();
  await expect(page.locator('#main .post.focus')).toContainText('Great update, forking it now');
  await expect(page.locator('#main .post.thread').first()).toContainText('Open model update');
});

test('settings: account info, download, delete the account', async ({ page }) => {
  await connect(page, 'leavingsoon');
  await nav(page, 'Settings');
  await expect(page.locator('#ch')).toContainText('Settings');
  await expect(page.locator('.settings')).toContainText('@leavingsoon');
  await expect(page.locator('.settings')).toContainText('Member');
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my data' }).click();
  expect((await dl).suggestedFilename()).toBe('sway-leavingsoon-export.json');

  const del = page.getByRole('button', { name: 'Delete my account' });
  await expect(del).toBeDisabled();
  await page.fill('#del-c', 'delete @someoneelse');
  await expect(del).toBeDisabled();
  await page.fill('#del-c', 'delete @leavingsoon');
  await del.click();
  await expect(page.locator('.toasts')).toContainText('Your account was deleted');
  await expect(page.locator('.sb').getByRole('button', { name: 'Connect X' })).toBeVisible();
  await expect(page.locator('.guest')).toBeVisible();
});

test('legal pages are linked and marked as templates', async ({ page }) => {
  await page.goto('/terms');
  await expect(page.locator('#main')).toContainText('Template: have counsel review before launch');
  await expect(page.locator('#main')).toContainText('Keys are not shares, securities');
  await expect(page.locator('#main')).toContainText('no monetary value until we announce otherwise');
  await page.locator('.rail-foot').getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.locator('#main')).toContainText('access token is used only during your session');
  await expect(page.locator('#main')).toContainText('Download and delete your data');
  // Mobile drawer.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.locator('#drawer').getByRole('link', { name: 'Terms' })).toBeVisible();
});

test('admin panel: reports, members, markets and hiding posts', async ({ page }) => {
  await connect(page, 'adminuser');
  await nav(page, 'Admin');
  await expect(page.locator('#ch')).toContainText('Admin');
  const report = page.locator('.adm-card', { hasText: 'Not the real Tomas' });
  await expect(report).toContainText('Impersonation');
  await report.getByRole('button', { name: 'Flag author as bot' }).click();
  await expect(page.locator('.toasts')).toContainText('@tomasweld flagged as a bot');
  await expect(page.locator('.adm-card', { hasText: 'Not the real Tomas' })).toHaveCount(0);

  await page.getByRole('tab', { name: 'Claims & takedowns' }).click();
  const claim = page.locator('.adm-card', { hasText: 'legal@orbitlabs.example' });
  await claim.getByRole('button', { name: 'Halt buys' }).click();
  await expect(page.locator('.toasts')).toContainText('Halt sent onchain');
  await page.locator('.adm-card', { hasText: 'legal@orbitlabs.example' }).getByRole('button', { name: 'Mark resolved' }).click();
  await expect(page.locator('#main')).toContainText('No open requests');

  await page.getByRole('tab', { name: 'Members' }).click();
  await page.getByPlaceholder('Search members', { exact: true }).fill('priya');
  const row = page.locator('.adm-row[data-handle=priyasol]');
  await row.getByRole('button', { name: 'Flag bot' }).click();
  await expect(row).toContainText('Bot');
  await row.getByRole('button', { name: 'Make admin' }).click();
  await expect(row.locator('.tag', { hasText: 'Admin' })).toBeVisible();

  await page.getByRole('tab', { name: 'Markets' }).click();
  await page.getByPlaceholder('Search markets', { exact: true }).fill('nova');
  const mk = page.locator('.adm-row[data-handle=novareyes]');
  await mk.getByRole('button', { name: 'Halt' }).click();
  await expect(mk.locator('.tag', { hasText: 'Halted' })).toBeVisible();
  await mk.getByRole('button', { name: 'Unhalt' }).click();
  await expect(mk.locator('.tag', { hasText: 'Halted' })).toHaveCount(0);
  await page.fill('#fm-h', '@newfanco');
  await page.fill('#fm-n', 'New Fan Co');
  await page.fill('#fm-x', '987654321');
  await page.fill('#fm-f', '250000');
  await page.selectOption('#fm-c', 'stocks');
  await page.getByRole('button', { name: 'Open fan market' }).click();
  await expect(page.locator('.toasts')).toContainText('Fan market for @newfanco opened');

  // Admins can hide any post from its menu.
  await nav(page, 'Home');
  const m = await menu(page, 'Open model update');
  await m.getByRole('menuitem', { name: 'Hide post' }).click();
  await expect(page.locator('.toasts')).toContainText('Post hidden');
  await expect(postBy(page, 'Open model update').locator('.tag', { hasText: 'Hidden' })).toBeVisible();
});

test('share card page, its OG image and the price chart', async ({ page }) => {
  await page.goto('/card/novareyes');
  await expect(page.locator('.card-page')).toContainText('Sway score');
  await expect(page.locator('.card-page')).toContainText('Nova Reyes');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /\/card\/novareyes\/opengraph-image/);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
  const og = await page.request.get('/card/novareyes/opengraph-image');
  expect(og.status()).toBe(200);
  expect(og.headers()['content-type']).toContain('image/png');

  await page.locator('.card-page').getByRole('button', { name: 'View profile' }).click();
  await page.locator('.chart-card').getByRole('tab', { name: 'Price' }).click();
  await expect(page.locator('#pricechart')).toBeVisible();
  await page.locator('.chart-card').getByRole('button', { name: '7D' }).click();
  await expect(page.locator('.chart-card')).toContainText('in 7D');
});

test('admins can unpin and re-pin the official post', async ({ page }) => {
  await connect(page, 'adminpin');
  const official = () => postBy(page, 'Shipped today on Sway');
  await expect(official().locator('.pin')).toBeVisible();
  let m = await menu(page, 'Shipped today on Sway');
  await m.getByRole('menuitem', { name: 'Unpin from Home' }).click();
  await expect(page.locator('.toasts')).toContainText('Unpinned');
  await expect(official()).toBeVisible();
  await expect(official().locator('.pin')).toHaveCount(0);
  m = await menu(page, 'Shipped today on Sway');
  await m.getByRole('menuitem', { name: 'Pin to Home' }).click();
  await expect(page.locator('.toasts')).toContainText('Pinned to the top of Home');
  await expect(official().locator('.pin')).toBeVisible();
});
