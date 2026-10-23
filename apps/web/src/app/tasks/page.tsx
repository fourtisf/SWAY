'use client';
import { TIERS } from '@sway/scoring';
import type { TaskDTO } from '@sway/shared';
import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '@/components/icons';
import { StreakCard } from '@/components/engage/Engage'; // [D]
import { Loading, NeedUser, Spinner } from '@/components/ui';
import { useActions } from '@/lib/actions';
import { useFormat } from '@/lib/format';
import { useMe, useTasks } from '@/lib/queries';
import { toast } from '@/lib/store';

function Rules() {
  return (
    <div className="glass" style={{ margin: '16px 18px', padding: 18 }}>
      <h3 style={{ fontSize: 15, marginBottom: 6 }}>Where points come from</h3>
      {[
        ['Your Sway score', 'up to 10,000'],
        ['Each verified invite', '+500'],
        ['Keys you hold', '400K per ETH'],
        ['Keys you trade', '100K per ETH'],
        ['Daily check-in streak', 'up to 700 a day'],
        ['Battles won', 'both stakes'],
      ].map(([a, b]) => (
        <div key={a} className="between" style={{ padding: '9px 0', borderBottom: '1px solid var(--stroke)', fontSize: 13.5 }}>
          <span className="t2">{a}</span>
          <b>{b}</b>
        </div>
      ))}
      <p className="t3" style={{ fontSize: 12.5, margin: '12px 0 0' }}>
        Points are never edited by hand. Full rules are in the{' '}
        <Link className="lnk" href="/model" style={{ textDecoration: 'underline' }}>
          open model
        </Link>
        .
      </p>
    </div>
  );
}

const DONE = new Set(['verified', 'trusted', 'skipped']);

/**
 * One button at a time: the task's action first (Follow opens @swaydotfamily on X, Post opens a #SwayDaily
 * draft…), then Verify. The action stays as a small button in case X didn't open.
 */
function TaskRow({ t, handle }: { t: TaskDTO; handle: string }) {
  const F = useFormat();
  const { verifyTask, skipTask, shareCard } = useActions();
  const [went, setWent] = useState(false);
  const [busy, setBusy] = useState(false);
  const verify = async () => {
    setBusy(true);
    await verifyTask(t.id);
    setBusy(false);
  };
  const done = DONE.has(t.status);
  const lock = t.status === 'locked';
  const canGo = !!t.action && (!!t.actionUrl || t.id === 'card');
  const go = () => {
    if (t.actionUrl) window.open(t.actionUrl, '_blank', 'noopener');
    else shareCard();
    setWent(true);
  };
  return (
    <div className={`task ${done ? 'done' : ''} ${lock ? 'lock' : ''}`}>
      <div className="task-ic">{done ? <Icon name="check" /> : <Icon name={t.icon} />}</div>
      <div style={{ minWidth: 0 }}>
        <b>{t.title}</b>
        <div className="t3" style={{ fontSize: 12.5 }}>
          {t.group} {' '}+{F.int(t.pts)} pts
        </div>
        {went && !done && t.status !== 'pending' && (
          <div style={{ fontSize: 12.5, color: 'var(--blue)', fontWeight: 600 }}>Done on X as @{handle}? Tap Verify.</div>
        )}
      </div>
      <div>
        {done ? (
          t.status === 'skipped' ? (
            <span className="tag line">Skipped</span>
          ) : (
            <span className="tag aqua">Verified</span>
          )
        ) : lock ? (
          <span className="t3" style={{ fontSize: 12.5, fontWeight: 600 }}>
            Unlocks next
          </span>
        ) : t.auto ? (
          <Link className="btn btn-glass btn-sm" href="/explore">
            Find a key
          </Link>
        ) : (
          <div className="row" style={{ gap: 6 }}>
            {t.skippable && !went && (
              <button className="btn btn-glass btn-sm" onClick={() => skipTask(t.id)}>
                Skip
              </button>
            )}
            {canGo && (
              <button className={`btn btn-sm ${went ? 'btn-glass' : 'btn-white'}`} onClick={go}>
                {t.action}
              </button>
            )}
            {/* A task left 'pending' by an older release can be checked again right away. */}
            {(went || !canGo || t.status === 'pending') && (
              <button className="btn btn-white btn-sm" disabled={busy} onClick={verify} style={{ minWidth: 72 }}>
                {busy ? <Spinner size={14} /> : 'Verify'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TasksPage() {
  const me = useMe();
  const { data } = useTasks(!!me.data);
  const F = useFormat();
  // Toast when a pending verification lands (the API verifies asynchronously).
  const prev = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!data) return;
    for (const t of data.tasks) {
      if (prev.current[t.id] === 'pending' && (t.status === 'verified' || t.status === 'trusted')) toast(`Verified on X. +${F.int(t.pts)} pts`);
      // The worker hands a task back when X shows nothing yet or can't be read: say so, Verify is back.
      if (prev.current[t.id] === 'pending' && t.status === 'open') toast(`Couldn’t confirm “${t.title}” on X yet. Try Verify again in a bit.`);
      prev.current[t.id] = t.status;
    }
  }, [data, F]);
  if (me.isPending) return <Loading />;
  if (!me.data)
    return (
      <>
        <NeedUser title="Connect X to start earning" text="Your score alone is worth up to 10,000 points. Tasks, invites, keys and battles add the rest." />
        <Rules />
      </>
    );
  if (!data) return <Loading />;
  const handle = me.data.user.handle;
  const pts = data.points;
  const ref = data.inviteLink.replace(/^https?:\/\//, '');
  return (
    <>
      <div className="glass" style={{ margin: '16px 18px', padding: 18 }}>
        <div className="between">
          <div>
            <div className="t3" style={{ fontSize: 12.5, fontWeight: 600 }}>
              Your points
            </div>
            <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-.04em' }}>{F.int(pts.total)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span className="tag" style={{ height: 28, padding: '0 12px', fontSize: 13 }}>
              {pts.tier}
            </span>
            <div className="t3" style={{ fontSize: 12.5, marginTop: 6 }}>
              Rank #{F.int(pts.rank)}
            </div>
          </div>
        </div>
        <div className="track">
          {TIERS.map((x, i) => (
            <i key={x.name} style={{ '--w': `${i < pts.tierIndex ? 100 : i === pts.tierIndex ? Math.round(pts.progress * 100) : 0}%` } as CSSProperties}>
              <b />
            </i>
          ))}
        </div>
        <div className="between t3" style={{ fontSize: 11.5, fontWeight: 600 }}>
          {TIERS.map((x) => (
            <span key={x.name}>{x.name}</span>
          ))}
        </div>
        {pts.nextTier && (
          <p className="t2" style={{ fontSize: 13, margin: '10px 0 0' }}>
            {F.int(pts.toNext)} points to {pts.nextTier}.
          </p>
        )}
      </div>
      <StreakCard />
      <div className="sec-h" style={{ paddingTop: 6 }}>
        <h2>Tasks</h2>
        <span className="t3" style={{ fontSize: 12.5 }}>
          Checked on your X account <b>@{handle}</b>
        </span>
      </div>
      <div style={{ borderTop: '1px solid var(--stroke)' }}>
        {data.tasks.map((t) => (
          <TaskRow key={t.id} t={t} handle={handle} />
        ))}
      </div>
      <div className="glass" style={{ margin: '16px 18px 0', padding: 18 }}>
        <h3 style={{ fontSize: 15 }}>Invite friends</h3>
        <p className="t2" style={{ fontSize: 13.5, margin: '4px 0 14px' }}>
          +500 when an invited account with an X checkmark joins, and they get +100. You also earn 0.5% of every key trade they make.
        </p>
        <div className="row">
          <input className="field" readOnly value={ref} aria-label="Your invite link" />
          <button
            className="btn btn-glass"
            style={{ height: 44 }}
            onClick={() => {
              navigator.clipboard?.writeText(/^https?:/.test(data.inviteLink) ? data.inviteLink : 'https://' + data.inviteLink).catch(() => null);
              toast('Invite link copied');
            }}
          >
            <Icon name="copy" />
            Copy
          </button>
        </div>
        <Link className="lnk t2" href="/referrals" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 12, fontSize: 13.5, fontWeight: 600 }}>
          See who joined and what you earned
          <Icon name="chevR" size={16} />
        </Link>
      </div>
      <Rules />
    </>
  );
}
