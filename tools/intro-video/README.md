# Sway intro video (30 s, 1920×1080, 30 fps)

`intro.html` is the website-styled cut: white background, the site's logo and tokens, and real screens of the app
(Connect X, scoring, the Sway card, a profile, tasks, launchpad, Genesis pass, Open model) captured from the mock
app as `@yourhandle`, with no demo creators or trades in frame. `intro-dark.html` is the earlier dark cut.

Every frame is drawn by `render(t)` (no CSS animation, so frames are exact); `music.py` synthesises the music bed
(numpy only); `render.mjs` screenshots each frame with Playwright's Chromium and pipes it to ffmpeg.

```bash
pnpm --filter @sway/web dev:mock                      # in another terminal (port 3000)
cd tools/intro-video
node capture.mjs assets http://localhost:3000          # UI screenshots + crops (needs ImageMagick)
python3 music.py music.wav
node render.mjs "$PWD/intro.html" music.wav sway-intro.mp4 30 30   # ~5 min
```

Needs ffmpeg, ImageMagick, numpy and the web app's dependencies. Instrument Serif (dark cut) is under the SIL Open
Font License; Inter comes from the system.
