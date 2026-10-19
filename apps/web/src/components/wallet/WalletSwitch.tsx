'use client';
/** [A] Trade sheet "Pay with" / "Sell from": the active wallet with its logo, and a switcher over the member's wallets. */
import { unitsToKeys, weiToEth } from '@sway/curve';
import { shortAddress, type WalletBalanceDTO } from '@sway/shared';
import { useEffect, useRef, useState } from 'react';
import { useFormat } from '@/lib/format';
import { type MemberWallet } from '@/lib/wallet';
import { openConnectWallet } from '@/lib/wallet-actions';
import { Icon } from '../icons';
import { WalletLogo } from './WalletLogo';

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function WalletSwitch({
  label,
  wallets,
  active,
  balances,
  unitsOf,
  onPick,
}: {
  label: string;
  wallets: MemberWallet[];
  active: MemberWallet;
  balances: WalletBalanceDTO[] | undefined;
  /** Keys of this market per wallet (sell side), else null. */
  unitsOf: ((address: string) => bigint) | null;
  onPick: (address: string) => void;
}) {
  const F = useFormat();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);
  const cash = (a: string) => {
    const b = balances?.find((x) => same(x.address, a));
    return b ? F.$(weiToEth(b.cashWei)) : '…';
  };
  const more = wallets.length > 1;
  return (
    <div className="wsw" ref={ref}>
      <div className="wallet-r" style={{ alignItems: 'center', marginBottom: 8 }}>
        <span>{label}</span>
        <button className="wsel" aria-label={`${label}: ${active.name} ${shortAddress(active.address)}`} aria-expanded={open} onClick={() => (more ? setOpen(!open) : !active.usable && openConnectWallet(active.address))}>
          <WalletLogo connector={active.connector} kind={active.kind} size={20} />
          <b>{active.name}</b>
          <span className="t3">{shortAddress(active.address)}</span>
          {more && <Icon name="chev" />}
        </button>
      </div>
      {open && (
        <div className="wsel-l" role="listbox" aria-label="Your wallets">
          {wallets.map((w) => {
            const on = same(w.address, active.address);
            const units = unitsOf ? unitsOf(w.address) : null;
            return (
              <button
                key={w.address}
                role="option"
                aria-selected={on}
                className={`wsel-o ${on ? 'on' : ''}`}
                onClick={() => {
                  setOpen(false);
                  if (!w.usable) return openConnectWallet(w.address);
                  onPick(w.address);
                }}
              >
                <WalletLogo connector={w.connector} kind={w.kind} size={32} />
                <span className="wopt-t">
                  <b>
                    {w.name}
                    {w.account && <span className="tag line">Account</span>}
                  </b>
                  <small>
                    {shortAddress(w.address)}
                    {!w.usable ? ' · not connected here' : units !== null ? ` · ${F.keys(unitsToKeys(units))} keys` : ''}
                  </small>
                </span>
                <span className="num">
                  <b>{w.usable ? cash(w.address) : 'Connect'}</b>
                </span>
                {on && <Icon name="check" className="wsel-ck" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
