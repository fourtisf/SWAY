'use client';
import { OFFICIAL_HANDLE } from '@sway/shared';
import { useConfig } from '@/lib/queries';
import { toast } from '@/lib/store';
import { Icon } from '../icons';

export const OFFICIAL_X_URL = `https://x.com/${OFFICIAL_HANDLE}`;
// NEXT_PUBLIC_SWAY_CA pins the $SWAY address at build time; otherwise the card shows the token @swaydotfamily
// launched, and "Coming soon" until then.
const PINNED_CA = (process.env.NEXT_PUBLIC_SWAY_CA ?? '').trim();

/** $SWAY contract address + the official X account (rail on desktop, drawer on mobile). */
export function CommunityCard() {
  const CA = PINNED_CA || (useConfig().data?.swayToken ?? '');
  const copy = () => {
    navigator.clipboard?.writeText(CA).catch(() => null);
    toast('Contract address copied');
  };
  return (
    <div className="glass wd comm">
      <div className="wd-h">
        <h3>$SWAY</h3>
        {!CA && <span className="tag pink">Soon</span>}
      </div>
      <div className="comm-ca">
        <span className="comm-lbl">CA</span>
        {CA ? (
          <>
            <span className="mono comm-addr" title={CA}>
              {CA}
            </span>
            <button className="x-btn" aria-label="Copy contract address" onClick={copy}>
              <Icon name="copy" />
            </button>
          </>
        ) : (
          <span className="comm-soon">Coming soon</span>
        )}
      </div>
      <p className="comm-note">Only trust the contract address posted here and on @{OFFICIAL_HANDLE}.</p>
      <a className="btn btn-white btn-block" href={OFFICIAL_X_URL} target="_blank" rel="noopener noreferrer">
        <Icon name="x" />
        Follow @{OFFICIAL_HANDLE}
      </a>
    </div>
  );
}
