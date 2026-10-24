'use client';
/**
 * "Move everything" on the Wallet page: the active wallet sells its launchpad tokens, claims its airdrops, key
 * earnings and creator fees, then sends all its ETH to one address (moveAll in @sway/shared). A Sway wallet signs
 * each step itself; a wallet app asks for each.
 */
import { weiToEth } from '@sway/curve';
import { moveAll, shortAddress, type Address } from '@sway/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage, getApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useConfig, useWallet } from '@/lib/queries';
import { toast } from '@/lib/store';
import { useSwayWallet } from '@/lib/wallet';
import { Spinner } from '../ui';

export function MoveAllCard() {
  const cfg = useConfig().data;
  const { wallet } = useSwayWallet();
  const { data: w } = useWallet(!!wallet);
  const qc = useQueryClient();
  const F = useFormat();
  const [to, setTo] = useState('');
  const [step, setStep] = useState<string | null>(null);
  if (!cfg || !wallet || !w) return null;
  const valid = /^0x[0-9a-fA-F]{40}$/.test(to) && to.toLowerCase() !== wallet.address.toLowerCase();

  const go = async () => {
    const ok = window.confirm(
      `Sell the launchpad tokens in ${shortAddress(wallet.address)}, claim its airdrops, earnings and creator fees, and send all its ETH to ${shortAddress(to)}? Keys stay where they are.`,
    );
    if (!ok) return;
    setStep('Starting…');
    try {
      const api = getApi();
      const [pad, drops] = await Promise.all([api.launchpad().catch(() => null), api.launchAirdrops().catch(() => null)]);
      const r = await moveAll({
        wallet,
        to: to as Address,
        chain: { chainId: cfg.chainId, rpcUrl: cfg.rpcUrl, swayKeys: cfg.contracts.swayKeys ?? null, launchpad: cfg.contracts.launchpad ?? null },
        claimSubjects: w.earnings.claimSubjects,
        tokens: [pad?.tokenAddress],
        airdrops: drops?.allocations ?? [],
        onStep: setStep,
      });
      if (r.sendHash)
        await api.withdrawLog({ label: 'Withdrawal to external wallet', amountWei: (-r.sentWei).toString(), txHash: r.sendHash }).catch(() => undefined);
      toast(r.sentWei > 0n ? `Sent ${F.$(weiToEth(r.sentWei.toString()))} to ${shortAddress(to)}` : 'Nothing left to send');
      await qc.invalidateQueries();
    } catch (e) {
      toast(errorMessage(e));
    }
    setStep(null);
  };

  return (
    <div className="glass earn" id="moveAllCard">
      <div style={{ fontWeight: 750, fontSize: 16 }}>Move everything to another wallet</div>
      <div className="t3" style={{ fontSize: 13, margin: '4px 0 10px' }}>
        Sells the launchpad tokens in this wallet ({shortAddress(wallet.address)}), claims its airdrops, key earnings and creator fees, then sends all
        its ETH, keeping only that transfer’s gas. Keys stay: sell them from Your keys first.
      </div>
      <input
        className="field mono"
        placeholder="0x… address to send to"
        aria-label="Send everything to"
        style={{ marginBottom: 8 }}
        value={to}
        disabled={!!step}
        onChange={(e) => setTo(e.target.value.trim())}
      />
      <button className="btn btn-buy" style={{ width: '100%' }} disabled={!valid || !!step} onClick={go}>
        {step ? (
          <>
            <Spinner /> {step}
          </>
        ) : (
          'Sell, claim and send all'
        )}
      </button>
    </div>
  );
}
