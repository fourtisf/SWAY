'use client';
/** [B] Settings: account info, blocked accounts, data export, log out and account deletion. */
import { deleteConfirmText } from '@sway/shared';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AppearanceSettings, NotificationSettings } from '@/components/engage/Engage'; // [D]
import { Icon } from '@/components/icons';
import { Avatar, Loading, NeedUser, VB } from '@/components/ui';
import { errorMessage, getApi } from '@/lib/api';
import { MOCK } from '@/lib/env';
import { invalidateAll, qk, useMe } from '@/lib/queries';
import { useAccount, useSocialActions } from '@/lib/social';
import { toast } from '@/lib/store';
import { socket } from '@/lib/ws';

function useSignOut() {
  const qc = useQueryClient();
  const router = useRouter();
  return async (msg?: string) => {
    qc.setQueryData(qk.me, null);
    await invalidateAll(qc);
    if (!MOCK) socket.restart();
    router.push('/');
    if (msg) toast(msg);
  };
}

export default function SettingsPage() {
  const me = useMe();
  const acct = useAccount(!!me.data).data;
  const s = useSocialActions();
  const signOut = useSignOut();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<'export' | 'delete' | 'logout' | null>(null);
  if (me.isPending) return <Loading />;
  if (!me.data) return <NeedUser title="Connect X to see your settings" text="Your account, your data and how to delete it live here." />;
  const u = me.data.user;
  const phrase = deleteConfirmText(u.handle);

  const download = async () => {
    setBusy('export');
    try {
      const data = await getApi().exportData();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `sway-${u.handle}-export.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast('Your data is downloading');
    } catch (e) {
      toast(errorMessage(e));
    }
    setBusy(null);
  };

  const logout = async () => {
    setBusy('logout');
    await getApi()
      .logout()
      .catch(() => null);
    await signOut();
  };

  const del = async () => {
    setBusy('delete');
    try {
      await getApi().deleteAccount({ confirm: confirm.trim() });
      await signOut('Your account was deleted');
    } catch (e) {
      toast(errorMessage(e));
      setBusy(null);
    }
  };

  return (
    <div className="settings">
      <div className="sec-h">
        <h2>Account</h2>
      </div>
      <div className="glass set-card">
        <div className="row" style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
          <Avatar u={u} size={48} />
          <div style={{ minWidth: 0 }}>
            <div className="nm">
              <b style={{ fontSize: 16 }}>{u.name}</b>
              <VB v={u.verified} />
              {me.data.isAdmin && <span className="tag">Admin</span>}
            </div>
            <div className="hd">@{u.handle}</div>
          </div>
        </div>
        <div className="params set-rows">
          <div>
            <span>Handle</span>
            <span>@{u.handle}</span>
          </div>
          <div>
            <span>Member</span>
            <span>#{acct?.memberNo ?? u.memberNo}</span>
          </div>
          <div>
            <span>Joined</span>
            <span>{acct?.joinedAt ? new Date(acct.joinedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '…'}</span>
          </div>
          <div>
            <span>X account</span>
            <span>{u.verified ? 'Verified on X' : 'Not verified on X'}</span>
          </div>
        </div>
      </div>

      {acct && acct.blocked.length > 0 && (
        <>
          <div className="sec-h">
            <h2>Blocked accounts</h2>
          </div>
          <div className="glass set-card" id="blocked">
            {acct.blocked.map((b) => (
              <div key={b.handle} className="tr" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <Link href={`/${b.handle}`} className="row" style={{ minWidth: 0 }}>
                  <Avatar u={b} size={36} />
                  <div style={{ minWidth: 0 }}>
                    <div className="nm">
                      <b>{b.name}</b>
                    </div>
                    <div className="hd">@{b.handle}</div>
                  </div>
                </Link>
                <button className="btn btn-glass btn-sm" onClick={() => s.block(b.handle)}>
                  Unblock
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* [D] appearance and notification preferences */}
      <AppearanceSettings />
      <NotificationSettings />

      <div className="sec-h">
        <h2>Your data</h2>
      </div>
      <div className="glass set-card set-pad">
        <p className="t2">
          One JSON file with your profile, posts, messages you sent, notifications, points ledger, wallets and trades.
        </p>
        <button className="btn btn-glass" disabled={busy === 'export'} onClick={download}>
          <Icon name="down" />
          Download my data
        </button>
      </div>

      <div className="sec-h">
        <h2>Session</h2>
      </div>
      <div className="glass set-card set-pad">
        <p className="t2">Sign out of Sway on this device. Your wallet key stays in this browser.</p>
        <button className="btn btn-glass" disabled={busy === 'logout'} onClick={logout}>
          <Icon name="logout" />
          Log out @{u.handle}
        </button>
      </div>

      <div className="sec-h">
        <h2>Delete account</h2>
      </div>
      <div className="glass set-card set-pad danger-zone">
        <p className="t2">
          This removes your profile details, the text and images of your posts, your messages, likes, reposts, follows, subscriptions, blocks, reports and notifications, and signs you
          out everywhere. Your key market, trades and holdings stay onchain under “Deleted account”, and your wallet and its funds stay yours. This can’t be undone. See the{' '}
          <Link className="lnk" href="/privacy">
            Privacy Policy
          </Link>
          .
        </p>
        <label className="lbl" htmlFor="del-c">
          Type <b style={{ color: 'var(--tx)' }}>{phrase}</b> to confirm
        </label>
        <input className="field" id="del-c" autoComplete="off" spellCheck={false} placeholder={phrase} value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ marginBottom: 12 }} />
        <button className="btn btn-sell" disabled={confirm.trim().toLowerCase() !== phrase || busy === 'delete'} onClick={del}>
          <Icon name="trash" />
          Delete my account
        </button>
      </div>

      <nav className="rail-foot" style={{ padding: '18px 16px 8px' }}>
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
      </nav>
    </div>
  );
}
