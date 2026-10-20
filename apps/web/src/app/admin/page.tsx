'use client';
/** [B] Admin panel: reports, claim/takedown requests, members (bot flag, admin) and markets (halt, open fan market). */
import { MARKET_CATEGORIES, minutesSince, type AdminReportDTO, type MarketCategory, type ReportStatus } from '@sway/shared';
import { unitsToKeys } from '@sway/curve';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { Avatar, Empty, Loading, NeedUser, Tabs, VB } from '@/components/ui';
import { MediaGrid } from '@/components/views/Post';
import { errorMessage, getApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { refreshPosts, sk } from '@/lib/social';
import { toast } from '@/lib/store';

type Tab = 'reports' | 'claims' | 'members' | 'markets';
const api = () => getApi();

const REASON: Record<string, string> = { spam: 'Spam', abuse: 'Abuse', impersonation: 'Impersonation', other: 'Other' };
const CATEGORY: Record<MarketCategory, string> = { creators: 'Creators', crypto: 'Crypto', football: 'Football', stocks: 'Stocks', rwa: 'RWA' };

/** Runs an admin call with a busy flag, a toast and a refetch. */
function useRun() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, ok: string, after?: () => void) => {
    setBusy(key);
    try {
      await fn();
      toast(ok);
      await qc.invalidateQueries({ queryKey: ['admin'] });
      after?.();
    } catch (e) {
      toast(errorMessage(e));
    }
    setBusy(null);
  };
  return { busy, run, qc };
}

function Card({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <div className="glass adm-card" data-id={id}>
      {children}
    </div>
  );
}

function ReportCard({ r }: { r: AdminReportDTO }) {
  const F = useFormat();
  const { busy, run, qc } = useRun();
  const act = (action: 'hide' | 'dismiss' | 'flag', ok: string) =>
    run(r.id + action, () => api().adminResolveReport(r.id, { action }), ok, () => action === 'hide' && refreshPosts(qc));
  const p = r.post;
  return (
    <Card id={r.id}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', fontSize: 14 }}>
        <span className="tag pink">{REASON[r.reason] ?? r.reason}</span>
        <span className="t2">
          <Link href={`/${r.reporter.handle}`}>
            <b style={{ color: 'var(--tx)' }}>@{r.reporter.handle}</b>
          </Link>{' '}
          reported {p ? 'a post by' : 'the account'}{' '}
          {r.target && (
            <Link href={`/${r.target.handle}`}>
              <b style={{ color: 'var(--tx)' }}>@{r.target.handle}</b>
            </Link>
          )}{' '}
          · {F.ago(minutesSince(r.createdAt))}
        </span>
        {r.target?.botFlag && <span className="tag warn">Bot flagged</span>}
      </div>
      {r.note && <p className="adm-note">“{r.note}”</p>}
      {p && (
        <div className="adm-post">
          <div className="row" style={{ gap: 6, marginBottom: 6 }}>
            {p.visibility !== 'public' && <span className="tag">{p.visibility === 'holders' ? 'Holders' : 'Subscribers'}</span>}
            {p.hidden && <span className="tag warn">Hidden</span>}
            {p.deleted && <span className="tag line">Deleted</span>}
            <Link className="lnk" style={{ fontSize: 13, marginLeft: 'auto' }} href={`/post/${p.id}`}>
              Open post
            </Link>
          </div>
          {p.text && <div className="post-t" style={{ margin: 0 }}>{p.text}</div>}
          <MediaGrid media={p.media} />
        </div>
      )}
      {r.status === 'open' ? (
        <div className="adm-acts">
          {p && !p.hidden && !p.deleted && (
            <button className="btn btn-white btn-sm" disabled={!!busy} onClick={() => act('hide', 'Post hidden')}>
              <Icon name="eyeOff" />
              Hide post
            </button>
          )}
          <button className="btn btn-glass btn-sm" disabled={!!busy} onClick={() => act('dismiss', 'Report dismissed')}>
            Dismiss
          </button>
          {r.target && !r.target.botFlag && (
            <button className="btn btn-glass btn-sm" disabled={!!busy} onClick={() => act('flag', `@${r.target!.handle} flagged as a bot`)}>
              <Icon name="flag" />
              Flag author as bot
            </button>
          )}
        </div>
      ) : (
        <div className="t3" style={{ fontSize: 13, marginTop: 8 }}>{r.status === 'actioned' ? 'Actioned' : 'Dismissed'}</div>
      )}
    </Card>
  );
}

function Reports() {
  const [status, setStatus] = useState<ReportStatus>('open');
  const { data } = useQuery({ queryKey: sk.admin('reports', status), queryFn: () => api().adminReports({ status }) });
  return (
    <>
      <div className="pad">
        <div className="seg">
          {(['open', 'actioned', 'dismissed'] as const).map((s) => (
            <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {!data ? (
        <Loading />
      ) : data.length ? (
        data.map((r) => <ReportCard key={r.id} r={r} />)
      ) : (
        <Empty icon="check" title={status === 'open' ? 'No open reports' : 'Nothing here'}>
          {status === 'open' ? 'New reports from members land here.' : ''}
        </Empty>
      )}
    </>
  );
}

function Claims() {
  const F = useFormat();
  const { data } = useQuery({ queryKey: sk.admin('claims'), queryFn: () => api().adminClaims({ status: 'open' }) });
  const { busy, run } = useRun();
  if (!data) return <Loading />;
  if (!data.length)
    return (
      <Empty icon="check" title="No open requests">
        Claim reviews and takedown requests from fan market pages land here.
      </Empty>
    );
  return (
    <>
      {data.map((c) => (
        <Card key={c.id} id={c.id}>
          <div className="row">
            <Avatar u={c.market} size={40} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="nm">
                <b>{c.market.name}</b>
                <span className={`tag ${c.kind === 'takedown' ? 'pink' : ''}`}>{c.kind === 'takedown' ? 'Takedown' : 'Claim review'}</span>
                {c.market.halted && <span className="tag warn">Halted</span>}
              </div>
              <div className="hd" style={{ fontSize: 14 }}>
                @{c.market.handle} · {F.ago(minutesSince(c.createdAt))}
                {c.from ? ` · from @${c.from.handle}` : ''}
              </div>
            </div>
          </div>
          <div className="params adm-kv">
            <div>
              <span>Contact</span>
              <span>{c.contact}</span>
            </div>
            {c.note && (
              <div>
                <span>Note</span>
                <span>{c.note}</span>
              </div>
            )}
          </div>
          <div className="adm-acts">
            <button className="btn btn-white btn-sm" disabled={!!busy} onClick={() => run(c.id, () => api().adminResolveClaim(c.id), 'Marked resolved')}>
              <Icon name="check" />
              Mark resolved
            </button>
            {c.kind === 'takedown' && !c.market.halted && (
              <button
                className="btn btn-glass btn-sm"
                disabled={!!busy}
                onClick={() => run(c.id + 'h', () => api().adminHaltMarket(c.market.handle, { halted: true }), 'Halt sent onchain')}
              >
                Halt buys
              </button>
            )}
          </div>
        </Card>
      ))}
    </>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="pad">
      <div className="search">
        <Icon name="search" />
        <input className="field" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />
      </div>
    </div>
  );
}

function Members() {
  const [q, setQ] = useState('');
  const me = useMe().data;
  const { data } = useQuery({ queryKey: sk.admin('members', q.trim()), queryFn: () => api().adminMembers({ q: q.trim() || undefined }), placeholderData: (d) => d });
  const { busy, run } = useRun();
  return (
    <>
      <SearchBox value={q} onChange={setQ} placeholder="Search members" />
      {!data ? (
        <Loading />
      ) : (
        data.map((m) => (
          <div key={m.id} className="tr adm-row" data-handle={m.handle}>
            <Link href={`/${m.handle}`} className="row" style={{ minWidth: 0 }}>
              <Avatar u={m} size={38} />
              <div style={{ minWidth: 0 }}>
                <div className="nm">
                  <b>{m.name}</b>
                  <VB v={m.verified} off={m.official} />
                  {m.isAdmin && <span className="tag">Admin</span>}
                  {m.botFlag && <span className="tag warn">Bot{m.botReason && m.botReason !== 'admin' ? `: ${m.botReason}` : ''}</span>}
                  {m.deleted && <span className="tag line">Deleted</span>}
                </div>
                <div className="hd" style={{ fontSize: 14 }}>
                  @{m.handle}
                  {m.memberNo ? ` · #${m.memberNo}` : ''} · score {m.score}
                </div>
              </div>
            </Link>
            <div className="adm-acts" style={{ margin: 0 }}>
              <button
                className="btn btn-glass btn-sm"
                disabled={!!busy}
                onClick={() => run(m.id + 'b', () => api().adminBotFlag(m.handle, { flagged: !m.botFlag }), m.botFlag ? 'Bot flag removed' : 'Flagged as a bot')}
              >
                {m.botFlag ? 'Unflag bot' : 'Flag bot'}
              </button>
              {!m.deleted && m.handle !== me?.user.handle && (
                <button
                  className="btn btn-glass btn-sm"
                  disabled={!!busy}
                  onClick={() => run(m.id + 'a', () => api().adminSetAdmin(m.handle, { admin: !m.isAdmin }), m.isAdmin ? 'Admin removed' : 'Admin granted')}
                >
                  {m.isAdmin ? 'Remove admin' : 'Make admin'}
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </>
  );
}

function FanMarketForm() {
  const [f, setF] = useState({ handle: '', name: '', xId: '', followers: '', category: 'crypto' as MarketCategory });
  const { busy, run } = useRun();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const ok = !!f.handle.trim() && (!f.xId.trim() || /^\d{1,20}$/.test(f.xId.trim()));
  return (
    <div className="glass adm-card" id="fanform">
      <b style={{ fontSize: 16 }}>Open a fan market</b>
      <p className="t2" style={{ fontSize: 13.5, margin: '4px 0 12px' }}>
        For an X account that hasn’t joined. Creates the profile and calls openFanMarket onchain; the creator fee is escrowed until the owner claims. Only the handle is needed: name, X user id, followers and avatar are read from X when left empty.
      </p>
      <div className="grid2">
        <div>
          <label className="lbl" htmlFor="fm-h">
            X handle
          </label>
          <input className="field" id="fm-h" placeholder="@handle" value={f.handle} onChange={set('handle')} />
        </div>
        <div>
          <label className="lbl" htmlFor="fm-n">
            Name
          </label>
          <input className="field" id="fm-n" placeholder="From X" value={f.name} onChange={set('name')} />
        </div>
        <div>
          <label className="lbl" htmlFor="fm-x">
            X user id
          </label>
          <input className="field" id="fm-x" inputMode="numeric" placeholder="From X" value={f.xId} onChange={set('xId')} />
        </div>
        <div>
          <label className="lbl" htmlFor="fm-f">
            Followers
          </label>
          <input className="field" id="fm-f" inputMode="numeric" placeholder="From X" value={f.followers} onChange={set('followers')} />
        </div>
      </div>
      <label className="lbl" htmlFor="fm-c" style={{ marginTop: 12 }}>
        Category
      </label>
      <select className="field" id="fm-c" value={f.category} onChange={set('category')} style={{ marginBottom: 14 }}>
        {MARKET_CATEGORIES.filter((c) => c !== 'creators').map((c) => (
          <option key={c} value={c}>
            {CATEGORY[c]}
          </option>
        ))}
      </select>
      <button
        className="btn btn-white btn-block"
        disabled={!ok || !!busy}
        onClick={() =>
          run(
            'fan',
            () =>
              api().adminOpenFanMarket({
                handle: f.handle.trim(),
                name: f.name.trim() || undefined,
                xId: f.xId.trim() || undefined,
                followers: f.followers.trim() ? parseInt(f.followers.replace(/[^0-9]/g, '')) || 0 : undefined,
                category: f.category,
              }),
            `Fan market for @${f.handle.trim().replace(/^@/, '')} opened`,
            () => setF({ handle: '', name: '', xId: '', followers: '', category: f.category }),
          )
        }
      >
        Open fan market
      </button>
    </div>
  );
}

function Markets() {
  const [q, setQ] = useState('');
  const F = useFormat();
  const { data } = useQuery({
    queryKey: sk.admin('markets', q.trim()),
    queryFn: () => api().adminMarkets({ q: q.trim() || undefined }),
    placeholderData: (d) => d,
    // A fan market shows as opening until the indexer sees MarketOpened.
    refetchInterval: (qq) => (qq.state.data?.some((m) => !m.opened) ? 3000 : false),
  });
  const { busy, run, qc } = useRun();
  // The indexer mirrors MarketHalted a block or two after the receipt.
  const later = () => [2500, 6000, 12000].forEach((ms) => setTimeout(() => qc.invalidateQueries({ queryKey: ['admin'] }), ms));
  return (
    <>
      <FanMarketForm />
      <SearchBox value={q} onChange={setQ} placeholder="Search markets" />
      {!data ? (
        <Loading />
      ) : (
        data.map((m) => (
          <div key={m.subject} className="tr adm-row" data-handle={m.handle}>
            <Link href={`/${m.handle}`} className="row" style={{ minWidth: 0 }}>
              <Avatar u={m} size={38} />
              <div style={{ minWidth: 0 }}>
                <div className="nm">
                  <b>{m.name}</b>
                  <span className="tag line">{CATEGORY[m.category]}</span>
                  {!m.claimed && <span className="tag warn">Unclaimed</span>}
                  {m.halted && <span className="tag pink">Halted</span>}
                  {!m.opened && <span className="tag line">Opening…</span>}
                </div>
                <div className="hd" style={{ fontSize: 14 }}>
                  @{m.handle} · {F.keys(unitsToKeys(m.supplyUnits))} key{unitsToKeys(m.supplyUnits) === 1 ? '' : 's'} · {m.holders} holder{m.holders === 1 ? '' : 's'}
                </div>
              </div>
            </Link>
            <button
              className={`btn ${m.halted ? 'btn-glass' : 'btn-sell'} btn-sm`}
              disabled={!!busy || !m.opened}
              onClick={() =>
                run(m.subject, () => api().adminHaltMarket(m.handle, { halted: !m.halted }), m.halted ? 'Unhalt sent onchain' : 'Halt sent onchain', later)
              }
            >
              {busy === m.subject ? 'Sending…' : m.halted ? 'Unhalt' : 'Halt'}
            </button>
          </div>
        ))
      )}
    </>
  );
}

export default function AdminPage() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('reports');
  if (me.isPending) return <Loading />;
  if (!me.data) return <NeedUser title="Admins only" text="Connect X with an admin account." />;
  if (!me.data.isAdmin)
    return (
      <Empty icon="shield" title="Admins only">
        Your account doesn’t have access to the admin panel.
      </Empty>
    );
  return (
    <>
      <Tabs<Tab>
        items={[
          ['reports', 'Reports'],
          ['claims', 'Claims & takedowns'],
          ['members', 'Members'],
          ['markets', 'Markets'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'reports' && <Reports />}
      {tab === 'claims' && <Claims />}
      {tab === 'members' && <Members />}
      {tab === 'markets' && <Markets />}
    </>
  );
}
