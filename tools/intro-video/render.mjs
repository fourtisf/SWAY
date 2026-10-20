import { createRequire } from 'module';
import { spawn } from 'node:child_process';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const [,, html, audio, out, fpsArg = '30', durArg = '30'] = process.argv;
const fps = Number(fpsArg), frames = Math.round(Number(durArg) * fps);
const ff = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', '-i', audio,
  '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-tune', 'grain',
  '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await p.goto('file://' + html); await p.evaluate(() => document.fonts.ready);
const t0 = Date.now();
for (let i = 0; i < frames; i++) {
  await p.evaluate(([t, i]) => window.render(t, i), [i / fps, i]);
  const buf = await p.screenshot({ type: 'png' });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % 150 === 0) console.log(`frame ${i}/${frames} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
ff.stdin.end(); await b.close();
await new Promise((r) => ff.on('close', r));
console.log('done', ((Date.now() - t0) / 1000).toFixed(0) + 's');
