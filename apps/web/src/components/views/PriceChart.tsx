'use client';
/** [B] Key price over time (1H / 1D / 7D) on a canvas, drawn like CurveChart. */
import { weiToEth } from '@sway/curve';
import type { Format, HistoryRange, PriceHistoryResponse } from '@sway/shared';
import { useEffect, useRef } from 'react';

const label = (t: number, range: HistoryRange) => {
  const d = new Date(t);
  if (range === '7d') return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: range === '1h' ? '2-digit' : undefined });
};

export function PriceChart({ data, F }: { data: PriceHistoryResponse | undefined; F: Format }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const draw = () => {
      const cv = ref.current;
      if (!cv) return;
      const dpr = window.devicePixelRatio || 1,
        W = cv.clientWidth,
        H = cv.clientHeight;
      if (!W) return;
      cv.width = W * dpr;
      cv.height = H * dpr;
      const x = cv.getContext('2d');
      if (!x) return;
      x.scale(dpr, dpr);
      const pts = (data?.points ?? []).map((p) => ({ t: new Date(p.t).getTime(), v: weiToEth(p.priceWei) }));
      if (pts.length < 2) return;
      const pl = 62,
        pr = 8,
        pt = 8,
        pb = 22,
        iw = W - pl - pr,
        ih = H - pt - pb;
      const t0 = pts[0]!.t,
        t1 = pts[pts.length - 1]!.t;
      let lo = Math.min(...pts.map((p) => p.v)),
        hi = Math.max(...pts.map((p) => p.v));
      const pad = (hi - lo) * 0.12 || hi * 0.05 || 1e-9;
      lo = Math.max(0, lo - pad);
      hi += pad;
      const X = (t: number) => pl + ((t - t0) / Math.max(1, t1 - t0)) * iw,
        Y = (v: number) => pt + ih - ((v - lo) / (hi - lo)) * ih;
      x.font = '500 11px Inter, Segoe UI, sans-serif';
      x.fillStyle = '#536471';
      x.strokeStyle = '#EFF3F4';
      x.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const v = lo + ((hi - lo) * i) / 4,
          y = Y(v);
        x.beginPath();
        x.moveTo(pl, y);
        x.lineTo(W - pr, y);
        x.stroke();
        x.textAlign = 'right';
        x.fillText(F.$(v), pl - 8, y + 4);
      }
      x.textAlign = 'center';
      for (let i = 0; i <= 3; i++) {
        const t = t0 + ((t1 - t0) * i) / 3;
        x.fillText(label(t, data!.range), Math.min(W - pr - 18, Math.max(pl + 18, X(t))), H - 5);
      }
      // Step line: the price holds until the next trade.
      const path = () => {
        x.beginPath();
        pts.forEach((p, i) => {
          if (!i) x.moveTo(X(p.t), Y(p.v));
          else {
            x.lineTo(X(p.t), Y(pts[i - 1]!.v));
            x.lineTo(X(p.t), Y(p.v));
          }
        });
      };
      const up = pts[pts.length - 1]!.v >= pts[0]!.v;
      const col = up ? '0,186,124' : '244,33,46';
      const g = x.createLinearGradient(0, pt, 0, pt + ih);
      g.addColorStop(0, `rgba(${col},.2)`);
      g.addColorStop(1, `rgba(${col},0)`);
      path();
      x.lineTo(X(t1), pt + ih);
      x.lineTo(X(t0), pt + ih);
      x.closePath();
      x.fillStyle = g;
      x.fill();
      path();
      x.strokeStyle = `rgb(${col})`;
      x.lineWidth = 2.2;
      x.lineJoin = 'round';
      x.stroke();
      const last = pts[pts.length - 1]!;
      x.beginPath();
      x.arc(X(last.t), Y(last.v), 5, 0, Math.PI * 2);
      x.fillStyle = '#0F1419';
      x.fill();
      x.lineWidth = 2.5;
      x.strokeStyle = '#fff';
      x.stroke();
    };
    draw();
    window.addEventListener('resize', draw);
    document.fonts?.ready.then(draw).catch(() => null);
    return () => window.removeEventListener('resize', draw);
  }, [data, F]);
  return <canvas id="pricechart" ref={ref} aria-label="Key price chart" />;
}
