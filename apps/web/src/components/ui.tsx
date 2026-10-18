'use client';
/** Prototype primitives: avatar, verified badge, voiceprint, sparkline, countdowns, empty states, tabs. */
import { hash, hueOf, type UserRef } from '@sway/shared';
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { useClock, openModal } from '@/lib/store';
import { dicebear, initials, rng } from '@/lib/util';
import { Icon, Logo, type IconName } from './icons';

type AvatarUser = Pick<UserRef, 'handle' | 'name'> & Partial<Pick<UserRef, 'avatarUrl' | 'official' | 'claimed'>>;

export function Avatar({ u, size = 40 }: { u: AvatarUser; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (u.official)
    return (
      <span className="av official" style={{ width: size, height: size }}>
        <Logo size={Math.round(size * 0.5)} />
      </span>
    );
  const style = { width: size, height: size, '--avh': hueOf(u.handle) } as CSSProperties;
  return (
    <span className="av" style={style}>
      <span className="av-ini" style={{ fontSize: Math.round(size * 0.36) }}>
        {initials(u.name || u.handle, u.handle)}
      </span>
      {!failed && <img src={u.avatarUrl || dicebear(u.handle, u.claimed)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
    </span>
  );
}

export function VB({ v, off }: { v?: boolean; off?: boolean }) {
  if (!v) return null;
  return (
    <span className={`vb ${off ? 'off' : ''}`} title={off ? 'Official Sway account' : 'Verified on X'}>
      <Icon name="verified" />
    </span>
  );
}

/** Deterministic voice-bars graphic (prototype voiceprint()). */
export function Voiceprint({ seed, score = 60, bars = 56, id }: { seed: string; score?: number; bars?: number; id?: string }) {
  const r = rng(hash(seed));
  const gid = 'g' + String(id || hash(seed + bars).toString(36));
  const w = 100 / bars;
  const rects: ReactNode[] = [];
  for (let i = 0; i < bars; i++) {
    const x = i / (bars - 1);
    const env = Math.pow(Math.sin(Math.PI * x), 0.8) * 0.78 + 0.22;
    const h = Math.max(7, env * (0.35 + r() * 0.65) * (34 + score * 0.66));
    rects.push(
      <rect
        key={i}
        x={(i * w + w * 0.22).toFixed(2)}
        y={(50 - h / 2).toFixed(2)}
        width={(w * 0.56).toFixed(2)}
        height={h.toFixed(2)}
        rx={(w * 0.28).toFixed(2)}
        style={{ animationDelay: `${(-(r() * 2.4)).toFixed(2)}s` }}
      />,
    );
  }
  return (
    <svg className="vp" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" x2="1">
          <stop offset="0" stopColor="#1D9BF0" />
          <stop offset=".5" stopColor="#7856FF" />
          <stop offset="1" stopColor="#1D9BF0" />
        </linearGradient>
      </defs>
      <g fill={`url(#${gid})`}>{rects}</g>
    </svg>
  );
}

export function Spark({ arr, up }: { arr: number[]; up: boolean }) {
  const id = 'sp' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const data = arr.length > 1 ? arr : [arr[0] ?? 0, arr[0] ?? 0];
  const min = Math.min(...data),
    max = Math.max(...data),
    rg = max - min || 1;
  const d = data.map((v, i) => (i ? 'L' : 'M') + ((i / (data.length - 1)) * 100).toFixed(1) + ' ' + (90 - ((v - min) / rg) * 80).toFixed(1)).join(' ');
  const col = up ? '#00BA7C' : '#F4212E';
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={col} stopOpacity=".28" />
          <stop offset="1" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L100 100 L0 100Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={col} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** "14h 05m 09s" ticking every second (prototype [data-cd]). */
export function Countdown({ to }: { to: string | number | null }) {
  const now = useClock((s) => s.now);
  if (to === null) return null;
  const d = Math.max(0, new Date(to).getTime() - now) / 1000;
  const h = Math.floor(d / 3600),
    m = Math.floor((d % 3600) / 60),
    s = Math.floor(d % 60);
  return <span>{d <= 0 ? 'ended' : `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`}</span>;
}

/** Days / hours / min / sec boxes (prototype [data-cdbox]). */
export function CountdownBoxes({ to, style }: { to: string | number; style?: CSSProperties }) {
  const now = useClock((s) => s.now);
  const d = Math.max(0, new Date(to).getTime() - now) / 1000;
  const parts: Array<[number, string]> = [
    [Math.floor(d / 86400), 'days'],
    [Math.floor((d % 86400) / 3600), 'hours'],
    [Math.floor((d % 3600) / 60), 'min'],
    [Math.floor(d % 60), 'sec'],
  ];
  return (
    <div className="cd" style={style}>
      {parts.map(([v, l]) => (
        <div key={l}>
          <b>{String(v).padStart(2, '0')}</b>
          <small>{l}</small>
        </div>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-ic">
        <Icon name={icon} />
      </div>
      <h4>{title}</h4>
      {children}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

/** Prototype needUser(): the Connect X empty state for signed-out views. */
export function NeedUser({ title, text }: { title: string; text: string }) {
  return (
    <Empty
      icon="x"
      title={title}
      action={
        <button className="btn btn-white" onClick={() => openModal({ type: 'connect' })}>
          <Icon name="x" />
          Connect X
        </button>
      }
    >
      {text}
    </Empty>
  );
}

export function Tabs<T extends string>({ items, value, onChange, bordered = true }: { items: Array<[T, string]>; value: T; onChange: (v: T) => void; bordered?: boolean }) {
  return (
    <div className="tabs" role="tablist" style={bordered ? { borderBottom: '1px solid var(--stroke)' } : undefined}>
      {items.map(([k, l]) => (
        <button key={k} className={`tab ${value === k ? 'on' : ''}`} role="tab" aria-selected={value === k} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ size, color }: { size?: number; color?: string }) {
  return <span className="spin" style={{ ...(size ? { width: size, height: size } : {}), ...(color ? { color } : {}) }} />;
}

export function Loading() {
  return (
    <div className="load">
      <Spinner />
    </div>
  );
}
