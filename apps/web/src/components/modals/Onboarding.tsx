'use client';
/**
 * Connect X → "Scoring @handle" steps → "Your Sway card is live".
 * Real mode: X OAuth (or dev login), GET /api/onboarding for steps 1-3; step 4 asks "Create a Sway wallet" or
 * "Connect a wallet" (the picker), then nonce/sign/link makes it the account wallet; POST /api/onboarding/market
 * + polling for step 5. Mock mode keeps the prototype's 460ms animation and the same step-4 choice.
 * The wallet can wait ("Skip for now"): posting, following and points need none, and buying keys or launching
 * your key reopens this modal at step 4 (needWallet). Mock accounts keep their demo wallet either way.
 */
import { priceWei, weiToEth } from '@sway/curve';
import { tierOf } from '@sway/scoring';
import type { MeDTO, OnboardingStatus } from '@sway/shared';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { errorMessage, getApi } from '@/lib/api';
import { loadRef } from '@/lib/referral';
import { useActions } from '@/lib/actions';
import { MOCK } from '@/lib/env';
import { useFormat } from '@/lib/format';
import { invalidateAll, qk, useConfig, useMe } from '@/lib/queries';
import { closeModal, openModal } from '@/lib/store';
import { createEmbeddedWallet, linkWallet } from '@/lib/wallet';
import { useWalletCatalog } from '@/lib/wallet/catalog';
import { LogoBox } from '../wallet/WalletLogo';
import { WalletPickerBody } from '../wallet/WalletPicker';
import { socket } from '@/lib/ws';
import { Icon } from '../icons';
import { Avatar, Spinner, VB, Voiceprint } from '../ui';

const STEPS = ['Reading your public profile', 'Measuring engagement on your last 50 posts', 'Running the open scoring model', 'Creating your Sway wallet', 'Opening your key market'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ConnectModal() {
  const cfg = useConfig().data;
  const [h, setH] = useState('');
  const [f, setF] = useState('');
  const x = cfg ? cfg.auth.x : false;
  const dev = cfg ? cfg.auth.dev : MOCK;
  const goX = () => {
    window.location.href = getApi().xStartUrl(window.location.pathname + window.location.search, loadRef());
  };
  const goDev = () => openModal({ type: 'onboard', handle: h.trim() || 'you', followers: parseInt(f.replace(/[^0-9]/g, '')) || 0 });
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') goDev();
  };
  return (
    <>
      <div className="m-h">
        <h3>Connect X</h3>
        <button className="x-btn" aria-label="Close" onClick={closeModal}>
          <Icon name="close" />
        </button>
      </div>
      <div className="m-b">
        <div className="xauth">
          <div className="row">
            <span style={{ width: 38, height: 38, borderRadius: 11, background: '#0F1419', color: '#fff', display: 'grid', placeItems: 'center', flex: 'none' }}>
              <Icon name="x" size={18} />
            </span>
            <div>
              <b>Sway will read your public profile</b>
              <div className="t3" style={{ fontSize: 12.5 }}>
                You sign in on X’s own screen
              </div>
            </div>
          </div>
          <ul>
            <li>Public numbers only: followers, posts, engagement</li>
            <li>Can’t post for you or see your password</li>
            <li>Your access token isn’t stored</li>
          </ul>
        </div>
        {x && (
          <button className="btn btn-white btn-lg btn-block" onClick={goX} style={dev ? { marginBottom: 18 } : undefined}>
            <Icon name="x" />
            Authorize and continue
          </button>
        )}
        {dev && (
          <>
            <label className="lbl" htmlFor="cx-h">
              X handle (demo)
            </label>
            <input className="field" id="cx-h" placeholder="@yourhandle" autoComplete="off" style={{ marginBottom: 12 }} autoFocus value={h} onChange={(e) => setH(e.target.value)} onKeyDown={onKey} />
            <label className="lbl" htmlFor="cx-f">
              Followers (optional, demo)
            </label>
            <input className="field" id="cx-f" placeholder="e.g. 65000" inputMode="numeric" style={{ marginBottom: 18 }} value={f} onChange={(e) => setF(e.target.value)} onKeyDown={onKey} />
            <button className={`btn ${x ? 'btn-glass' : 'btn-white'} btn-lg btn-block`} onClick={goDev}>
              {!x && <Icon name="x" />}
              {x ? 'Continue with demo handle' : 'Authorize and continue'}
            </button>
          </>
        )}
        {cfg && !x && !dev && (
          <div className="note" id="xOff">
            Sign-in with X isn’t switched on yet. You can browse everything as a guest in the meantime.
          </div>
        )}
        <p className="t3" style={{ fontSize: 12, textAlign: 'center', margin: '12px 0 0' }}>
          Add a wallet now or later: you only need one to buy keys or launch yours.
        </p>
        {/* [B] */}
        <p className="t3 legal-note">
          By continuing you agree to the{' '}
          <Link className="lnk" href="/terms">
            Terms
          </Link>{' '}
          and the{' '}
          <Link className="lnk" href="/privacy">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </>
  );
}

type WalletDecision = { kind: 'create' } | { kind: 'linked'; me: MeDTO; name: string } | { kind: 'skip' };

export function OnboardingModal({ handle, followers }: { handle?: string; followers?: number }) {
  const qc = useQueryClient();
  const cfg = useConfig().data;
  const me = useMe().data;
  const apps = useWalletCatalog();
  const [cur, setCur] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  /** Step 4: waiting for the member's choice ('ask'), or the wallet picker is open. */
  const [choice, setChoice] = useState<'ask' | 'picker' | null>(null);
  const [walletStep, setWalletStep] = useState<string | null>(null);
  const decide = useRef<((d: WalletDecision) => void) | null>(null);
  const shown = (handle || me?.user.handle || 'you').replace(/^@/, '');

  useEffect(() => {
    let dead = false;
    const CANCEL = Symbol('cancel');
    const chk = () => {
      if (dead) throw CANCEL;
    };
    const api = getApi();
    const finish = async (walletLater = false) => {
      await invalidateAll(qc);
      if (!MOCK) socket.restart();
      if (!dead) openModal({ type: 'card', walletLater });
    };
    const ask = () =>
      new Promise<WalletDecision>((resolve) => {
        decide.current = resolve;
        setChoice('ask');
      });
    /** The account wallet, or null when the member chose to add one later. */
    const wallet = async (who: MeDTO): Promise<MeDTO | null> => {
      const d = await ask();
      chk();
      setChoice(null);
      if (d.kind === 'skip') return null;
      if (d.kind === 'linked') {
        setWalletStep(`Linking ${d.name}`);
        return d.me;
      }
      setWalletStep(null);
      if (MOCK) {
        await sleep(460);
        return who;
      }
      const w = await createEmbeddedWallet(who.user.id, cfg ?? (await api.config()));
      chk();
      return linkWallet(w, { as: 'account', connector: 'sway' });
    };

    const mock = async () => {
      for (let i = 0; i < 3; i++) {
        if (dead) return;
        setCur(i);
        await sleep(460);
      }
      let who = await api.devLogin({ handle: handle || 'you', followers: followers || undefined, ref: loadRef() ?? undefined });
      chk();
      qc.setQueryData(qk.me, who);
      setCur(3);
      const linked = await wallet(who);
      chk();
      if (!linked) return finish(true);
      qc.setQueryData(qk.me, linked);
      for (let i = 4; i <= STEPS.length; i++) {
        if (dead) return;
        setCur(i);
        if (i < STEPS.length) await sleep(460);
      }
      await finish();
    };

    const real = async () => {
      setErr(null);
      let who: MeDTO | null = me ?? null;
      if (handle && (!who || who.user.handle !== handle.replace(/^@/, '').toLowerCase())) {
        who = await api.devLogin({ handle, followers: followers || undefined, ref: loadRef() ?? undefined });
        chk();
        qc.setQueryData(qk.me, who);
      }
      if (!who) who = await api.me();
      chk();
      if (!who) throw new Error('Sign in with X first');
      let st: OnboardingStatus = await api.onboarding();
      chk();
      // Steps 1-3: profile, engagement, score (the API scores right after the X callback).
      for (let tries = 0; !(st.profile && st.engagement && st.scored); tries++) {
        if (dead) return;
        setCur(!st.profile ? 0 : !st.engagement ? 1 : 2);
        if (tries > 60) throw new Error('Scoring is taking longer than usual');
        await sleep(1500);
        st = await api.onboarding();
      }
      // Step 4: the account wallet, made here or connected.
      setCur(3);
      if (!st.wallet) {
        const linked = await wallet(who);
        chk();
        // No wallet yet: the member is in; the market opens once they add one.
        if (!linked) return finish(true);
        qc.setQueryData(qk.me, linked);
      }
      // Step 5: open the key market onchain, then wait for the indexer.
      setCur(4);
      if (!st.market) {
        st = await api.openMarket();
        chk();
        for (let tries = 0; !st.market; tries++) {
          if (dead) return;
          if (tries > 80) throw new Error('Opening your market is taking longer than usual');
          await sleep(1500);
          st = await api.onboarding();
        }
      }
      setCur(5);
      await finish();
    };

    (MOCK ? mock() : real()).catch((e) => {
      if (e === CANCEL || dead) return;
      setChoice(null);
      setErr(errorMessage(e));
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  if (choice === 'picker')
    return (
      <>
        <div className="m-h">
          <h3>Connect a wallet</h3>
        </div>
        <div className="m-b">
          <WalletPickerBody
            purpose="account"
            onBack={() => setChoice('ask')}
            onDone={(r) => {
              if (r.how === 'linked') decide.current?.({ kind: 'linked', me: r.me, name: r.name });
            }}
          />
        </div>
      </>
    );

  const steps = STEPS.map((s, i) => (i === 3 ? (walletStep ?? (choice ? 'Set up your wallet' : s)) : s));
  // Privy / CDP embedded wallets are stubs until a provider is chosen: only wallet apps work then.
  const embeddedOk = MOCK || !cfg || cfg.wallets.embedded === 'burner';
  const stack = (['metaMask', 'coinbaseWallet', 'rabby', 'walletConnect'] as const).flatMap((id) => (apps[id]?.icon ? [apps[id]!] : []));
  return (
    <>
      <div className="m-h">
        <h3>Scoring @{shown}</h3>
      </div>
      <div className="m-b">
        <div style={{ height: 64 }} className="live">
          <Voiceprint seed={handle || shown} score={72} bars={52} id="scan" />
        </div>
        <div className="steps">
          {steps.map((s, i) => (
            <div key={i} className={`step ${i < cur ? 'done' : i === cur ? 'on' : ''}`} id={`st${i}`}>
              <span className="d">{i < cur ? <Icon name="check" /> : i === cur && !choice ? <Spinner size={11} /> : null}</span>
              {s}
            </div>
          ))}
        </div>
        {choice === 'ask' && (
          <div className="ob-choice">
            <button className="wopt" disabled={!embeddedOk} onClick={() => decide.current?.({ kind: 'create' })}>
              <LogoBox logo={{ kind: 'sway' }} size={38} />
              <span className="wopt-t">
                <b>Create a Sway wallet</b>
                <small>
                  {embeddedOk
                    ? cfg?.mainnet
                      ? 'Made in this browser. Back up its key right after.'
                      : 'Made in this browser. No extension.'
                    : cfg?.wallets.embedded === 'off'
                      ? 'Off on mainnet: use a wallet app below'
                      : 'Not available on this server yet'}
                </small>
              </span>
              {embeddedOk && <span className="tag">Recommended</span>}
            </button>
            <button className="wopt" onClick={() => setChoice('picker')}>
              <span className="wstack">
                {stack.map((m) => (
                  <LogoBox key={m.id} logo={{ kind: 'img', src: m.icon!, bg: m.iconBackground, name: m.name }} size={17} />
                ))}
              </span>
              <span className="wopt-t">
                <b>Connect a wallet</b>
                <small>MetaMask, Coinbase, Rabby, WalletConnect and more</small>
              </span>
              <Icon name="chev" className="wopt-go" />
            </button>
            <button className="ob-skip" onClick={() => decide.current?.({ kind: 'skip' })}>
              Skip for now
            </button>
            <p className="t3 ob-skip-note">You can post, follow and earn points without one. You’ll need a wallet to buy keys or launch your key.</p>
          </div>
        )}
        {err && (
          <>
            <p className="t2" style={{ fontSize: 13.5, color: 'var(--red)', margin: '14px 0 12px' }}>
              {err}
            </p>
            <div className="row">
              <button className="btn btn-glass btn-block" onClick={closeModal}>
                Later
              </button>
              <button className="btn btn-white btn-block" onClick={() => setRun(run + 1)}>
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export function UserCard({ me, live = false }: { me: MeDTO; live?: boolean }) {
  const F = useFormat();
  const u = me.user;
  const t = tierOf(me.points.total);
  return (
    <div className={`ic ${live ? 'live' : ''}`} style={{ '--frame': t.frame } as CSSProperties}>
      <div className="ic-in">
        <div className="ic-top">
          <div className="row" style={{ minWidth: 0 }}>
            <Avatar u={u} size={44} />
            <div style={{ minWidth: 0 }}>
              <div className="nm">
                <b>{u.name}</b>
                <VB v={u.verified} />
              </div>
              <div className="hd">@{u.handle}</div>
            </div>
          </div>
          <span className="tag">{t.name}</span>
        </div>
        <div className="ic-score">
          <div className="big">{u.score}</div>
          <div className="of">
            /100
            <br />
            Sway score
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontSize: 24, fontWeight: 750, letterSpacing: '-.03em' }}>{F.usd(u.reachValue)}</div>
            <div className="t3" style={{ fontSize: 12, fontWeight: 600 }}>
              reach value
            </div>
          </div>
        </div>
        <div className="ic-vp">
          <Voiceprint seed={u.handle} score={u.score} bars={60} id={'uc' + (live ? 'l' : 's')} />
        </div>
        <div className="ic-grid">
          <div>
            <small>Points</small>
            <b>{F.n(me.points.total)}</b>
          </div>
          <div>
            <small>Rank</small>
            <b>#{F.int(me.points.rank)}</b>
          </div>
          <div>
            <small>Member</small>
            <b>{u.memberNo}</b>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CardModal({ walletLater = false }: { walletLater?: boolean }) {
  const me = useMe().data;
  const cfg = useConfig().data;
  const F = useFormat();
  const { shareCard } = useActions();
  if (!me) return null;
  const later = walletLater || !me.wallet;
  // A browser-made wallet on mainnet: its key exists only in this browser until the member backs it up.
  const backup = !!cfg?.mainnet && me.wallet?.kind === 'embedded' ? me.wallet.address : null;
  return (
    <>
      <div className="m-h">
        <h3>Your Sway card is live</h3>
        <button className="x-btn" aria-label="Close" onClick={closeModal}>
          <Icon name="close" />
        </button>
      </div>
      <div className="m-b">
        <UserCard me={me} live />
        <p className="t2" style={{ fontSize: 13.5, margin: '16px 0 18px' }}>
          {later
            ? 'You’re in. Post, follow and earn points now. Add a wallet when you want to buy keys or launch your own key market.'
            : `Your key market is open at ${F.$(weiToEth(priceWei(100n)))} a key. The first key is yours and can’t be sold, so your room always has an owner.`}
        </p>
        {backup && (
          <div className="note" style={{ margin: '0 0 14px' }}>
            Your Sway wallet’s key lives only in this browser. Back it up now: if this browser’s data is cleared, the
            wallet and its funds can’t be recovered.
            <button className="btn btn-white btn-sm" style={{ marginTop: 10 }} onClick={() => openModal({ type: 'walletBackup', address: backup })}>
              <Icon name="lock" size={14} />
              Back up wallet key
            </button>
          </div>
        )}
        <div className="row">
          <button className="btn btn-glass btn-block" onClick={shareCard}>
            <Icon name="x" />
            Share card
          </button>
          <button className="btn btn-white btn-block" onClick={closeModal}>
            Enter Sway
          </button>
        </div>
      </div>
    </>
  );
}
