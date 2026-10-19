'use client';
/** [B] Profile additions: the "···" menu (report, block), the blocked note and the chart card switch. */
import { CURVE, unitsToKeys } from '@sway/curve';
import type { HistoryRange, ProfileDTO } from '@sway/shared';
import { useEffect, useRef, useState } from 'react';
import { useFormat } from '@/lib/format';
import { usePriceHistory, useSocialActions } from '@/lib/social';
import { toast } from '@/lib/store';
import { Icon } from '../icons';
import { CurveChart } from './CurveChart';
import { PriceChart } from './PriceChart';

export function ProfileMenu({ c }: { c: ProfileDTO }) {
  const [open, setOpen] = useState(false);
  const s = useSocialActions();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <span className="pm-wrap" ref={box}>
      <button className="btn btn-glass btn-sm" aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} style={{ padding: '0 9px' }}>
        <Icon name="dots" size={16} />
      </button>
      {open && (
        <div className="pmenu" role="menu" aria-label="Profile menu">
          <button
            className="pmi"
            role="menuitem"
            onClick={run(() => {
              navigator.clipboard?.writeText(`${window.location.origin}/${c.handle}`).catch(() => null);
              toast('Link copied');
            })}
          >
            <Icon name="link" />
            Copy profile link
          </button>
          <button className="pmi" role="menuitem" onClick={run(() => s.openReport({ handle: c.handle }))}>
            <Icon name="flag" />
            Report @{c.handle}
          </button>
          {!c.official && (
            <button className="pmi" role="menuitem" onClick={run(() => s.block(c.handle))}>
              <Icon name="block" />
              {c.blocked ? `Unblock @${c.handle}` : `Block @${c.handle}`}
            </button>
          )}
        </div>
      )}
    </span>
  );
}

export function BlockedNote({ handle }: { handle: string }) {
  const s = useSocialActions();
  return (
    <div className="note blk" role="status">
      <Icon name="block" />
      <span style={{ flex: 1 }}>
        <b>You blocked @{handle}.</b> Their posts and replies are hidden from your feeds, and neither of you can message the other.
      </span>
      <button className="btn btn-glass btn-sm" onClick={() => s.block(handle)}>
        Unblock
      </button>
    </div>
  );
}

type Mode = 'curve' | 'price';

/** Bonding curve | Price switch, with 1H / 1D / 7D chips for the price history. */
export function ChartCard({ c }: { c: ProfileDTO }) {
  const F = useFormat();
  const [mode, setMode] = useState<Mode>('curve');
  const [range, setRange] = useState<HistoryRange>('1d');
  const hist = usePriceHistory(c.handle, range, mode === 'price');
  return (
    <div className="glass chart-card">
      <div className="between">
        <div className="seg seg-sm" role="tablist" aria-label="Chart">
          <button role="tab" aria-selected={mode === 'curve'} className={mode === 'curve' ? 'on' : ''} onClick={() => setMode('curve')}>
            Bonding curve
          </button>
          <button role="tab" aria-selected={mode === 'price'} className={mode === 'price' ? 'on' : ''} onClick={() => setMode('price')}>
            Price
          </button>
        </div>
        {mode === 'curve' ? (
          <span className="t3 hm" style={{ fontSize: 12 }}>
            price = {CURVE.K} × (supply + {CURVE.O})² ETH
          </span>
        ) : (
          <div className="row" style={{ gap: 6 }}>
            {(['1h', '1d', '7d'] as const).map((r) => (
              <button key={r} className={`chip chip-sm ${range === r ? 'on' : ''}`} aria-pressed={range === r} onClick={() => setRange(r)}>
                {r.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>
      {mode === 'curve' ? (
        <>
          <CurveChart supply={unitsToKeys(c.supplyUnits)} F={F} />
          <div className="legend">
            <span>
              <i style={{ background: '#1D9BF0' }} />
              Curve
            </span>
            <span>
              <i style={{ background: 'var(--tx)' }} />
              Current supply
            </span>
          </div>
        </>
      ) : (
        <>
          <PriceChart data={hist.data} F={F} />
          <div className="legend">
            <span>
              <i style={{ background: '#0F1419' }} />
              Now
            </span>
            <span>{hist.data ? `${Math.max(0, hist.data.points.length - 2)} trade${hist.data.points.length === 3 ? '' : 's'} in ${range.toUpperCase()}` : 'Loading…'}</span>
          </div>
        </>
      )}
    </div>
  );
}
