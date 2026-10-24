/**
 * The operator sweep against a real anvil chain and the indexer: the operator holds another member's keys, has
 * key and launchpad earnings, an open airdrop and its own launchpad tokens; one sweep turns all of it into ETH and
 * tops up another wallet's gas, and a second sweep finds nothing left.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { createWalletClient, erc20Abi, getContractAddress, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildAirdrop, swayChain } from '@sway/shared';
import { swayKeysAbi, swayLaunchpadAbi } from '@sway/shared/abi';
import { quoteWei } from '@sway/curve';
import { prisma } from '@sway/db';
import { startChain, KEYS, type TestChain } from './anvil';
import { loadConfig } from '../src/config';
import { makeClients, type Clients } from '../src/clients';
import { Indexer } from '../src/indexer/indexer';
import { sweep } from '../src/sweep';

let chain: TestChain;
let c: Clients;
const lc = (a: string) => a.toLowerCase();

beforeAll(async () => {
  // Its own port: other files' anvils may still be shutting down.
  chain = await startChain(8550);
  Object.assign(process.env, {
    CHAIN_ID: String(chain.chainId),
    RPC_URL: chain.rpcUrl,
    SWAY_KEYS_ADDRESS: chain.deployment.swayKeys,
    FAN_ESCROW_ADDRESS: chain.deployment.fanEscrow,
    SWAY_STAKING_ADDRESS: chain.deployment.swayStaking,
    GENESIS_PASS_ADDRESS: chain.deployment.genesisPass,
    LAUNCHPAD_ADDRESS: chain.deployment.launchpad,
    DROPS_ADDRESS: chain.deployment.drops,
    OPERATOR_PRIVATE_KEY: KEYS[0],
    INDEXER_START_BLOCK: '0',
    INDEXER_CONFIRMATIONS: '0',
  });
  await prisma.indexerCursor.deleteMany();
  await prisma.indexedBlock.deleteMany();
  c = makeClients(loadConfig(), new Redis('redis://localhost:6379/15'));
}, 180_000);

afterAll(async () => {
  // Later files launch on fresh chains too, at the same token address.
  await prisma.launchToken.deleteMany({ where: { user: { handle: 'opacct' } } });
  chain?.stop();
  await c?.redis.quit();
  await prisma.$disconnect();
});

describe('operator sweep', () => {
  it('turns keys, earnings, creator fees, an airdrop and tokens into ETH, and tops up gas', async () => {
    const keys = chain.deployment.swayKeys as Address;
    const pad = chain.deployment.launchpad as Address;
    const viemChain = swayChain({ chainId: chain.chainId, rpcUrl: chain.rpcUrl });
    const op = chain.wallet(0);
    const fresh = async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      await chain.test.setBalance({ address: account.address, value: parseEther('5') });
      return Object.assign(createWalletClient({ chain: viemChain, account, transport: http(chain.rpcUrl) }), { address: account.address });
    };
    const bob = await fresh();
    const carol = privateKeyToAccount(generatePrivateKey()).address;
    const wait = async (hash: Hex) => chain.pub.waitForTransactionReceipt({ hash });
    const write = async (w: typeof bob | typeof op, req: Record<string, unknown>) => wait(await w.writeContract({ chain: viemChain, account: w.account!, ...req } as never));

    for (const [handle, xId, address] of [['opacct', 990001n, op.address], ['bobacct', 990002n, bob.address]] as const) {
      await prisma.user.create({ data: { xId: xId.toString(), handle, name: handle, joinedAt: new Date(), memberNo: Number(xId), wallet: { create: { address: lc(address), kind: 'embedded' } } } });
      await write(op, { address: keys, abi: swayKeysAbi, functionName: 'openMarket', args: [address, xId] });
    }
    // Bob buys the operator's keys (creator and holder earnings), the operator buys Bob's (keys to sell).
    await write(bob, { address: keys, abi: swayKeysAbi, functionName: 'buy', args: [op.address, 300n], value: quoteWei(100n, 'buy', 300n).total });
    await write(op, { address: keys, abi: swayKeysAbi, functionName: 'buy', args: [bob.address, 200n], value: quoteWei(100n, 'buy', 200n).total });

    // The operator launches a token with an airdrop it can claim; Bob and the operator buy on the curve.
    const drop = buildAirdrop([{ address: op.address, units: 100n }, { address: bob.address, units: 300n }], 100_000_000n * 10n ** 18n);
    // Fresh chains give the first launch the same token address: drop an earlier file's mirror of it.
    const predicted = getContractAddress({ from: pad, nonce: BigInt(await chain.pub.getTransactionCount({ address: pad })) });
    await prisma.launchToken.deleteMany({ where: { tokenAddress: lc(predicted) } });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const digest = (await chain.pub.readContract({
      address: pad, abi: swayLaunchpadAbi, functionName: 'launchDigest', args: [op.address, 'Op', 'OPT', 10n ** 18n, 20n * 10n ** 18n, drop.root, deadline],
    })) as Hex;
    const signature = await privateKeyToAccount(KEYS[0]!).sign({ hash: digest });
    await write(op, { address: pad, abi: swayLaunchpadAbi, functionName: 'launch', args: ['Op', 'OPT', 10n ** 18n, 20n * 10n ** 18n, drop.root, deadline, signature] });
    const token = (await chain.pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'tokenOf', args: [op.address] })) as Address;
    expect(lc(token)).toBe(lc(predicted));
    await write(bob, { address: pad, abi: swayLaunchpadAbi, functionName: 'buy', args: [token, 0n], value: parseEther('0.1') });
    await write(op, { address: pad, abi: swayLaunchpadAbi, functionName: 'buy', args: [token, 0n], value: parseEther('0.05') });

    const indexer = new Indexer(c);
    for (let i = 0; i < 20; i++) if (!(await indexer.tick())) break;
    const lt = await prisma.launchToken.findFirstOrThrow({ where: { tokenAddress: lc(token) } });
    const mine = drop.entries.find((e) => lc(e.address) === lc(op.address))!;
    await prisma.launchAirdrop.create({ data: { launchTokenId: lt.id, address: lc(op.address), amount: mine.amount.toString(), proof: mine.proof } });

    const before = await chain.pub.getBalance({ address: op.address });
    const asked: string[] = [];
    const ctx = {
      prisma, pub: chain.pub as never, wallet: op as never, keys, launchpad: pad,
      confirm: async (q: string) => (asked.push(q), true), log: () => undefined, eth: (w: bigint) => w.toString(),
    };
    const done = await sweep(ctx, [{ address: carol, label: '@carol', wei: 30_000_000_000_000n }]);

    expect(done.soldKeys).toBeGreaterThan(0n);
    expect(done.claimedKeys).toBeGreaterThan(0n);
    expect(done.creatorFees).toBeGreaterThan(0n);
    expect(done.airdrops).toBe(1);
    expect(done.soldTokens).toBeGreaterThan(0n);
    expect(done.toppedUp).toBe(30_000_000_000_000n);
    // Nothing left on chain, and the ETH landed in the operator wallet (less gas and the top-up).
    expect(await chain.pub.readContract({ address: keys, abi: swayKeysAbi, functionName: 'balanceOf', args: [bob.address, op.address] })).toBe(0n);
    expect((await chain.pub.readContract({ address: keys, abi: swayKeysAbi, functionName: 'claimable', args: [op.address, [op.address]] })) as readonly bigint[]).toEqual([0n, 0n, 0n, 0n]);
    expect(await chain.pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'creatorFees', args: [op.address] })).toBe(0n);
    expect(await chain.pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'airdropClaimed', args: [token, op.address] })).toBe(true);
    expect(await chain.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [op.address] })).toBe(0n);
    expect(await chain.pub.getBalance({ address: carol })).toBe(30_000_000_000_000n);
    const gained = done.soldKeys + done.claimedKeys + done.creatorFees + done.soldTokens - done.toppedUp;
    const after = await chain.pub.getBalance({ address: op.address });
    expect(after - before).toBeLessThanOrEqual(gained);
    expect(after - before).toBeGreaterThan(gained - parseEther('0.01'));

    // A second sweep has nothing to ask about.
    asked.length = 0;
    for (let i = 0; i < 20; i++) if (!(await indexer.tick())) break;
    await sweep(ctx, [{ address: carol, label: '@carol', wei: 30_000_000_000_000n }]);
    expect(asked).toEqual([]);
  });
});
