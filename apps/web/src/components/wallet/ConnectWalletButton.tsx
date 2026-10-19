'use client';
/** [A] "Connect wallet" for signed-in members with no wallet that can sign in this browser (sidebar, mobile top bar). */
import { useMe } from '@/lib/queries';
import { openModal } from '@/lib/store';
import { useMemberWallets } from '@/lib/wallet';
import { openConnectWallet } from '@/lib/wallet-actions';
import { Icon } from '../icons';

/** 'setup' before onboarding linked a wallet, 'connect' when none of the member's wallets works here. */
export function useNeedsWallet(): 'setup' | 'connect' | null {
  const me = useMe().data;
  const { wallets, ready } = useMemberWallets();
  if (!me) return null;
  if (!me.wallet) return 'setup';
  if (!ready || !wallets.length) return null;
  return wallets.some((w) => w.usable) ? null : 'connect';
}

export function ConnectWalletButton({ variant }: { variant: 'sidebar' | 'mobile' }) {
  const need = useNeedsWallet();
  const { active } = useMemberWallets();
  if (!need) return null;
  const go = () => (need === 'setup' ? openModal({ type: 'onboard' }) : openConnectWallet(active?.address));
  if (variant === 'mobile')
    return (
      <button className="btn btn-white btn-sm" onClick={go}>
        <Icon name="wallet" size={14} />
        Connect wallet
      </button>
    );
  return (
    <div className="sb-wallet">
      <button className="btn btn-glass btn-block" aria-label="Connect wallet" title="Connect wallet" onClick={go}>
        <Icon name="wallet" />
        <span className="nl">Connect wallet</span>
      </button>
    </div>
  );
}
