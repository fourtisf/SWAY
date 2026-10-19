/** [B] OG image for /card/:handle (next/og): Sway mark, name, @handle, score, reach value, voiceprint, tier. */
import { ImageResponse } from 'next/og';
import { TIERS } from '@sway/scoring';
import { hash, hueOf, makeFormat } from '@sway/shared';
import { fetchCard } from '@/lib/card-server';
import { initials, rng } from '@/lib/util';

export const alt = 'Sway card';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

function hsl(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Same bars as the app's <Voiceprint/> (seeded by handle, taller with a higher score). */
function bars(seed: string, score: number, n: number): number[] {
  const r = rng(hash(seed));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const env = Math.pow(Math.sin(Math.PI * x), 0.8) * 0.78 + 0.22;
    out.push(Math.max(7, env * (0.35 + r() * 0.65) * (34 + score * 0.66)));
    r();
  }
  return out;
}

const MARK = [
  [1, 7, 2.6, 6],
  [5.2, 3, 2.6, 14],
  [9.4, 5.5, 2.6, 9],
  [13.6, 1, 2.6, 18],
  [17, 8, 2.4, 4],
];

export default async function Image({ params }: { params: { handle: string } }) {
  const c = await fetchCard(params.handle);
  const F = makeFormat(3420);
  const name = c?.name ?? 'Sway';
  const handle = c?.handle ?? params.handle;
  const score = c?.score ?? 0;
  const tier = TIERS.find((t) => t.name === c?.tier) ?? TIERS[0]!;
  const frame = tier.frame.startsWith('linear') ? 'linear-gradient(90deg,#1D9BF0,#7856FF,#F91880)' : tier.frame;
  const hue = hueOf(handle);
  const vb = bars(handle, score || 60, 64);
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(140deg,#E3F1FD 0%,#F2F7FB 55%,#F7F9F9 100%)',
          padding: 44,
          fontFamily: 'sans-serif',
          color: '#0F1419',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <svg width="44" height="44" viewBox="0 0 20 20">
              {MARK.map(([x, y, w, h], i) => (
                <rect key={i} x={x} y={y} width={w} height={h} rx={w! / 2} fill="#0F1419" />
              ))}
            </svg>
            <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: -1 }}>Sway</div>
          </div>
          <div style={{ display: 'flex', padding: '8px 20px', borderRadius: 999, background: 'rgba(29,155,240,.12)', color: '#1A8CD8', fontSize: 28 }}>{c?.tier ?? 'Murmur'}</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 26, background: '#fff', borderRadius: 32, border: '2px solid #EFF3F4', overflow: 'hidden' }}>
          <div style={{ display: 'flex', height: 10, background: frame }} />
          <div style={{ display: 'flex', flexDirection: 'column', padding: '26px 40px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
              <div
                style={{
                  width: 88,
                  height: 88,
                  borderRadius: 999,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: `linear-gradient(140deg,${hsl(hue, 70, 62)},${hsl(hue + 40, 70, 46)})`,
                  color: '#fff',
                  fontSize: 38,
                  fontWeight: 700,
                }}
              >
                {initials(name, handle)}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: -1 }}>{name.slice(0, 32)}</div>
                <div style={{ fontSize: 30, color: '#536471' }}>{`@${handle}`}</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', marginTop: 14 }}>
              <div style={{ fontSize: 104, fontWeight: 800, lineHeight: 1, letterSpacing: -4 }}>{String(score)}</div>
              <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 16, marginBottom: 6, fontSize: 26, color: '#536471' }}>
                <div>/100</div>
                <div>Sway score</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginLeft: 'auto' }}>
                <div style={{ fontSize: 64, fontWeight: 800, letterSpacing: -2 }}>{F.usd(c?.reachValue ?? 0)}</div>
                <div style={{ fontSize: 24, color: '#536471' }}>reach value</div>
              </div>
            </div>
            <svg width="1028" height="64" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ marginTop: 18 }}>
              <defs>
                <linearGradient id="g" x1="0" x2="1">
                  <stop offset="0" stopColor="#1D9BF0" />
                  <stop offset=".5" stopColor="#7856FF" />
                  <stop offset="1" stopColor="#1D9BF0" />
                </linearGradient>
              </defs>
              {vb.map((h, i) => {
                const w = 100 / vb.length;
                return <rect key={i} x={i * w + w * 0.22} y={50 - h / 2} width={w * 0.56} height={h} rx={w * 0.28} fill="url(#g)" />;
              })}
            </svg>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'auto', fontSize: 24, color: '#536471' }}>
          <div>Buy my key and join my room</div>
          <div>Robinhood Chain</div>
        </div>
      </div>
    ),
    size,
  );
}
