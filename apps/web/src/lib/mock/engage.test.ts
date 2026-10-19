import { ethToWei } from '@sway/curve';
import { swayDropsAbi } from '@sway/shared/abi';
import { describe, expect, it } from 'vitest';
import type { ContractCall } from '../wallet/types';
import { MOCK_DROPS } from './engage';
import { getMockApi, getWorld } from './index';

describe('[D] mock engagement', () => {
  it('watches, checks in once a day, and claims a creator drop through the wallet hook', async () => {
    const api = getMockApi();
    const w = getWorld();
    await api.devLogin({ handle: 'engage_mock', followers: 2000 });
    const h = Object.keys(w.C).find((k) => w.C[k]!.claimed && !w.C[k]!.isMe)!;

    await api.watch(h, { alertPct: 10 });
    expect((await api.watchlist()).items.map((x) => [x.handle, x.alertPct])).toEqual([[h, 10]]);
    await expect(api.watch(h, { alertPct: 3 })).rejects.toThrow();
    await api.unwatch(h);
    expect((await api.watchlist()).items).toHaveLength(0);

    expect(await api.checkIn()).toMatchObject({ days: 1, awarded: 100, checkedInToday: true });
    expect((await api.checkIn()).awarded).toBe(0);

    w.execTrade(h, 'buy', 150n);
    expect((await api.config()).contracts.drops).toBe(MOCK_DROPS);
    const [d] = await api.claimableDrops();
    expect(d).toBeDefined();
    expect(BigInt((await api.userDrops(d!.creator.handle))[0]!.totalWei)).toBe(ethToWei(0.05));
    const claim = (amount: bigint): ContractCall =>
      ({ address: d!.contract, abi: swayDropsAbi, functionName: 'claim', args: [BigInt(d!.id), amount, d!.proof] }) as ContractCall;

    expect(() => w.mockContractWrite!(claim(BigInt(d!.amountWei) + 1n))).toThrow('BadProof');
    const before = w.eth;
    w.mockContractWrite!(claim(BigInt(d!.amountWei)));
    expect(w.eth).toBeGreaterThan(before);
    expect(await api.claimableDrops()).toHaveLength(0);
    expect(() => w.mockContractWrite!(claim(BigInt(d!.amountWei)))).toThrow('AlreadyClaimed');
  });
});
