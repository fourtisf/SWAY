'use client';
/** "Launch my key" on the Wallet page while the member's own key market isn't onchain yet (also on their profile). */
import { useState } from 'react';
import { useActions } from '@/lib/actions';
import { useMe } from '@/lib/queries';
import { useMemberWallets } from '@/lib/wallet';
import { Spinner } from '../ui';

export function LaunchKeyCard() {
  const me = useMe().data;
  const { wallets } = useMemberWallets();
  const a = useActions();
  const [busy, setBusy] = useState(false);
  if (!me?.market || me.market.opened) return null;
  // The market is bound to the account wallet onchain: one that can't sign here has to be replaced first.
  const blocked = wallets.find((w) => w.account)?.status === 'unsupported';
  return (
    <div className="glass earn" id="launchKeyCard">
      <div className="between" style={{ gap: 16 }}>
        <div>
          <div style={{ fontWeight: 750, fontSize: 16 }}>Launch your key</div>
          <div className="t3" style={{ fontSize: 13, marginTop: 4 }}>
            {blocked
              ? 'Your account wallet is a Sway wallet made in the browser, which can’t sign on this network. Add your wallet app below if it isn’t there, pick ⋯ → Make account wallet on its row, then launch your key here.'
              : 'Your key isn’t onchain yet. It goes live with its first buy, or launch it now: one transaction, a little gas.'}
          </div>
        </div>
        {!blocked && (
          <button
            className="btn btn-buy"
            style={{ flex: 'none' }}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await a.launchKey();
              setBusy(false);
            }}
          >
            {busy ? <Spinner /> : 'Launch my key'}
          </button>
        )}
      </div>
    </div>
  );
}
