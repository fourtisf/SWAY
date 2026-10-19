import { quoteWei } from '@sway/curve';
import { DEV_FAUCET_SWAY, LAUNCH_HOLDER_ALLOCATION, launchMinOut, launchQuoteBuy, launchQuoteSell } from '@sway/shared';
import { swayLaunchpadAbi, swayStakingAbi } from '@sway/shared/abi';
import { erc20Abi } from 'viem';
import { describe, expect, it } from 'vitest';
import { curveOf } from '../launch-actions';
import { mockWallet } from '../wallet/mock';
import { getMockApi, getWorld } from './index';
import { MOCK_LAUNCHPAD, mockLaunchHooks } from './launch';

const E18 = 10n ** 18n;

describe('[C] mock launchpad', () => {
  it('launch → buy → sell to the wei, creator fees, a seeded live token', async () => {
    const api = getMockApi();
    const me = await api.devLogin({ handle: 'launcher', followers: 5000 });
    const lp = await api.launchpad();
    expect(lp.terms).toMatchObject({ symbol: 'LAUNCH', creatorOnly: true });
    expect(lp.terms!.holders.map((h) => h.amount)).toEqual([LAUNCH_HOLDER_ALLOCATION.toString()]);
    const a = await api.launchAttest();
    const w = mockWallet(me.wallet!.address);
    const cfg = await api.config();
    expect(cfg.contracts.launchpad).toBe(MOCK_LAUNCHPAD);
    await w.writeContract({
      address: a.launchpad,
      abi: swayLaunchpadAbi,
      functionName: 'launch',
      args: [a.name, a.symbol, BigInt(a.startCapWei), BigInt(a.graduationCapWei), a.airdropRoot, BigInt(a.deadline), a.signature],
    });
    const t = (await api.launchpad()).token!;
    expect(t).toMatchObject({ symbol: 'LAUNCH', isMine: true, graduated: false, progress: 0 });
    await expect(api.launchAttest()).rejects.toThrow(/already live/);

    const q = launchQuoteBuy(curveOf(t), E18 / 100n);
    await w.writeContract({ address: MOCK_LAUNCHPAD, abi: swayLaunchpadAbi, functionName: 'buy', args: [t.address, launchMinOut(q.tokensOut)], value: E18 / 100n });
    const t2 = (await api.launchpad()).token!;
    expect(t2.balances[0]!.balance).toBe(q.tokensOut.toString());
    expect(t2.creatorFeesWei).toBe(q.fee.toString());
    // Selling needs an allowance first, like the ERC-20.
    const half = q.tokensOut / 2n;
    await expect(w.writeContract({ address: MOCK_LAUNCHPAD, abi: swayLaunchpadAbi, functionName: 'sell', args: [t.address, half, 0n] })).rejects.toThrow(/Allowance/);
    await w.writeContract({ address: t.address, abi: erc20Abi, functionName: 'approve', args: [MOCK_LAUNCHPAD, half] });
    const s = launchQuoteSell(curveOf(t2), half);
    await w.writeContract({ address: MOCK_LAUNCHPAD, abi: swayLaunchpadAbi, functionName: 'sell', args: [t.address, half, launchMinOut(s.ethOut)] });
    const t3 = (await api.launchpad()).token!;
    expect(t3.balances[0]!.balance).toBe((q.tokensOut - half).toString());
    expect(t3.creatorFeesWei).toBe((q.fee + s.fee).toString());
    await w.writeContract({ address: MOCK_LAUNCHPAD, abi: swayLaunchpadAbi, functionName: 'claimCreatorFees' });
    expect((await api.launchpad()).token!.creatorFeesWei).toBe('0');

    const mako = await api.launchToken('makotrades');
    expect(mako).toMatchObject({ launched: true, symbol: '$MAKOTR' });
    expect(BigInt(mako.token!.ethReserveWei)).toBeGreaterThan(0n);
  });

  it('a creator whose keys you hold launches: claim the airdrop once', async () => {
    const api = getMockApi();
    const w0 = getWorld();
    const me = await api.devLogin({ handle: 'holder', followers: 1000 });
    const w = mockWallet(me.wallet!.address);
    const p = await api.profile('novareyes');
    const q = quoteWei(BigInt(p.supplyUnits), 'buy', 100n);
    await w.buy(p.subject, 100n, q.total);
    mockLaunchHooks(w0).launchCreator('novareyes');
    const r = await api.launchAirdrops();
    expect(r.allocations).toHaveLength(1);
    const d = r.allocations[0]!;
    expect(d).toMatchObject({ symbol: 'NOVARE', address: me.wallet!.address, walletKind: 'account' });
    const t = (await api.launchToken('novareyes')).token!;
    await w.writeContract({ address: MOCK_LAUNCHPAD, abi: swayLaunchpadAbi, functionName: 'claimAirdrop', args: [d.token, BigInt(d.amount), d.proof] });
    expect((await api.launchAirdrops()).allocations).toEqual([]);
    expect((await api.launchToken('novareyes')).token!.balances[0]!.balance).toBe(d.amount);
    expect(t.address).toBe(d.token);
    await expect(
      w.writeContract({ address: MOCK_LAUNCHPAD, abi: swayLaunchpadAbi, functionName: 'claimAirdrop', args: [d.token, BigInt(d.amount), d.proof] }),
    ).rejects.toThrow(/AlreadyClaimed/);
  });
});

describe('[C] mock staking and Genesis list', () => {
  it('faucet → approve + stake → level → request unstake → cooldown → withdraw', async () => {
    const api = getMockApi();
    const world = getWorld();
    const me = await api.devLogin({ handle: 'staker', followers: 1000 });
    const w = mockWallet(me.wallet!.address);
    await api.faucet();
    let s = await api.staking();
    expect(BigInt(s.balanceWei)).toBeGreaterThanOrEqual(DEV_FAUCET_SWAY);
    const amt = 1_000n * E18;
    await w.writeContract({ address: s.tokenAddress!, abi: erc20Abi, functionName: 'approve', args: [s.stakingAddress!, amt] });
    await w.writeContract({ address: s.stakingAddress!, abi: swayStakingAbi, functionName: 'stake', args: [amt] });
    s = await api.staking();
    expect(s).toMatchObject({ level: 1, stakedWei: amt.toString() });
    expect((await api.me())!.stakingLevel).toBe(1);
    await w.writeContract({ address: s.stakingAddress!, abi: swayStakingAbi, functionName: 'requestUnstake', args: [amt] });
    s = await api.staking();
    expect(s).toMatchObject({ level: 0, unstakingWei: amt.toString(), canWithdraw: false });
    await expect(w.writeContract({ address: s.stakingAddress!, abi: swayStakingAbi, functionName: 'withdraw' })).rejects.toThrow(/Cooling/);
    mockLaunchHooks(world).warp(7 * 86400);
    expect((await api.staking()).canWithdraw).toBe(true);
    await w.writeContract({ address: s.stakingAddress!, abi: swayStakingAbi, functionName: 'withdraw' });
    expect((await api.staking()).unstakingWei).toBe('0');
  });

  it('freezes a Genesis list with the integer 1/√rank split', async () => {
    const api = getMockApi();
    await expect(api.genesisLatest()).rejects.toThrow(/No Genesis snapshot/);
    const id = mockLaunchHooks(getWorld()).freezeGenesis();
    const l = await api.genesisLatest();
    expect(l.snapshotId).toBe(id);
    expect(l.rows.reduce((s, r) => s + BigInt(r.units), 0n)).toBe(BigInt(l.poolUnits));
    expect(l.rows[0]!.rank).toBe(1);
    const g = await api.genesis();
    expect(g).toMatchObject({ frozen: true, snapshotId: id });
    expect((await api.genesisSnapshot(id)).count).toBe(l.count);
  });
});
