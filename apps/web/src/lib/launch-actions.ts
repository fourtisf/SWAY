'use client';
/**
 * [C] Launchpad and staking actions through the SwayWallet: attest → launch from the account wallet, token
 * buys/sells with 1% slippage (approve first when needed), creator fees, key-holder airdrop claims, and $SWAY
 * approve/stake/unstake/withdraw/harvest/claim. The token view reads the chain live, so a refetch after the
 * receipt is enough; launches poll GET /api/launchpad until the token shows.
 */
import { erc20Abi, formatUnits, type Hex } from 'viem';
import { useQueryClient } from '@tanstack/react-query';
import {
  launchMinOut,
  launchQuoteBuy,
  launchQuoteSell,
  shortAddress,
  type Address,
  type AirdropAllocationDTO,
  type AirdropsResponse,
  type LaunchTokenDTO,
  type StakingResponse,
} from '@sway/shared';
import { swayLaunchpadAbi, swayStakingAbi } from '@sway/shared/abi';
import { errorMessage, getApi, isAuthRequired } from './api';
import { qk, qkLaunch, useConfig, useMe } from './queries';
import { closeModal, openModal, toast } from './store';
import { useMemberWallets, useSwayWallet, type SwayWallet } from './wallet';
import { openConnectWallet } from './wallet-actions';

const api = () => getApi();
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const curveOf = (t: LaunchTokenDTO) => ({
  virtualEth: BigInt(t.virtualEthWei),
  ethReserve: BigInt(t.ethReserveWei),
  tokenReserve: BigInt(t.tokenReserve),
});

/** The token view's balance row for this wallet (or the first wallet). */
export const balanceOf = (t: LaunchTokenDTO, address?: string | null) =>
  t.balances.find((b) => same(b.address, address)) ?? t.balances[0] ?? null;

/** Token amount → "12.5M" / "350K" / "12.34". */
export function fmtTokens(v: bigint | string): string {
  const x = Number(BigInt(v)) / 1e18;
  if (x === 0) return '0';
  if (x >= 1e9) return (x / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (x >= 1e6) return (x / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (x >= 1e3) return (x / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return x >= 1 ? x.toFixed(2).replace(/\.?0+$/, '') : x.toPrecision(3);
}
/** Exact decimal token amount for inputs (round-trips through ethToWei without float error). */
export const tokensInput = (v: bigint | string): string => formatUnits(BigInt(v), 18);

export function useLaunchActions() {
  const qc = useQueryClient();
  const me = useMe().data ?? null;
  const config = useConfig().data;
  const { wallet, status } = useSwayWallet();
  const { wallets } = useMemberWallets();

  const fail = (e: unknown) => {
    if (!isAuthRequired(e)) toast(errorMessage(e));
  };

  /**
   * The active wallet, or with `address` the member's wallet at that address (the one that owns the market,
   * the airdrop allocation or the stake), whether or not it is the active one.
   */
  const needWallet = (address?: string | null): SwayWallet | null => {
    if (!me) {
      openModal({ type: 'connect' });
      return null;
    }
    const owner = address ? wallets.find((w) => same(w.address, address)) : null;
    if (owner?.wallet) return owner.wallet;
    if (owner && owner.status === 'needs-external') {
      openConnectWallet(owner.address);
      return null;
    }
    if (!wallet) {
      if (status === 'none') openModal({ type: 'onboard' });
      else if (status === 'needs-external') openConnectWallet();
      else if (status === 'missing-key') toast('Your Sway wallet key isn’t on this device');
      else toast('Embedded wallets aren’t available yet. Use your own wallet.');
      return null;
    }
    if (address && !same(wallet.address, address)) {
      toast(`Switch to wallet ${shortAddress(address)} to continue`);
      return null;
    }
    return wallet;
  };

  const launchpad = (): Address => {
    const a = config?.contracts.launchpad;
    if (!a) throw new Error('The launchpad isn’t deployed on this chain yet');
    return a;
  };

  const refreshToken = async (t: LaunchTokenDTO) => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: qk.launchpad }),
      qc.invalidateQueries({ queryKey: qkLaunch.token(t.creator.handle) }),
      qc.invalidateQueries({ queryKey: qk.wallet }),
    ]);
  };

  const send = async (w: SwayWallet, call: Parameters<SwayWallet['writeContract']>[0]): Promise<Hex> => {
    const hash = await w.writeContract(call);
    await w.waitForReceipt(hash);
    return hash;
  };

  return {
    needWallet,

    /** Attest, launch from the account wallet, then wait for the token to show. */
    async launch(onStep?: (s: 'attest' | 'sign' | 'mine' | 'index') => void): Promise<boolean> {
      const w = needWallet(me?.wallet?.address);
      if (!w) return false;
      try {
        onStep?.('attest');
        const a = await api().launchAttest();
        if (!same(w.address, a.creator)) {
          toast(`Launch from your account wallet ${shortAddress(a.creator)}`);
          return false;
        }
        onStep?.('sign');
        // Nobody has bought the creator's keys yet: open the market onchain first (the launchpad checks it).
        if (a.permit) await w.waitForReceipt(await w.register(a.permit));
        const hash = await w.writeContract({
          address: a.launchpad,
          abi: swayLaunchpadAbi,
          functionName: 'launch',
          args: [a.name, a.symbol, BigInt(a.startCapWei), BigInt(a.graduationCapWei), a.airdropRoot, BigInt(a.deadline), a.signature],
        });
        onStep?.('mine');
        await w.waitForReceipt(hash);
        onStep?.('index');
        for (let i = 0; i < 30; i++) {
          const lp = await api()
            .launchpad()
            .catch(() => null);
          if (lp?.token) {
            qc.setQueryData(qk.launchpad, lp);
            break;
          }
          await sleep(1000);
        }
        closeModal();
        toast(`$${a.symbol} is live`);
        await Promise.all([qc.invalidateQueries({ queryKey: qk.launchpad }), qc.invalidateQueries({ queryKey: ['launchToken'] }), qc.invalidateQueries({ queryKey: qk.wallet })]);
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async buy(t: LaunchTokenDTO, ethIn: bigint): Promise<boolean> {
      const w = needWallet();
      if (!w) return false;
      try {
        const q = launchQuoteBuy(curveOf(t), ethIn);
        if (q.tokensOut <= 0n) throw new Error('Enter an amount');
        await send(w, { address: launchpad(), abi: swayLaunchpadAbi, functionName: 'buy', args: [t.address, launchMinOut(q.tokensOut)], value: ethIn });
        toast(`Bought ${fmtTokens(q.tokensOut)} $${t.symbol}`);
        await refreshToken(t);
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async sell(t: LaunchTokenDTO, tokensIn: bigint): Promise<boolean> {
      const w = needWallet();
      if (!w) return false;
      try {
        const pad = launchpad();
        const bal = balanceOf(t, w.address);
        if (!bal || BigInt(bal.allowance) < tokensIn) {
          toast(`Approving $${t.symbol}…`);
          await send(w, { address: t.address, abi: erc20Abi, functionName: 'approve', args: [pad, tokensIn] });
        }
        const q = launchQuoteSell(curveOf(t), tokensIn);
        await send(w, { address: pad, abi: swayLaunchpadAbi, functionName: 'sell', args: [t.address, tokensIn, launchMinOut(q.ethOut)] });
        toast(`Sold ${fmtTokens(tokensIn)} $${t.symbol}`);
        await refreshToken(t);
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async claimCreatorFees(t: LaunchTokenDTO): Promise<boolean> {
      const w = needWallet(t.creatorAddress);
      if (!w) return false;
      try {
        await send(w, { address: launchpad(), abi: swayLaunchpadAbi, functionName: 'claimCreatorFees' });
        toast('Claimed creator fees');
        await refreshToken(t);
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    /** Claims from the wallet that owns the allocation; drops it from the list right after the receipt. */
    async claimAirdrop(a: AirdropAllocationDTO, pad: Address | null): Promise<boolean> {
      const w = needWallet(a.address);
      if (!w) return false;
      try {
        await send(w, {
          address: pad ?? launchpad(),
          abi: swayLaunchpadAbi,
          functionName: 'claimAirdrop',
          args: [a.token, BigInt(a.amount), a.proof],
        });
        qc.setQueryData<AirdropsResponse>(qkLaunch.airdrops, (o) =>
          o ? { ...o, allocations: o.allocations.filter((x) => !(same(x.token, a.token) && same(x.address, a.address))) } : o,
        );
        toast(`Claimed ${fmtTokens(a.amount)} $${a.symbol}`);
        await Promise.all([qc.invalidateQueries({ queryKey: ['launchToken'] }), qc.invalidateQueries({ queryKey: qk.launchpad }), qc.invalidateQueries({ queryKey: qk.wallet })]);
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    /* ------------------------------------------------------------ staking */

    async stake(s: StakingResponse, amount: bigint): Promise<boolean> {
      const w = needWallet(s.address);
      if (!w || !s.stakingAddress || !s.tokenAddress) return false;
      try {
        if (BigInt(s.allowanceWei) < amount) {
          toast('Approving $SWAY…');
          await send(w, { address: s.tokenAddress, abi: erc20Abi, functionName: 'approve', args: [s.stakingAddress, amount] });
        }
        await send(w, { address: s.stakingAddress, abi: swayStakingAbi, functionName: 'stake', args: [amount] });
        toast(`Staked ${fmtTokens(amount)} $SWAY`);
        await afterStake();
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async requestUnstake(s: StakingResponse, amount: bigint): Promise<boolean> {
      return stakingCall(s, 'requestUnstake', [amount], `Unstaking ${fmtTokens(amount)} $SWAY. Withdraw after the 7-day cooldown.`);
    },
    async withdraw(s: StakingResponse): Promise<boolean> {
      return stakingCall(s, 'withdraw', [], 'Withdrew your unstaked $SWAY');
    },
    async harvest(s: StakingResponse): Promise<boolean> {
      return stakingCall(s, 'harvest', [], 'Harvested the stakers’ protocol share');
    },
    async claimRewards(s: StakingResponse): Promise<boolean> {
      return stakingCall(s, 'claimRewards', [], 'Claimed staker rewards');
    },

    async faucet(): Promise<boolean> {
      try {
        await api().faucet();
        toast('Added test funds and 10,000 $SWAY');
        await Promise.all([qc.invalidateQueries({ queryKey: qkLaunch.staking }), qc.invalidateQueries({ queryKey: qk.wallet })]);
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
  };

  async function afterStake() {
    await Promise.all([qc.invalidateQueries({ queryKey: qkLaunch.staking }), qc.invalidateQueries({ queryKey: qk.wallet })]);
    // The level drives the post limit and the fee cut: refresh `me` until the indexer has mirrored it.
    void (async () => {
      for (let i = 0; i < 10; i++) {
        await sleep(1500);
        await qc.invalidateQueries({ queryKey: qk.me });
      }
    })();
  }

  async function stakingCall(s: StakingResponse, functionName: string, args: readonly unknown[], done: string): Promise<boolean> {
    const w = needWallet(s.address);
    if (!w || !s.stakingAddress) return false;
    try {
      await send(w, { address: s.stakingAddress, abi: swayStakingAbi, functionName, args });
      toast(done);
      await afterStake();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }
}
