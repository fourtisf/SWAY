/**
 * The Wallet page's "Move everything" (moveAll in @sway/shared) against a real anvil chain: a member's wallet with
 * key earnings, an open airdrop, its own launchpad tokens and creator fees ends up empty, its ETH at another address.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, erc20Abi, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildAirdrop, moveAll, swayChain, type MoveAllWallet } from '@sway/shared';
import { swayKeysAbi, swayLaunchpadAbi } from '@sway/shared/abi';
import { quoteWei } from '@sway/curve';
import { startChain, KEYS, type TestChain } from './anvil';

let chain: TestChain;

beforeAll(async () => {
  // Its own port: other files' anvils may still be shutting down.
  chain = await startChain(8551);
}, 180_000);

afterAll(() => chain?.stop());

describe('move everything', () => {
  it('empties a wallet into another address', async () => {
    const keys = chain.deployment.swayKeys as Address;
    const pad = chain.deployment.launchpad as Address;
    const viemChain = swayChain({ chainId: chain.chainId, rpcUrl: chain.rpcUrl });
    const op = chain.wallet(0);
    const fresh = async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      await chain.test.setBalance({ address: account.address, value: parseEther('1') });
      return Object.assign(createWalletClient({ chain: viemChain, account, transport: http(chain.rpcUrl) }), { address: account.address });
    };
    const [me, fan] = [await fresh(), await fresh()];
    const dest = privateKeyToAccount(generatePrivateKey()).address;
    const wait = async (hash: Hex) => {
      const r = await chain.pub.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error(`reverted ${hash}`);
    };
    const write = async (w: typeof me | typeof op, req: Record<string, unknown>) => wait(await w.writeContract({ chain: viemChain, account: w.account!, ...req } as never));

    await write(op, { address: keys, abi: swayKeysAbi, functionName: 'openMarket', args: [me.address, 770001n] });
    await write(fan, { address: keys, abi: swayKeysAbi, functionName: 'buy', args: [me.address, 300n], value: quoteWei(100n, 'buy', 300n).total });
    const drop = buildAirdrop([{ address: me.address, units: 100n }, { address: fan.address, units: 300n }], 100_000_000n * 10n ** 18n);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const digest = (await chain.pub.readContract({
      address: pad, abi: swayLaunchpadAbi, functionName: 'launchDigest', args: [me.address, 'Me', 'MEE', 10n ** 18n, 20n * 10n ** 18n, drop.root, deadline],
    })) as Hex;
    const signature = await privateKeyToAccount(KEYS[0]!).sign({ hash: digest });
    await write(me, { address: pad, abi: swayLaunchpadAbi, functionName: 'launch', args: ['Me', 'MEE', 10n ** 18n, 20n * 10n ** 18n, drop.root, deadline, signature] });
    const token = (await chain.pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'tokenOf', args: [me.address] })) as Address;
    await write(fan, { address: pad, abi: swayLaunchpadAbi, functionName: 'buy', args: [token, 0n], value: parseEther('0.1') });
    await write(me, { address: pad, abi: swayLaunchpadAbi, functionName: 'buy', args: [token, 0n], value: parseEther('0.05') });

    const wallet: MoveAllWallet = {
      address: me.address,
      writeContract: (call) => me.writeContract({ chain: viemChain, account: me.account, ...call } as never),
      claim: (subjects) => me.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'claim', args: [subjects], chain: viemChain, account: me.account } as never),
      sendEth: (to, wei) => me.sendTransaction({ to, value: wei, chain: viemChain, account: me.account } as never),
      waitForReceipt: wait,
    };
    const mine = drop.entries.find((e) => e.address.toLowerCase() === me.address.toLowerCase())!;
    const steps: string[] = [];
    const r = await moveAll({
      wallet,
      to: dest,
      chain: { chainId: chain.chainId, rpcUrl: chain.rpcUrl, swayKeys: keys, launchpad: pad },
      claimSubjects: [me.address],
      tokens: [token],
      airdrops: [{ address: me.address, token, amount: mine.amount.toString(), proof: mine.proof, symbol: 'MEE' }],
      onStep: (s) => steps.push(s),
    });

    expect(steps.filter((x) => !x.startsWith('Checking'))).toEqual(['Claiming the $MEE airdrop…', 'Approving $MEE…', 'Selling $MEE…', 'Claiming key earnings…', 'Claiming creator fees…', 'Sending your ETH…']);
    expect(steps[0]).toBe('Checking airdrops…');
    expect(r.soldWei).toBeGreaterThan(0n);
    expect(r.claimedWei).toBeGreaterThan(0n);
    expect(await chain.pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'airdropClaimed', args: [token, me.address] })).toBe(true);
    expect(await chain.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [me.address] })).toBe(0n);
    expect(await chain.pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'creatorFees', args: [me.address] })).toBe(0n);
    expect((await chain.pub.readContract({ address: keys, abi: swayKeysAbi, functionName: 'claimable', args: [me.address, [me.address]] })) as readonly bigint[]).toEqual([0n, 0n, 0n, 0n]);
    // The ETH is at the destination; what stays is the gas reserve, less the transfer's own gas.
    expect(await chain.pub.getBalance({ address: dest })).toBe(r.sentWei);
    expect(r.sentWei).toBeGreaterThan(parseEther('0.9'));
    const left = await chain.pub.getBalance({ address: me.address });
    expect(left).toBeLessThan(parseEther('0.01'));

    // Again: nothing left to sell or claim, and too little ETH to be worth sending.
    const again = await moveAll({
      wallet, to: dest, chain: { chainId: chain.chainId, rpcUrl: chain.rpcUrl, swayKeys: keys, launchpad: pad }, claimSubjects: [me.address], tokens: [token], airdrops: [],
    });
    expect(again).toEqual({ soldWei: 0n, claimedWei: 0n, sentWei: 0n, sendHash: null });
  });
});
