'use client';
/** "Launch my key" on the Wallet page while the member's own key market isn't onchain yet (also on their profile). */
import { shortAddress } from '@sway/shared';
import { useState } from 'react';
import { useActions } from '@/lib/actions';
import { useMe } from '@/lib/queries';
import { openModal } from '@/lib/store';
import { useMemberWallets } from '@/lib/wallet';
import { openConnectWallet } from '@/lib/wallet-actions';
import { Spinner } from '../ui';

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * How launching the key goes. The market is bound to the account wallet onchain, so when that is a browser-made
 * Sway wallet that can't sign here, a connected wallet app (`via`, the active one first) becomes the account wallet.
 */
export function useLaunchKey() {
  const me = useMe().data;
  const { wallets, active } = useMemberWallets();
  const show = !!me?.market && !me.market.opened;
  const blocked = wallets.find((w) => w.account)?.status === 'unsupported';
  const apps = wallets.filter((w) => !w.account && w.kind === 'external');
  const ready = apps.filter((w) => w.usable);
  const via = blocked ? (ready.find((w) => same(w.address, active?.address)) ?? ready[0] ?? null) : null;
  // A wallet app that's added but not connected in this browser.
  const idle = blocked && !via ? (apps[0] ?? null) : null;
  return { show, blocked, via, idle };
}

export function LaunchKeyCard() {
  const { show, blocked, via, idle } = useLaunchKey();
  const a = useActions();
  const [busy, setBusy] = useState(false);
  if (!show) return null;
  const run = async () => {
    setBusy(true);
    await a.launchKey(via);
    setBusy(false);
  };
  let text: string;
  let button: { label: string; onClick: () => void };
  if (!blocked) {
    text = 'Your key isn’t onchain yet. It goes live with its first buy, or launch it now: one transaction, a little gas.';
    button = { label: 'Launch my key', onClick: run };
  } else if (via) {
    text = `Your account wallet is a Sway wallet made in the browser, which can’t sign on this network. Launching makes ${via.name} ${shortAddress(via.address)} your account wallet: your key and its creator fees belong to it, and the Sway wallet stays added. One transaction, a little gas.`;
    button = { label: `Launch with ${via.name}`, onClick: run };
  } else if (idle) {
    text = `Your account wallet is a Sway wallet made in the browser, which can’t sign on this network. Connect ${idle.name} in this browser to launch your key with it.`;
    button = { label: `Connect ${idle.name}`, onClick: () => openConnectWallet(idle.address) };
  } else {
    text = 'Your account wallet is a Sway wallet made in the browser, which can’t sign on this network. Add your wallet app (MetaMask, Rabby, Bitget…) to launch your key with it.';
    button = { label: 'Add wallet', onClick: () => openModal({ type: 'wallets', purpose: 'add' }) };
  }
  return (
    <div className="glass earn" id="launchKeyCard">
      <div className="between" style={{ gap: 16 }}>
        <div>
          <div style={{ fontWeight: 750, fontSize: 16 }}>Launch your key</div>
          <div className="t3" style={{ fontSize: 13, marginTop: 4 }}>
            {text}
          </div>
        </div>
        <button className="btn btn-buy" style={{ flex: 'none' }} disabled={busy} onClick={button.onClick}>
          {busy ? <Spinner /> : button.label}
        </button>
      </div>
    </div>
  );
}
