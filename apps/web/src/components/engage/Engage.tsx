'use client';
/** [D] Watch button with price alerts, the daily streak card, and the Appearance / Notifications settings. */
import { useEffect, useRef, useState } from 'react';
import type { NotificationPrefs } from '@sway/shared';
import { Icon } from '@/components/icons';
import { Spinner } from '@/components/ui';
import { useEngageActions, useNotifPrefs, usePushConfig, useStreak, useWatchlist } from '@/lib/engage';
import { useFormat } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { pushSupported } from '@/lib/push';
import { useTheme, type ThemePref } from '@/lib/theme';

const ALERTS = [0, 5, 10, 25] as const;

/** Profile action: watch a key and pick the move (±%) that sends a price alert. */
export function WatchButton({ handle }: { handle: string }) {
  const me = useMe().data;
  const list = useWatchlist(!!me).data;
  const act = useEngageActions();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const w = list?.items.find((x) => x.handle === handle);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="watch" ref={ref}>
      <button
        className={`btn btn-glass btn-sm btn-icon ${w ? 'on' : ''}`}
        aria-label={w ? `Watching @${handle}` : `Watch @${handle}`}
        aria-expanded={open}
        title={w ? (w.alertPct ? `Alert at ±${w.alertPct}%` : 'Watching') : 'Watch this key'}
        onClick={() => (me ? setOpen((o) => !o) : act.watch(handle, 10))}
      >
        <Icon name={w ? 'starF' : 'star'} />
      </button>
      {open && (
        <div className="watch-pop" role="menu">
          <div className="t3" style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>
            Alert me when the price moves
          </div>
          <div className="quick">
            {ALERTS.map((p) => (
              <button
                key={p}
                role="menuitemradio"
                aria-checked={w?.alertPct === p}
                className={`chip ${w?.alertPct === p ? 'on' : ''}`}
                onClick={async () => {
                  if (await act.watch(handle, p)) setOpen(false);
                }}
              >
                {p ? `±${p}%` : 'No alert'}
              </button>
            ))}
          </div>
          {w && (
            <button
              className="btn btn-glass btn-sm btn-block"
              style={{ marginTop: 10 }}
              onClick={async () => {
                await act.unwatch(handle);
                setOpen(false);
              }}
            >
              Remove from watchlist
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Tasks page: check in once a UTC day; n × 100 points up to day 7. */
export function StreakCard() {
  const me = useMe().data;
  const F = useFormat();
  const { data: s } = useStreak(!!me);
  const act = useEngageActions();
  const [busy, setBusy] = useState(false);
  if (!me || !s) return null;
  const filled = Math.min(s.days, s.capDays);
  return (
    <div className="glass streak" id="streak">
      <div className="streak-ic">
        <Icon name="flame" />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <b>{s.days ? `${s.days}-day streak` : 'Start a daily streak'}</b>
        <div className="t3" style={{ fontSize: 12.5 }}>
          {s.checkedInToday ? `Come back tomorrow for +${F.int(s.nextPoints)} pts` : `Check in today for +${F.int(s.nowPoints)} pts · day ${s.capDays} pays the most`}
        </div>
        <div className="streak-dots" aria-hidden>
          {Array.from({ length: s.capDays }, (_, i) => (
            <i key={i} className={i < filled ? 'on' : !s.checkedInToday && i === filled ? 'next' : ''} />
          ))}
        </div>
      </div>
      {s.checkedInToday ? (
        <span className="tag aqua">Checked in</span>
      ) : (
        <button
          className="btn btn-white btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await act.checkIn();
            setBusy(false);
          }}
        >
          {busy ? <Spinner /> : `Check in +${F.int(s.nowPoints)}`}
        </button>
      )}
    </div>
  );
}

const THEMES: Array<[ThemePref, string, 'sun' | 'moon' | 'gear']> = [
  ['light', 'Light', 'sun'],
  ['dark', 'Dark', 'moon'],
  ['system', 'System', 'gear'],
];

export function AppearanceSettings() {
  const [theme, setTheme] = useTheme();
  return (
    <>
      <div className="sec-h">
        <h2>Appearance</h2>
      </div>
      <div className="glass set-card set-pad">
        <div className="seg seg-wide" role="radiogroup" aria-label="Theme">
          {THEMES.map(([v, label, icon]) => (
            <button key={v} role="radio" aria-checked={theme === v} className={theme === v ? 'on' : ''} onClick={() => setTheme(v)}>
              <Icon name={icon} /> {label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

const PREF_ROWS: Array<[keyof NotificationPrefs, string, string]> = [
  ['trade', 'Trades', 'Someone buys or sells your key, tips, subscriptions'],
  ['alerts', 'Price alerts', 'Keys on your watchlist move past your alert'],
  ['mention', 'Mentions and replies', 'Someone mentions you or replies to your post'],
  ['battle', 'Battles', 'Challenges, results and backing payouts'],
  ['points', 'Points and drops', 'Points credited, airdrops from creators, Sway news'],
];

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button className={`tgl ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

export function NotificationSettings() {
  const me = useMe().data;
  const { data: prefs } = useNotifPrefs(!!me);
  const push = usePushConfig().data;
  const act = useEngageActions();
  const [here, setHere] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void act.pushOnHere().then(setHere);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push?.subscriptions]);
  if (!prefs) return null;
  const supported = pushSupported();
  return (
    <>
      <div className="sec-h">
        <h2>Notifications</h2>
      </div>
      <div className="glass set-card" id="notif-prefs">
        {PREF_ROWS.map(([k, label, hint]) => (
          <div key={k} className="pref-r">
            <div style={{ minWidth: 0 }}>
              <b>{label}</b>
              <div className="t3">{hint}</div>
            </div>
            <Toggle on={prefs[k]} label={label} onChange={(v) => act.setPrefs({ [k]: v })} />
          </div>
        ))}
        <div className="pref-r">
          <div style={{ minWidth: 0 }}>
            <b>Push notifications</b>
            <div className="t3">
              {!push?.enabled
                ? 'Not available on this server yet.'
                : !supported
                  ? 'This browser can’t receive push notifications.'
                  : here
                    ? 'On for this browser. Muted types above are never pushed.'
                    : 'Get notified on this device even when Sway is closed.'}
            </div>
          </div>
          <Toggle
            on={!!here && prefs.push}
            label="Push notifications"
            onChange={async (v) => {
              if (busy) return;
              setBusy(true);
              if (v) {
                const ok = await act.enablePush(push?.publicKey ?? null);
                if (ok && !prefs.push) await act.setPrefs({ push: true });
                setHere(ok || here);
              } else {
                await act.disablePush();
                setHere(false);
              }
              setBusy(false);
            }}
          />
        </div>
        {here && prefs.push && (
          <div className="set-pad" style={{ paddingTop: 0 }}>
            <button className="btn btn-glass btn-sm" onClick={() => act.pushTest()}>
              <Icon name="bell" /> Send a test notification
            </button>
          </div>
        )}
      </div>
    </>
  );
}
