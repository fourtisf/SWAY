'use client';
/** [C] "Token airdrops to claim" and the "Stake the Sway token" card (launchpad and wallet pages). */
import { STAKING_LEVELS } from '@sway/shared';
import Link from 'next/link';
import { useState } from 'react';
import { fmtTokens, useLaunchActions } from '@/lib/launch-actions';
import { useAirdrops, useMe } from '@/lib/queries';
import { useSwayWallet } from '@/lib/wallet';
import { Icon } from '../icons';
import { Avatar, Spinner } from '../ui';
import { TOKEN } from '@/lib/token';

export function AirdropsCard() {
  const me = useMe().data;
  const { data } = useAirdrops(!!me);
  const { wallet } = useSwayWallet();
  const act = useLaunchActions();
  const [busy, setBusy] = useState<string | null>(null);
  const list = data?.allocations ?? [];
  if (!list.length) return null;
  return (
    <div className="glass earn" id="airdrops">
      <div className="t3" style={{ fontSize: 12.5, fontWeight: 600 }}>
        Token airdrops to claim
      </div>
      <div style={{ marginTop: 6 }}>
        {list.map((a) => {
          const k = `${a.token}:${a.address}`;
          const other = !!wallet && wallet.address.toLowerCase() !== a.address.toLowerCase();
          return (
            <div key={k} className="earn-r" style={{ alignItems: 'center' }}>
              <span className="row" style={{ minWidth: 0 }}>
                <Avatar u={a.creator} size={32} />
                <span style={{ minWidth: 0 }}>
                  <b style={{ color: 'var(--tx)' }}>
                    {fmtTokens(a.amount)} ${a.symbol}
                  </b>
                  <br />
                  <span className="t3" style={{ fontSize: 12.5 }}>
                    {`For holding ${a.creator.name}’s keys${a.walletKind === 'linked' || other ? ` in ${a.address.slice(0, 6)}…${a.address.slice(-4)}` : ''}`}
                  </span>
                </span>
              </span>
              <button
                className="btn btn-buy btn-sm"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(k);
                  await act.claimAirdrop(a, data?.launchpad ?? null);
                  setBusy(null);
                }}
              >
                {busy === k ? <Spinner /> : 'Claim'}
              </button>
            </div>
          );
        })}
      </div>
      <div className="t3" style={{ fontSize: 12.5, marginTop: 6 }}>
        10% of every creator token goes to their key holders at launch. Claimed from the contract to the wallet that held the keys.
      </div>
    </div>
  );
}

export function StakeCard({ level }: { level: number }) {
  const l = STAKING_LEVELS[level] ?? STAKING_LEVELS[0];
  return (
    <Link href="/staking" className="glass earn between clickable" id="stakeCard" style={{ display: 'flex' }}>
      <span className="row" style={{ minWidth: 0 }}>
        <span className="task-ic" style={{ flex: 'none' }}>
          <Icon name="bolt" />
        </span>
        <span style={{ minWidth: 0 }}>
          <b>Stake {TOKEN.the}</b>
          <br />
          <span className="t3" style={{ fontSize: 13 }}>
            {level > 0 ? `Level ${level} ${l.name}: −${Math.round(l.cut * 100)}% protocol fee, 2,000-character posts` : 'Earn ETH from key trading fees and cut your own fees by up to 75%'}
          </span>
        </span>
      </span>
      <Icon name="chev" style={{ transform: 'rotate(-90deg)', width: 18, height: 18, color: 'var(--tx2)' }} />
    </Link>
  );
}
