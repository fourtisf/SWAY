'use client';
/** [C] Sway token staking: balance, stake, level and perks, cooldown, staker rewards. */
import { ethToWei, weiToEth } from '@sway/curve';
import { LOCAL_CHAIN_ID, STAKING_LEVELS, type StakingResponse } from '@sway/shared';
import { useState } from 'react';
import { Empty, Loading, NeedUser, Spinner } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { fmtTokens, tokensInput, useLaunchActions } from '@/lib/launch-actions';
import { useConfig, useMe, useStaking } from '@/lib/queries';
import { openModal, useClock } from '@/lib/store';
import { TOKEN } from '@/lib/token';

const levelAt = (s: StakingResponse, staked: bigint) => s.levels.reduce((lv, l) => (staked >= BigInt(l.thresholdWei) ? l.level : lv), 0);
const nameOf = (level: number) => STAKING_LEVELS[level]?.name ?? 'None';

function untilText(iso: string, now: number) {
  const s = Math.max(0, (new Date(iso).getTime() - now) / 1000);
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export default function StakingPage() {
  const me = useMe();
  const { data: s } = useStaking();
  const cfg = useConfig().data;
  const F = useFormat();
  const act = useLaunchActions();
  const now = useClock((c) => c.now);
  const [mode, setMode] = useState<'stake' | 'unstake'>('stake');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  if (me.isPending || !s) return <Loading />;
  if (!me.data) return <NeedUser title={`Connect X to stake ${TOKEN.the}`} text={`Stake ${TOKEN.the} for a level that cuts the protocol fee on your key trades and unlocks 2,000-character posts.`} />;
  if (!me.data.wallet)
    return (
      <Empty
        icon="wallet"
        title="Finish setting up your wallet"
        action={
          <button className="btn btn-white" onClick={() => openModal({ type: 'onboard' })}>
            Create my Sway wallet
          </button>
        }
      >
        {TOKEN.The} is staked from your Sway wallet on Robinhood Chain.
      </Empty>
    );
  // Mainnet deploys without staking: it needs the Sway token, which the official account launches first.
  if (!s.stakingAddress)
    return (
      <Empty icon="rocket" title="Staking isn’t open yet">
        Staking opens on this network once {TOKEN.the} is live.
      </Empty>
    );

  const balance = BigInt(s.balanceWei),
    staked = BigInt(s.stakedWei),
    unstaking = BigInt(s.unstakingWei),
    rewards = BigInt(s.pendingRewardsWei);
  let amount = 0n;
  try {
    amount = ethToWei(text.replace(',', '.') || '0');
  } catch {
    amount = 0n;
  }
  const stake = mode === 'stake';
  const max = stake ? balance : staked;
  const after = levelAt(s, stake ? staked + amount : staked - (amount > staked ? staked : amount));
  const bad = amount <= 0n || amount > max || !s.enabled;
  const cur = STAKING_LEVELS[s.level] ?? STAKING_LEVELS[0];
  const next = s.levels.find((l) => l.level === s.level + 1);
  const run = async (k: string, fn: () => Promise<boolean>) => {
    setBusy(k);
    const ok = await fn();
    setBusy(null);
    if (ok && k === 'form') setText('');
  };
  const local = cfg?.chainId === LOCAL_CHAIN_ID;

  return (
    <>
      <div className="bal">
        <div className="bal-in">
          <div className="between">
            <span className="t2" style={{ fontWeight: 600, fontSize: 13.5 }}>
              Staked {TOKEN.unit}
            </span>
            <span className={`tag ${s.level ? 'aqua' : 'line'}`}>{s.level ? `Level ${s.level} ${cur.name}` : 'No level yet'}</span>
          </div>
          <div className="bal-v">{fmtTokens(staked)}</div>
          <div className="t3" style={{ fontSize: 13 }}>
            {s.level
              ? `−${Math.round(cur.cut * 100)}% protocol fee on your key trades and 2,000-character posts`
              : next
                ? `Stake ${fmtTokens(next.thresholdWei)} ${TOKEN.unit} for ${next.name}: −${Math.round(next.cut * 100)}% protocol fee and 2,000-character posts`
                : ''}
          </div>
        </div>
      </div>

      <div className="glass earn">
        <div className="between">
          <div>
            <div className="t3" style={{ fontSize: 12.5, fontWeight: 600 }}>
              Staker rewards
            </div>
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.04em' }}>{F.$(weiToEth(rewards))}</div>
          </div>
          <button className="btn btn-buy" disabled={rewards === 0n || !!busy} onClick={() => run('claim', () => act.claimRewards(s))}>
            {busy === 'claim' ? <Spinner /> : 'Claim'}
          </button>
        </div>
        <div style={{ marginTop: 10 }}>
          <div className="earn-r">
            <span>In your wallet</span>
            <b>{fmtTokens(balance)} {TOKEN.unit}</b>
          </div>
          <div className="earn-r" style={{ alignItems: 'center' }}>
            <span>{unstaking > 0n ? (s.canWithdraw ? 'Ready to withdraw' : `Unstaking, unlocks in ${untilText(s.unlockAt!, now)}`) : 'Unstaking'}</span>
            <span className="row">
              <b>{fmtTokens(unstaking)} {TOKEN.unit}</b>
              {unstaking > 0n && (
                <button className="btn btn-glass btn-sm" disabled={!s.canWithdraw || !!busy} onClick={() => run('withdraw', () => act.withdraw(s))}>
                  {busy === 'withdraw' ? <Spinner /> : 'Withdraw'}
                </button>
              )}
            </span>
          </div>
          <div className="earn-r" style={{ alignItems: 'center' }}>
            <span>Total staked</span>
            <span className="row">
              <b>{fmtTokens(s.totalStakedWei)} {TOKEN.unit}</b>
              <button className="btn btn-glass btn-sm" disabled={!s.enabled || !!busy} onClick={() => run('harvest', () => act.harvest(s))}>
                {busy === 'harvest' ? <Spinner /> : 'Harvest'}
              </button>
            </span>
          </div>
        </div>
        <div className="t3" style={{ fontSize: 12.5, marginTop: 6 }}>
          Stakers share half of the protocol fee, paid in ETH. Harvest pulls the latest share from the key contract. Staker rewards are variable and may be zero.
        </div>
      </div>

      <div className="glass earn" id="stakeForm">
        <div className="between" style={{ marginBottom: 14 }}>
          <div className="seg">
            <button className={stake ? 'on' : ''} onClick={() => (setMode('stake'), setText(''))}>
              Stake
            </button>
            <button className={!stake ? 'on' : ''} onClick={() => (setMode('unstake'), setText(''))}>
              Unstake
            </button>
          </div>
          {local && balance === 0n && stake ? (
            <button className="btn btn-glass btn-sm" disabled={!!busy} onClick={() => run('faucet', () => act.faucet())}>
              {busy === 'faucet' ? <Spinner /> : `Get test ${TOKEN.unit}`}
            </button>
          ) : null}
        </div>
        <div className="amt-l">
          <span>{stake ? `${TOKEN.name} to stake` : `${TOKEN.name} to unstake`}</span>
          <span>{stake ? `In your wallet ${fmtTokens(balance)}` : `Staked ${fmtTokens(staked)}`}</span>
        </div>
        <div className="amt">
          <input id="stakeAmt" inputMode="decimal" aria-label={stake ? `${TOKEN.name} to stake` : `${TOKEN.name} to unstake`} placeholder="0" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="quick">
          {(['25', '50', '100'] as const).map((p) => (
            <button key={p} className="chip" disabled={max === 0n} onClick={() => setText(tokensInput((max * BigInt(p)) / 100n))}>
              {p === '100' ? 'Max' : `${p}%`}
            </button>
          ))}
        </div>
        <div className="sum">
          <div className="sum-r tot">
            <span>Level after</span>
            <span>
              <b>{after ? `${after} ${nameOf(after)}` : 'None'}</b>
            </span>
          </div>
          <div className="sum-r">
            <span>Protocol fee cut</span>
            <span>−{Math.round((STAKING_LEVELS[after]?.cut ?? 0) * 100)}%</span>
          </div>
          {!stake && (
            <div className="sum-r">
              <span>Cooldown</span>
              <span>{Math.round(s.cooldownSeconds / 86400)} days</span>
            </div>
          )}
        </div>
        <button
          className={`btn btn-lg btn-block ${stake ? 'btn-white' : 'btn-glass'}`}
          disabled={bad || !!busy}
          onClick={() => run('form', () => (stake ? act.stake(s, amount) : act.requestUnstake(s, amount)))}
        >
          {busy === 'form' ? (
            <>
              <Spinner />
              Confirming…
            </>
          ) : !s.enabled ? (
            'Staking isn’t live on this chain yet'
          ) : amount <= 0n ? (
            'Enter an amount'
          ) : amount > max ? (
            stake ? `Not enough ${TOKEN.unit}` : 'More than you staked'
          ) : stake ? (
            BigInt(s.allowanceWei) < amount ? `Approve and stake ${fmtTokens(amount)} ${TOKEN.unit}` : `Stake ${fmtTokens(amount)} ${TOKEN.unit}`
          ) : (
            `Request unstake of ${fmtTokens(amount)} ${TOKEN.unit}`
          )}
        </button>
        <div className="disc">Requesting an unstake drops your level right away and starts a 7-day cooldown.</div>
      </div>

      <div className="sec-h">
        <h2>Levels</h2>
        <span className="t3" style={{ fontSize: 13 }}>
          Read from the staking contract
        </span>
      </div>
      {s.levels.map((l) => (
        <div key={l.level} className={`tr ${l.level === s.level ? 'me' : ''}`} style={{ gridTemplateColumns: '44px minmax(0,1fr) auto' }}>
          <span className="rk">L{l.level}</span>
          <div style={{ minWidth: 0 }}>
            <div className="nm">
              <b>{l.name}</b>
              {l.level === s.level ? (
                <span className="tag aqua" style={{ marginLeft: 6 }}>
                  Your level
                </span>
              ) : null}
            </div>
            <div className="hd" style={{ fontSize: 13.5 }}>{`−${Math.round(l.cut * 100)}% protocol fee, ${l.postMax.toLocaleString('en-US')}-character posts`}</div>
          </div>
          <div className="num">
            <b>{fmtTokens(l.thresholdWei)}</b>
            <small>{TOKEN.name}</small>
          </div>
        </div>
      ))}
      <div style={{ padding: '14px 16px 18px' }}>
        <div className="note">The protocol fee is 2% of every key trade: half to {TOKEN.name} stakers, half to the treasury. Your level cuts what you pay by 10, 25, 50 or 75%.</div>
      </div>
    </>
  );
}
