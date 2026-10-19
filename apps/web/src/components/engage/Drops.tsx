'use client';
/** [D] Creator airdrops to key holders: the creator's composer, the drops list on profiles, and holders' claims. */
import { ethToWei, weiToEth } from '@sway/curve';
import { minutesSince, type CreatorDropDTO, type DropPlanDTO } from '@sway/shared';
import { useState } from 'react';
import { Icon } from '@/components/icons';
import { Avatar, Spinner } from '@/components/ui';
import { useClaimableDrops, useEngageActions, useUserDrops } from '@/lib/engage';
import { useFormat } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { closeModal, openModal } from '@/lib/store';
import { useSwayWallet } from '@/lib/wallet';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const DAYS = [3, 7, 30] as const;

function endsIn(iso: string): string {
  const m = -minutesSince(iso);
  if (m <= 0) return 'ended';
  if (m < 60) return `ends in ${Math.ceil(m)}m`;
  if (m < 48 * 60) return `ends in ${Math.ceil(m / 60)}h`;
  return `ends in ${Math.round(m / 1440)}d`;
}

/** Wallet page: ETH drops waiting for the viewer, one Claim per allocation (from the wallet that holds it). */
export function DropsCard() {
  const me = useMe().data;
  const F = useFormat();
  const { data } = useClaimableDrops(!!me);
  const { wallet } = useSwayWallet();
  const act = useEngageActions();
  const [busy, setBusy] = useState<string | null>(null);
  const list = data ?? [];
  if (!list.length) return null;
  return (
    <div className="glass drop-claim" id="drops">
      <div className="t3" style={{ fontSize: 12.5, fontWeight: 600 }}>
        ETH airdrops to claim
      </div>
      <div style={{ marginTop: 6 }}>
        {list.map((d) => {
          const k = `${d.id}:${d.address}`;
          const other = !!wallet && wallet.address.toLowerCase() !== d.address.toLowerCase();
          return (
            <div key={k} className="earn-r" style={{ alignItems: 'center' }}>
              <span className="row" style={{ minWidth: 0 }}>
                <Avatar u={d.creator} size={32} />
                <span style={{ minWidth: 0 }}>
                  <b style={{ color: 'var(--tx)' }}>
                    {F.eth(weiToEth(BigInt(d.amountWei)))} ETH <span className="t3">· {F.$(weiToEth(BigInt(d.amountWei)))}</span>
                  </b>
                  <br />
                  <span className="t3" style={{ fontSize: 12.5 }}>
                    {`From ${d.creator.name} for holding their key${other ? ` in ${short(d.address)}` : ''} · ${endsIn(d.expiresAt)}`}
                  </span>
                </span>
              </span>
              <button
                className="btn btn-buy btn-sm"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(k);
                  await act.claimDrop(d);
                  setBusy(null);
                }}
              >
                {busy === k ? <Spinner /> : 'Claim'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DropRow({ d, mine }: { d: CreatorDropDTO; mine: boolean }) {
  const F = useFormat();
  const act = useEngageActions();
  const [busy, setBusy] = useState(false);
  const total = BigInt(d.totalWei);
  const pct = total > 0n ? Number((BigInt(d.claimedWei) * 100n) / total) : 0;
  const ended = d.reclaimed || -minutesSince(d.expiresAt) <= 0;
  return (
    <div className="drop-r">
      <div className="between">
        <b>
          {F.eth(weiToEth(total))} ETH <span className="t3">to {d.holders} holder{d.holders === 1 ? '' : 's'}</span>
        </b>
        <span className={`tag ${ended ? 'line' : 'aqua'}`}>{d.reclaimed ? 'Closed' : ended ? 'Ended' : endsIn(d.expiresAt)}</span>
      </div>
      <div className="drop-bar" aria-label={`${pct}% claimed`}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="between t3" style={{ fontSize: 12.5 }}>
        <span>
          {d.claims} claimed · {pct}% of the ETH
        </span>
        {mine && d.canReclaim ? (
          <button
            className="btn btn-glass btn-sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await act.reclaimDrop(d);
              setBusy(false);
            }}
          >
            {busy ? <Spinner /> : 'Take back unclaimed'}
          </button>
        ) : (
          <span>{new Date(d.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        )}
      </div>
    </div>
  );
}

/** Profile card: the creator's drops; on your own profile, the button to start one. */
export function CreatorDrops({ handle, isMe, opened }: { handle: string; isMe: boolean; opened: boolean }) {
  const { data } = useUserDrops(handle);
  const list = data ?? [];
  if (!isMe && !list.length) return null;
  return (
    <div className="glass drops" id="creator-drops">
      <div className="between">
        <div>
          <b style={{ fontSize: 15 }}>Airdrops to holders</b>
          <div className="t3" style={{ fontSize: 12.5 }}>
            {isMe ? 'Send ETH to everyone holding your key, pro rata to keys held.' : 'ETH this creator sent to their key holders.'}
          </div>
        </div>
        {isMe && opened && (
          <button className="btn btn-white btn-sm" onClick={() => openModal({ type: 'drop' })}>
            <Icon name="gift" /> Airdrop
          </button>
        )}
      </div>
      {list.map((d) => (
        <DropRow key={d.id} d={d} mine={isMe} />
      ))}
    </div>
  );
}

/** Modal: amount and duration → holder list snapshot → fund the drop. */
export function DropModal() {
  const F = useFormat();
  const act = useEngageActions();
  const [eth, setEth] = useState('0.05');
  const [days, setDays] = useState<number>(7);
  const [plan, setPlan] = useState<DropPlanDTO | null>(null);
  const [busy, setBusy] = useState<'plan' | 'send' | null>(null);
  let wei = 0n;
  try {
    wei = ethToWei(eth.replace(',', '.') || '0');
  } catch {
    wei = 0n;
  }
  const build = async () => {
    setBusy('plan');
    setPlan(await act.planDrop(wei));
    setBusy(null);
  };
  const send = async () => {
    if (!plan) return;
    setBusy('send');
    const ok = await act.sendDrop(plan, days);
    setBusy(null);
    if (ok) closeModal();
  };
  return (
    <>
      <div className="m-h">
        <h3>Airdrop to your holders</h3>
        <button className="x-btn" aria-label="Close" onClick={closeModal}>
          <Icon name="close" />
        </button>
      </div>
      <div className="m-b">
        {!plan ? (
          <>
            <div className="amt-l">
              <span>Total ETH</span>
              <span>{F.$(weiToEth(wei))}</span>
            </div>
            <div className="amt">
              <input inputMode="decimal" aria-label="ETH to airdrop" value={eth} onChange={(e) => setEth(e.target.value.replace(/[^0-9.,]/g, ''))} />
            </div>
            <div className="amt-l" style={{ marginTop: 14 }}>
              <span>Holders can claim for</span>
            </div>
            <div className="quick">
              {DAYS.map((d) => (
                <button key={d} className={`chip ${days === d ? 'on' : ''}`} onClick={() => setDays(d)}>
                  {d} days
                </button>
              ))}
            </div>
            <p className="t3" style={{ fontSize: 12.5, margin: '12px 0' }}>
              Sway snapshots who holds your key now and splits the ETH pro rata to keys held (your own wallets and accounts
              flagged as bots are left out). After the claim window ends you can take back what nobody claimed.
            </p>
            <button className="btn btn-lg btn-block btn-white" disabled={wei <= 0n || busy === 'plan'} onClick={build}>
              {busy === 'plan' ? <Spinner /> : 'Preview holders'}
            </button>
          </>
        ) : (
          <>
            <div className="sum">
              <div className="sum-r tot">
                <span>Total</span>
                <span>
                  <b>{F.$(weiToEth(BigInt(plan.totalWei)))}</b>
                  <small>{F.eth(weiToEth(BigInt(plan.totalWei)))} ETH</small>
                </span>
              </div>
              <div className="sum-r">
                <span>Holders</span>
                <span>{plan.holders}</span>
              </div>
              <div className="sum-r">
                <span>Claim window</span>
                <span>{days} days</span>
              </div>
            </div>
            <div className="t3" style={{ fontSize: 12.5, fontWeight: 600, margin: '14px 0 6px' }}>
              Largest allocations
            </div>
            <div className="drop-top">
              {plan.top.slice(0, 8).map((t) => (
                <div key={t.address} className="between" style={{ padding: '6px 0', fontSize: 13.5 }}>
                  <span className="row" style={{ minWidth: 0, gap: 8 }}>
                    {t.user ? <Avatar u={t.user} size={24} /> : <Icon name="wallet" size={18} />}
                    <span>{t.user ? `@${t.user.handle}` : short(t.address)}</span>
                  </span>
                  <b>{F.eth(weiToEth(BigInt(t.amountWei)))} ETH</b>
                </div>
              ))}
            </div>
            <div className="row" style={{ marginTop: 14, gap: 8 }}>
              <button className="btn btn-glass" onClick={() => setPlan(null)} disabled={busy === 'send'}>
                Back
              </button>
              <button className="btn btn-lg btn-block btn-buy" onClick={send} disabled={busy === 'send'}>
                {busy === 'send' ? <Spinner /> : `Send ${F.eth(weiToEth(BigInt(plan.totalWei)))} ETH`}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
