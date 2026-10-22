'use client';
import { weiToEth } from '@sway/curve';
import { normalizeHandle } from '@sway/shared';
import { useEffect, useState } from 'react';
import { errorMessage, getApi } from '@/lib/api';
import { loadRef } from '@/lib/referral';
import { useActions } from '@/lib/actions';
import { useFormat } from '@/lib/format';
import { useConfig, useMe, useProfile } from '@/lib/queries';
import { closeModal, toast, useUI, type Modal } from '@/lib/store';
import { Icon } from '../icons';
import { Composer } from './Composer';
import { CardModal, ConnectModal, OnboardingModal } from './Onboarding';
import { TradeSheet } from './TradeSheet';
import { LaunchSheet } from '../launch/LaunchSheet'; // [C]
import { BoostSheet, DeletePostModal, ReportModal } from './Social'; // [B]
// [A] wallets & funding
import { AccountWalletModal, BackupModal, ConnectWalletModal, DepositModal, ImportModal, RemoveModal, RenameModal, WithdrawModal } from '../wallet/WalletModals';
import { DropModal } from '../engage/Drops'; // [D]

function Head({ title }: { title: string }) {
  return (
    <div className="m-h">
      <h3>{title}</h3>
      <button className="x-btn" aria-label="Close" onClick={closeModal}>
        <Icon name="close" />
      </button>
    </div>
  );
}

function ComposeModal() {
  return (
    <>
      <Head title="New post" />
      <div style={{ padding: '0 4px 8px' }}>
        <Composer inModal onPosted={closeModal} />
      </div>
    </>
  );
}

function ChallengeModal({ handle }: { handle?: string }) {
  const me = useMe().data;
  const F = useFormat();
  const { challenge } = useActions();
  const [opp, setOpp] = useState(handle ? '@' + handle : '');
  const [theme, setTheme] = useState('');
  const [stake, setStake] = useState(0);
  const max = Math.max(100, me?.points.earned ?? 0);
  return (
    <>
      <Head title="New challenge" />
      <div className="m-b">
        <label className="lbl" htmlFor="ch-h">
          Opponent
        </label>
        <input className="field" id="ch-h" placeholder="@handle, or empty for an open challenge" style={{ marginBottom: 14 }} value={opp} onChange={(e) => setOpp(e.target.value)} />
        <label className="lbl" htmlFor="ch-t">
          Theme
        </label>
        <input className="field" id="ch-t" placeholder="e.g. Best one-line take this week" style={{ marginBottom: 16 }} value={theme} onChange={(e) => setTheme(e.target.value)} />
        <div className="sl">
          <label htmlFor="ch-s">
            Stake<b id="ch-sv">{stake ? F.int(stake) + ' pts' : 'Friendly, no stake'}</b>
          </label>
          <input type="range" id="ch-s" min={0} max={max} step={100} value={stake} onChange={(e) => setStake(+e.target.value)} />
        </div>
        <p className="t3" style={{ fontSize: 12.5, margin: '0 0 16px' }}>
          Only earned points can be staked, not points from your score. Your stake comes back if they decline.
        </p>
        <button className="btn btn-white btn-lg btn-block" onClick={() => challenge(opp, theme, stake)}>
          Send challenge
        </button>
      </div>
    </>
  );
}

function ClaimModal({ handle }: { handle: string }) {
  const p = useProfile(handle).data;
  const cfg = useConfig().data;
  const F = useFormat();
  const [form, setForm] = useState(false);
  const [kind, setKind] = useState<'claim' | 'takedown'>('claim');
  const [contact, setContact] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const signIn = () => {
    if (cfg?.auth.x) window.location.href = getApi().xStartUrl(`/${handle}`, loadRef());
    else closeModal();
  };
  const send = async () => {
    if (!contact.trim()) return toast('Add a way to reach you');
    setBusy(true);
    try {
      await getApi().claimRequest(handle, { kind, contact: contact.trim(), note: note.trim() || undefined });
      closeModal();
      toast(kind === 'claim' ? 'Claim request sent' : 'Takedown request sent');
    } catch (e) {
      toast(errorMessage(e));
    }
    setBusy(false);
  };
  return (
    <>
      <Head title={`Claim @${handle}`} />
      <div className="m-b">
        <p className="t2" style={{ margin: '0 0 18px' }}>
          Sign in with the X account <b style={{ color: 'var(--tx)' }}>@{handle}</b>. The profile, its wallet and {F.$(p ? weiToEth(p.escrowWei) : 0)} of escrowed creator fees become yours. Existing holders keep
          their keys.
        </p>
        <button className="btn btn-white btn-block btn-lg" onClick={signIn}>
          <Icon name="x" />
          Sign in as @{handle}
        </button>
        {!form ? (
          <p className="t3" style={{ fontSize: 12.5, textAlign: 'center', margin: '12px 0 0' }}>
            Can’t sign in, or want this market taken down?{' '}
            <button className="lnk" style={{ fontSize: 12.5 }} onClick={() => setForm(true)}>
              Send a request
            </button>
          </p>
        ) : (
          <div className="claim-req">
            <div className="seg" style={{ marginBottom: 12 }}>
              <button className={kind === 'claim' ? 'on' : ''} onClick={() => setKind('claim')}>
                Claim review
              </button>
              <button className={kind === 'takedown' ? 'on' : ''} onClick={() => setKind('takedown')}>
                Takedown
              </button>
            </div>
            <label className="lbl" htmlFor="cr-c">
              How can we reach you?
            </label>
            <input className="field" id="cr-c" placeholder="Email or @handle" style={{ marginBottom: 12 }} value={contact} onChange={(e) => setContact(e.target.value)} />
            <label className="lbl" htmlFor="cr-n">
              Note (optional)
            </label>
            <input className="field" id="cr-n" placeholder="Anything we should know" style={{ marginBottom: 14 }} value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn btn-glass btn-block" disabled={busy} onClick={send}>
              Send request
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function Body({ m }: { m: Modal }) {
  switch (m.type) {
    case 'trade':
      return <TradeSheet key={m.handle + m.side} handle={m.handle} side={m.side} />;
    case 'connect':
      return <ConnectModal />;
    case 'onboard':
      return <OnboardingModal handle={m.handle ? normalizeHandle(m.handle) || 'you' : undefined} followers={m.followers} />;
    case 'card':
      return <CardModal walletLater={m.walletLater} />;
    case 'compose':
      return <ComposeModal />;
    case 'withdraw':
      return <WithdrawModal />;
    case 'deposit':
      return <DepositModal />;
    case 'challenge':
      return <ChallengeModal handle={m.handle} />;
    case 'claim':
      return <ClaimModal handle={m.handle} />;
    case 'launch':
      return <LaunchSheet />; // [C]
    // [B] post menu
    case 'boost':
      return <BoostSheet postId={m.postId} />;
    case 'report':
      return <ReportModal postId={m.postId} handle={m.handle} />;
    case 'deletePost':
      return <DeletePostModal postId={m.postId} />;
    // [A] wallets
    case 'wallets':
      return <ConnectWalletModal purpose={m.purpose} address={m.address} />;
    case 'walletBackup':
      return <BackupModal address={m.address} />;
    case 'walletImport':
      return <ImportModal />;
    case 'walletRename':
      return <RenameModal address={m.address} />;
    case 'walletRemove':
      return <RemoveModal address={m.address} />;
    case 'walletAccount':
      return <AccountWalletModal address={m.address} />;
    // [D]
    case 'drop':
      return <DropModal />;
  }
}

export function ModalHost() {
  const m = useUI((s) => s.modal);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (useUI.getState().modal?.type !== 'onboard') closeModal();
        useUI.setState({ drawer: false });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  if (!m) return null;
  return (
    <div
      className="ov open"
      id="ov"
      onClick={(e) => {
        if (e.target === e.currentTarget && m.type !== 'onboard') closeModal();
      }}
    >
      <div className="modal" id="modal" role="dialog" aria-modal="true">
        <div className="grab" />
        <Body key={JSON.stringify(m)} m={m} />
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  return (
    <div className="toasts" id="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <Icon name="check" />
          {t.msg}
        </div>
      ))}
    </div>
  );
}
