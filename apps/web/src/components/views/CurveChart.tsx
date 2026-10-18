'use client';
import { priceAt } from '@sway/curve';
import type { Format } from '@sway/shared';
import { useEffect, useRef } from 'react';

/** Bonding-curve canvas (prototype drawCurve()); float priceAt is fine for a chart. */
export function CurveChart({ supply, F }: { supply: number; F: Format }) {
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
      const pl = 62,
        pr = 8,
        pt = 8,
        pb = 22,
        iw = W - pl - pr,
        ih = H - pt - pb;
      const maxS = Math.max(20, supply * 1.8 + 5),
        maxP = priceAt(maxS);
      const X = (s: number) => pl + (s / maxS) * iw,
        Y = (p: number) => pt + ih - (p / maxP) * ih;
      x.font = '500 11px Inter, Segoe UI, sans-serif';
      x.fillStyle = '#536471';
      x.strokeStyle = '#EFF3F4';
      x.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const p = (maxP * i) / 4,
          y = Y(p);
        x.beginPath();
        x.moveTo(pl, y);
        x.lineTo(W - pr, y);
        x.stroke();
        x.textAlign = 'right';
        x.fillText(p === 0 ? '$0' : F.$(p), pl - 8, y + 4);
      }
      x.textAlign = 'center';
      for (let i = 0; i <= 4; i++) {
        const s = (maxS * i) / 4;
        x.fillText(String(Math.round(s)), X(s), H - 5);
      }
      const g = x.createLinearGradient(0, pt, 0, pt + ih);
      g.addColorStop(0, 'rgba(29,155,240,.22)');
      g.addColorStop(1, 'rgba(29,155,240,0)');
      x.beginPath();
      x.moveTo(X(0), Y(0));
      for (let s = 0; s <= supply; s += supply / 60) x.lineTo(X(s), Y(priceAt(s)));
      x.lineTo(X(supply), Y(priceAt(supply)));
      x.lineTo(X(supply), Y(0));
      x.closePath();
      x.fillStyle = g;
      x.fill();
      x.beginPath();
      for (let s = 0; s <= maxS; s += maxS / 140) {
        const px = X(s),
          py = Y(priceAt(s));
        if (s) x.lineTo(px, py);
        else x.moveTo(px, py);
      }
      x.strokeStyle = '#1D9BF0';
      x.lineWidth = 2.4;
      x.stroke();
      const mx = X(supply),
        my = Y(priceAt(supply));
      x.setLineDash([3, 4]);
      x.strokeStyle = 'rgba(15,20,25,.3)';
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(mx, my);
      x.lineTo(mx, Y(0));
      x.stroke();
      x.setLineDash([]);
      x.beginPath();
      x.arc(mx, my, 9, 0, Math.PI * 2);
      x.fillStyle = 'rgba(29,155,240,.18)';
      x.fill();
      x.beginPath();
      x.arc(mx, my, 5, 0, Math.PI * 2);
      x.fillStyle = '#0F1419';
      x.fill();
      x.lineWidth = 2.5;
      x.strokeStyle = '#fff';
      x.stroke();
    };
    draw();
    window.addEventListener('resize', draw);
    // Redraw once Inter has loaded so axis labels use it.
    document.fonts?.ready.then(draw).catch(() => null);
    return () => window.removeEventListener('resize', draw);
  }, [supply, F]);
  return <canvas id="curve" ref={ref} aria-label="Bonding curve chart" />;
}
