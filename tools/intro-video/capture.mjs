import { createRequire } from 'module';
import { spawnSync } from 'node:child_process';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
// Captures the real web UI from the mock app (pnpm --filter @sway/web dev:mock), signed in as @yourhandle, at 2x.
const [,, out = 'assets', base = 'http://localhost:3000'] = process.argv;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await p.route('**/api.dicebear.com/**', (r) => r.abort());
// No demo activity in the ad: hide toasts, the trades ticker and the Live trades / Live battle widgets.
const HIDE = `.toasts,.ticker,#ltList{display:none!important}`;
// The video leaves out the token ticker: hide the rail's contract-address card on the page shots.
const HIDE_CA = `#rail .comm{display:none!important}`;
const hideDemo = async () => {
  await p.addStyleTag({ content: HIDE });
  await p.evaluate(() => document.querySelectorAll('#rail .glass').forEach((g) => { if (/Live trades|Live battle/.test(g.textContent || '')) g.style.display = 'none'; }));
};
const shot = async (loc, name) => { await loc.screenshot({ path: `${out}/${name}.png`, animations: 'disabled' }); console.log('ok', name); };
await p.goto(base + '/', { waitUntil: 'networkidle' });
await hideDemo();
await p.locator('.sb').getByRole('button', { name: 'Connect X' }).click();
// connect.png shows the production modal (X sign-in on, demo sign-in off): drop the demo-only fields.
await p.evaluate(() => ['label[for=cx-h]', '#cx-h', 'label[for=cx-f]', '#cx-f'].forEach((q) => document.querySelector(q)?.remove()));
await p.waitForTimeout(300);
await shot(p.locator('.modal'), 'connect');
await p.locator('.modal').evaluate(() => null);
// The mock still signs in through the demo form: put it back for the next steps.
await p.locator('.modal').getByRole('button', { name: 'Close' }).click();
await p.locator('.sb').getByRole('button', { name: 'Connect X' }).click();
await p.fill('#cx-h', 'yourhandle');
await p.locator('.modal').getByRole('button', { name: 'Authorize and continue' }).click();
for (let i = 0; i < 6; i++) { await p.waitForTimeout(i ? 330 : 120); await shot(p.locator('.modal'), `scoring${i}`); }
await p.locator('.modal').getByRole('button', { name: 'Create a Sway wallet' }).click({ timeout: 20000 });
await p.locator('.modal').getByText('Your Sway card is live').waitFor({ timeout: 20000 });
await p.waitForTimeout(900);
await shot(p.locator('.modal'), 'cardlive');
await p.getByRole('button', { name: 'Enter Sway' }).click();
await p.waitForTimeout(800);
await hideDemo();
await shot(p.locator('#lcard'), 'launchcard');
await shot(p.locator('#rail .comm'), 'swaycard');
const go = async (label, ready) => {
  await p.locator('.sb-nav').getByRole('link', { name: new RegExp('^' + label) }).click();
  await p.waitForTimeout(3500); await hideDemo(); if (ready) await ready();
};
await go('Profile');
await p.waitForURL('**/yourhandle'); await p.locator('#main').getByText('Key price').waitFor();
await p.addStyleTag({ content: HIDE_CA });
await p.waitForTimeout(800);
await p.screenshot({ path: `${out}/profile-full.png`, animations: 'disabled' });
await shot(p.locator('#main'), 'profile-main');
await go('Tasks');
await shot(p.locator('#main'), 'tasks-main');
await go('Open model');
await shot(p.locator('#main'), 'model-main');
await go('Launchpad');
await shot(p.locator('#main'), 'launch-off');
const sw = p.locator('#main').getByRole('switch').first();
if (await sw.count()) { await sw.click(); await p.waitForTimeout(1500); await hideDemo(); await shot(p.locator('#main'), 'launch-on'); }
else console.log('no switch on launchpad');
await go('Genesis');
await shot(p.locator('#main'), 'genesis-main');
await b.close();
// Crops used by intro.html (ImageMagick).
for (const [from, to, geo] of [['profile-main', 'profile-top', '1198x1700+0+0'], ['model-main', 'model-crop', '1198x1200+0+170'], ['launch-on', 'launch-crop', '1198x1000+0+0'], ['genesis-main', 'genesis-crop', '1198x1000+0+0'], ['tasks-main', 'tasks-crop', '1198x1500+0+0']])
  spawnSync('convert', [`${out}/${from}.png`, '-crop', geo, '+repage', `${out}/${to}.png`], { stdio: 'inherit' });
