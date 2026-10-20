# Sway intro video (30 s, 1920×1080, 30 fps)

`intro.html` draws every frame from `render(t)` (no CSS animation, so frames are exact); `music.py` synthesises the
music bed (numpy only); `render.mjs` screenshots each frame with Playwright's Chromium and pipes it to ffmpeg.

```bash
cd tools/intro-video
python3 music.py music.wav
node render.mjs "$PWD/intro.html" music.wav sway-intro.mp4 30 30   # ~8 min
```

Needs ffmpeg, numpy and the web app's dependencies (`pnpm install`). Instrument Serif is under the SIL Open Font
License; Inter comes from the system.
