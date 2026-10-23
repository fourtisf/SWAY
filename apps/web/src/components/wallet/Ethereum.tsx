'use client';
/**
 * ETH on Ethereum for the member's wallets (same addresses) and the one-tap move to Robinhood Chain through the
 * chain's own bridge (lib/wallet/parent). Shown when ConfigDTO.parentChain is set (mainnet and testnet).
 */
import { usdToWei, weiToEth } from '@sway/curve';
import { minutesSince, shortAddress, type Address, type ConfigDTO, type ParentChainDTO } from '@sway/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { useEthUsd, useFormat } from '@/lib/format';
import { invalidateMoney, useConfig, useMe } from '@/lib/queries';
import { closeModal, openModal, toast } from '@/lib/store';
import { useMemberWallets } from '@/lib/wallet';
import { addArriving, arrivingOf, depositFeeCap, moveFromParent, parentBalances, useArriving, type Arriving } from '@/lib/wallet/parent';
import { copyAddress, openConnectWallet } from '@/lib/wallet-actions';
import { Icon } from '../icons';
import { Spinner } from '../ui';
import { WalletChips } from './WalletModals';

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';

export function useParentBalances(p: ParentChainDTO | null | undefined, addresses: Address[]) {
  const key = addresses.map((a) => a.toLowerCase()).join(',');
  return useQuery({
    queryKey: ['parentBalances', p?.chainId ?? 0, key],
    queryFn: () => parentBalances(p!, addresses),
    enabled: !!p && addresses.length > 0,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

function useArrivingList(userId: string | undefined): Arriving[] {
  useArriving((s) => (userId ? s.byUser[userId] : undefined));
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  return userId ? arrivingOf(userId) : [];
}

export function EthLogo({ size = 40 }: { size?: number }) {
  return (
    <span className="eth-logo" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 24 24" width={size * 0.56} height={size * 0.56}>
        <path d="M12 2 5.6 12.4 12 16.2l6.4-3.8z" fill="currentColor" />
        <path d="M12 17.4 5.6 13.6 12 22l6.4-8.4z" fill="currentColor" opacity=".7" />
      </svg>
    </span>
  );
}

const txUrl = (p: ParentChainDTO, hash: string) => (p.explorerUrl ? `${p.explorerUrl.replace(/\/$/, '')}/tx/${hash}` : null);

/** Wallet page: what the member's wallets hold on Ethereum, moves on their way, and the Move button. */
export function EthereumCard() {
  const cfg = useConfig().data;
  const me = useMe().data;
  const F = useFormat();
  const qc = useQueryClient();
  const { wallets } = useMemberWallets();
  const p = cfg?.parentChain;
  const q = useParentBalances(p, wallets.map((w) => w.address));
  const bal = q.data;
  const arriving = useArrivingList(me?.user.id);
  const waiting = arriving.length > 0;
  useEffect(() => {
    // While a move is on its way, refresh the Robinhood Chain balances so it shows up when it lands.
    if (!waiting) return;
    const t = setInterval(() => void invalidateMoney(qc), 30_000);
    return () => clearInterval(t);
  }, [waiting, qc]);
  if (!p || !cfg || !wallets.length) return null;
  const total = bal ? Object.values(bal).reduce((a, b) => a + b, 0n) : null;
  const held = bal ? wallets.filter((w) => (bal[w.address.toLowerCase()] ?? 0n) > 0n).length : 0;
  const chainName = cfg.chainName || 'Robinhood Chain';
  return (
    <div className="glass eth-card" id="eth-card">
      <div className="between">
        <div className="row" style={{ gap: 12, minWidth: 0 }}>
          <EthLogo />
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 15 }}>On {p.name}</b>
            <div className="t3" style={{ fontSize: 13 }}>
              {total === null ? (q.isError ? `Can’t reach ${p.name} right now` : '…') : `${F.eth(weiToEth(total))} ETH`}
              {held > 1 ? ` · ${held} wallets` : ''}
            </div>
          </div>
        </div>
        <b className="eth-v" aria-label={`On ${p.name}`}>
          {total === null ? '…' : F.$(weiToEth(total))}
        </b>
      </div>
      {arriving.map((a) => {
        const url = txUrl(p, a.hash);
        const m = minutesSince(new Date(a.at).toISOString());
        return (
          <div key={a.hash} className="eth-arr">
            <Spinner size={12} />
            <span>
              {F.$(weiToEth(a.wei))} on its way to {chainName} · sent {m < 1 ? 'just now' : `${F.ago(m)} ago`}
              {url && (
                <>
                  {' · '}
                  <a className="lnk" href={url} target="_blank" rel="noopener noreferrer">
                    View
                  </a>
                </>
              )}
            </span>
          </div>
        );
      })}
      <button className="btn btn-white btn-block" style={{ marginTop: 12 }} onClick={() => openModal({ type: 'bridgeIn' })}>
        <Icon name="down" />
        Move to {chainName}
      </button>
      <div className="t3" style={{ fontSize: 12.5, marginTop: 8 }}>
        Same address on both networks. No Sway fee, only {p.name}’s network fee. Lands in about 10–15 minutes.
      </div>
    </div>
  );
}

/** "Move to Robinhood Chain": amount in dollars (Max keeps the network fee back), then depositEth from that wallet. */
export function MoveFromEthereumModal() {
  const cfg = useConfig().data;
  const me = useMe().data;
  const F = useFormat();
  const ethUsd = useEthUsd();
  const qc = useQueryClient();
  const { wallets, active } = useMemberWallets();
  const p = cfg?.parentChain;
  const bal = useParentBalances(p, wallets.map((w) => w.address)).data;
  const [pick, setPick] = useState<string | null>(null);
  const [amt, setAmt] = useState('');
  const [maxed, setMaxed] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'sign' | 'confirm'>('idle');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Start on the wallet holding the most ETH on Ethereum.
  const richest = bal
    ? [...wallets].sort((a, b) => {
        const d = (bal[b.address.toLowerCase()] ?? 0n) - (bal[a.address.toLowerCase()] ?? 0n);
        return d > 0n ? 1 : d < 0n ? -1 : 0;
      })[0]
    : undefined;
  const from = pick ?? (richest && (bal?.[richest.address.toLowerCase()] ?? 0n) > 0n ? richest.address : (active?.address ?? null));
  const w = wallets.find((x) => same(x.address, from));
  const fee = useQuery({
    queryKey: ['parentFee', p?.chainId ?? 0, from],
    queryFn: () => depositFeeCap(p!, from as Address),
    enabled: !!p && !!from,
    staleTime: 30_000,
  }).data;
  if (!p || !cfg || !from || !w) return null;
  const have = bal?.[from.toLowerCase()];
  const max = have !== undefined && fee !== undefined && have > fee ? have - fee : 0n;
  const wei = maxed ? max : usdToWei(parseFloat(amt) || 0, ethUsd);
  const chainName = cfg.chainName || 'Robinhood Chain';
  const busy = phase !== 'idle';
  const empty = have === 0n;

  const send = async () => {
    if (!w.wallet) return w.kind === 'external' ? openConnectWallet(w.address) : openModal({ type: 'walletImport' });
    if (!(wei > 0n)) return toast('Enter an amount');
    if (wei > max) return toast(`Up to ${F.$(weiToEth(max))}: the rest pays ${p.name}’s network fee`);
    setPhase('sign');
    try {
      const hash = await moveFromParent(w.wallet, cfg, wei);
      if (alive.current) setPhase('confirm');
      await w.wallet.parent!.waitForReceipt(hash);
      if (me) addArriving(me.user.id, { hash, address: w.address, wei: wei.toString(), at: Date.now() });
      if (alive.current) closeModal();
      toast(`On its way: ${F.$(weiToEth(wei))} lands on ${chainName} in about 10–15 minutes`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['parentBalances'] }), invalidateMoney(qc)]);
    } catch (e) {
      toast(errorMessage(e));
    }
    if (alive.current) setPhase('idle');
  };

  return (
    <>
      <div className="m-h">
        <h3>Move to {chainName}</h3>
        <button className="x-btn" aria-label="Close" onClick={closeModal}>
          <Icon name="close" />
        </button>
      </div>
      <div className="m-b">
        {wallets.length > 1 && (
          <WalletChips
            wallets={wallets}
            value={from}
            onChange={(a) => {
              setPick(a);
              setMaxed(false);
            }}
          />
        )}
        <div className="mv-route">
          <div>
            <small>From {p.name}</small>
            <b id="mv-have">{have === undefined ? '…' : F.$(weiToEth(have))}</b>
            <span className="t3">{have === undefined ? '' : `${F.eth(weiToEth(have))} ETH`}</span>
          </div>
          <Icon name="chevR" size={20} />
          <div>
            <small>To {chainName}</small>
            <b>{w.name}</b>
            <span className="t3">{shortAddress(w.address)}, same address</span>
          </div>
        </div>
        {empty ? (
          <>
            <div className="note" style={{ margin: '4px 0 12px' }}>
              No ETH on {p.name} in this wallet yet. Send ETH on {p.name} to this address, then move it here.
            </div>
            <button className="btn btn-glass btn-block" onClick={() => copyAddress(w.address)}>
              <Icon name="copy" />
              Copy address
            </button>
          </>
        ) : (
          <>
            <label className="lbl" htmlFor="mv-a">
              Amount (USD)
            </label>
            <div className="amt" style={{ marginBottom: 6 }}>
              <input
                id="mv-a"
                inputMode="decimal"
                placeholder="0.00"
                style={{ fontSize: 28 }}
                autoFocus
                value={amt}
                onChange={(e) => {
                  setAmt(e.target.value);
                  setMaxed(false);
                }}
              />
            </div>
            <div className="row t3" style={{ fontSize: 12.5, justifyContent: 'space-between', marginBottom: 14 }}>
              <span>{wei > 0n ? `≈ ${F.eth(weiToEth(wei))} ETH` : `Available ${F.$(weiToEth(max))}`}</span>
              <button
                className="lnk"
                disabled={!(max > 0n)}
                onClick={() => {
                  setAmt((Math.floor(weiToEth(max) * ethUsd * 100) / 100).toFixed(2));
                  setMaxed(true);
                }}
              >
                Max
              </button>
            </div>
            <div className="sum">
              <div className="sum-r">
                <span>{p.name} network fee</span>
                <b>{fee === undefined ? '…' : `about ${F.$(weiToEth(fee / 2n))}`}</b>
              </div>
              <div className="sum-r">
                <span>Sway fee</span>
                <b>None</b>
              </div>
              <div className="sum-r">
                <span>Lands in</span>
                <b>about 10–15 min</b>
              </div>
            </div>
            <button className="btn btn-white btn-lg btn-block" id="mv-go" disabled={busy || (!!w.wallet && !(wei > 0n))} onClick={send}>
              {busy ? <Spinner /> : null}
              {phase === 'sign'
                ? `Confirm in ${w.kind === 'external' ? w.name : 'your wallet'}…`
                : phase === 'confirm'
                  ? `Confirming on ${p.name}…`
                  : !w.wallet
                    ? w.kind === 'external'
                      ? 'Connect this wallet'
                      : 'Import its key'
                    : wei > 0n
                      ? `Move ${F.$(weiToEth(wei))}`
                      : 'Move'}
            </button>
          </>
        )}
        <p className="t3" style={{ fontSize: 12.5, margin: '12px 0 0' }}>
          Uses {chainName}’s own bridge on {p.name}: the ETH arrives at the same address.{' '}
          <a className="lnk" href={jumperUrl(cfg)} target="_blank" rel="noopener noreferrer">
            Coming from another network?
          </a>
        </p>
      </div>
    </>
  );
}

const jumperUrl = (cfg: ConfigDTO) => `https://jumper.exchange/?toChain=${cfg.chainId}&toToken=${ZERO}`;
