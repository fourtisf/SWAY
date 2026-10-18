'use client';
/**
 * Connect X → "Scoring @handle" steps → "Your Sway card is live".
 * Real mode: X OAuth (or dev login), GET /api/onboarding for steps 1-3, embedded wallet + nonce/sign/link for
 * step 4, POST /api/onboarding/market + polling for step 5. Mock mode keeps the prototype's 460ms animation.
 */
import { priceWei, weiToEth } from '@sway/curve';
import { tierOf } from '@sway/scoring';
import type { MeDTO, OnboardingStatus } from '@sway/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { errorMessage, getApi } from '@/lib/api';
import { useActions } from '@/lib/actions';
import { MOCK } from '@/lib/env';
import { useFormat } from '@/lib/format';
import { invalidateAll, qk, useConfig, useMe } from '@/lib/queries';
import { closeModal, openModal } from '@/lib/store';
import { createEmbeddedWallet, useExternalWallet, type SwayWallet } from '@/lib/wallet';
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
    window.location.href = getApi().xStartUrl(window.location.pathname + window.location.search);
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
        <p className="t3" style={{ fontSize: 12, textAlign: 'center', margin: '12px 0 0' }}>
          A Sway wallet on Robinhood Chain is created for you at sign-in.
        </p>
      </div>
    </>
  );
}

export function OnboardingModal({ handle, followers }: { handle?: string; followers?: number }) {
  const qc = useQueryClient();
  const cfg = useConfig().data;
  const me = useMe().data;
  const [cur, setCur] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const useOwn = useRef(false);
  const shown = (handle || me?.user.handle || 'you').replace(/^@/, '');

  useEffect(() => {
    let dead = false;
    const CANCEL = Symbol('cancel');
    const chk = () => {
      if (dead) throw CANCEL;
    };
    const api = getApi();
    const finish = async () => {
      await invalidateAll(qc);
      if (!MOCK) socket.restart();
      if (!dead) openModal({ type: 'card' });
    };

    const mock = async () => {
      for (let i = 0; i <= STEPS.length; i++) {
        if (dead) return;
        setCur(i);
        if (i < STEPS.length) await sleep(460);
      }
      await api.devLogin({ handle: handle || 'you', followers: followers || undefined });
      await finish();
    };

    const real = async () => {
      setErr(null);
      let who: MeDTO | null = me ?? null;
      if (handle && (!who || who.user.handle !== handle.replace(/^@/, '').toLowerCase())) {
        who = await api.devLogin({ handle, followers: followers || undefined });
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
      // Step 4: wallet.
      setCur(3);
      if (!st.wallet) {
        let w: SwayWallet | null = null;
        if (useOwn.current) {
          w = useExternalWallet.getState().wallet;
          if (!w) {
            useExternalWallet.getState().openConnect?.();
            for (let i = 0; i < 240 && !w && !dead; i++) {
              await sleep(500);
              w = useExternalWallet.getState().wallet;
            }
            if (!w) throw new Error('Connect a wallet to continue');
          }
        } else w = await createEmbeddedWallet(who.user.id, cfg ?? (await api.config()));
        chk();
        const { message } = await api.walletNonce();
        chk();
        const signature = await w.signMessage(message);
        chk();
        who = await api.walletLink({ address: w.address, signature, kind: w.kind });
        chk();
        qc.setQueryData(qk.me, who);
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

    (MOCK ? mock() : real()).catch((e) => e !== CANCEL && !dead && setErr(errorMessage(e)));
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

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
          {STEPS.map((s, i) => (
            <div key={s} className={`step ${i < cur ? 'done' : i === cur ? 'on' : ''}`} id={`st${i}`}>
              <span className="d">{i < cur ? <Icon name="check" /> : i === cur ? <Spinner size={11} /> : null}</span>
              {s}
            </div>
          ))}
        </div>
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
        {!MOCK && cur === 3 && !useOwn.current && (
          <button
            className="lnk ob-alt"
            onClick={() => {
              useOwn.current = true;
              setRun(run + 1);
            }}
          >
            Use my own wallet instead
          </button>
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

export function CardModal() {
  const me = useMe().data;
  const F = useFormat();
  const { shareCard } = useActions();
  if (!me) return null;
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
          Your key market is open at {F.$(weiToEth(priceWei(100n)))} a key. The first key is yours and can’t be sold, so your room always has an owner.
        </p>
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
