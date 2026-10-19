/**
 * [C] The launch flow on a real chain: a private anvil (port 8563) with SwayKeys, SwayLaunchpad, a dev $SWAY
 * and SwayStaking deployed from contracts/out. The API's attestation must match SwayLaunchpad.launchDigest and
 * be accepted by launch(); the stored proofs must claim; the TS curve must match quoteBuy/quoteSell to the wei;
 * the faucet and /api/staking must follow the staking contract. Skipped when anvil or the artifacts are missing
 * (run `forge build` in contracts/).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  erc20Abi,
  hashTypedData,
  http,
  recoverTypedDataAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { quoteWei } from '@sway/curve';
import {
  DEV_FAUCET_SWAY,
  LAUNCH_HOLDER_ALLOCATION,
  LAUNCH_TYPES,
  launchDomain,
  launchMinOut,
  launchQuoteBuy,
  launchQuoteSell,
  swayChain,
  type AirdropsResponse,
  type LaunchAttestation,
  type LaunchTokenDTO,
  type LaunchTokenResponse,
  type LaunchpadResponse,
  type StakingResponse,
} from '@sway/shared';
import { swayKeysAbi, swayLaunchpadAbi, swayStakingAbi } from '@sway/shared/abi';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { MemoryJobQueue } from '../src/services/jobs';
import { resetOfficialCache } from '../src/services/notify';
import { resetPriceMemo } from '../src/services/price';
import { FakeChain, TEST_ENV, login, prisma, resetState } from './helpers';

const PORT = 8563;
const RPC = `http://127.0.0.1:${PORT}`;
const OUT = resolve(__dirname, '../../../contracts/out');
const KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];
const E18 = 10n ** 18n;
const artifact = (file: string, name: string) => resolve(OUT, file, `${name}.json`);
const ARTIFACTS = [
  artifact('SwayKeys.sol', 'SwayKeys'),
  artifact('SwayLaunchpad.sol', 'SwayLaunchpad'),
  artifact('SwayStaking.sol', 'SwayStaking'),
  artifact('Deploy.s.sol', 'DevSway'),
];
const hasAnvil = spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;
const ready = hasAnvil && ARTIFACTS.every((f) => existsSync(f));

const chain = swayChain({ chainId: 31337, rpcUrl: RPC });
const pub = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
const wallet = (i: number) =>
  createWalletClient({ chain, account: privateKeyToAccount(KEYS[i]!), transport: http(RPC) });
const op = wallet(0);
const alice = wallet(1);
const bob = wallet(2);
const lower = (a: string) => a.toLowerCase() as Address;

let anvil: ChildProcess | null = null;
let app: BuiltApp;
let redis: Redis;
let c: { keys: Address; pad: Address; sway: Address; staking: Address };
let cookies: { alice: string; bob: string };

async function send(
  w: ReturnType<typeof wallet>,
  address: Address,
  abi: Abi | readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
  value?: bigint,
) {
  const hash = await w.writeContract({
    address,
    abi: abi as Abi,
    functionName,
    args,
    value,
    chain,
    account: w.account!,
  } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  expect(r.status).toBe('success');
  return hash;
}

async function deploy(file: string, name: string, args: readonly unknown[]): Promise<Address> {
  const j = JSON.parse(readFileSync(artifact(file, name), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const hash = await op.deployContract({
    abi: j.abi,
    bytecode: j.bytecode.object,
    args,
    chain,
    account: op.account!,
  } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  return lower(r.contractAddress!);
}

const get = async <T>(url: string, cookie?: string) => {
  const r = await app.inject({ url, headers: cookie ? { cookie } : {} });
  expect(r.statusCode, r.body).toBe(200);
  return r.json<T>();
};
const post = async <T>(url: string, cookie: string) => {
  const r = await app.inject({ method: 'POST', url, headers: { cookie } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json<T>();
};
const curveOf = (t: LaunchTokenDTO) => ({
  virtualEth: BigInt(t.virtualEthWei),
  ethReserve: BigInt(t.ethReserveWei),
  tokenReserve: BigInt(t.tokenReserve),
});

describe.skipIf(!ready)('launch flow on anvil', () => {
  beforeAll(async () => {
    anvil = spawn('anvil', ['--port', String(PORT), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const operator = op.account!.address;
    const keys = await deploy('SwayKeys.sol', 'SwayKeys', [operator, operator]);
    await send(op, keys, swayKeysAbi, 'setOperator', [operator, true]);
    const sway = await deploy('Deploy.s.sol', 'DevSway', [operator]);
    const staking = await deploy('SwayStaking.sol', 'SwayStaking', [
      operator,
      sway,
      [1_000n * E18, 10_000n * E18, 50_000n * E18, 250_000n * E18],
    ]);
    const pad = await deploy('SwayLaunchpad.sol', 'SwayLaunchpad', [operator, keys, operator]);
    c = { keys, pad, sway, staking };

    const config = loadConfig({
      ...TEST_ENV,
      RPC_URL: RPC,
      SWAY_KEYS_ADDRESS: keys,
      LAUNCHPAD_ADDRESS: pad,
      SWAY_STAKING_ADDRESS: staking,
      OPERATOR_PRIVATE_KEY: KEYS[0]!,
    });
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
    resetOfficialCache();
    resetPriceMemo();
    // FakeChain stands in for SwayKeys reads; launchpad and staking go through the real ViemLaunchChain.
    app = await buildApp({ config, prisma, redis, chain: new FakeChain(), jobs: new MemoryJobQueue() });
    await app.ready();
    await resetState(redis);

    const a = await login({ app } as never, 'alicelaunch');
    const b = await login({ app } as never, 'boblaunch');
    cookies = { alice: a.cookie, bob: b.cookie };
    const aAddr = lower(alice.account!.address);
    const bAddr = lower(bob.account!.address);
    await prisma.wallet.create({ data: { userId: a.user.id, address: aAddr, kind: 'embedded' } });
    await prisma.wallet.create({ data: { userId: b.user.id, address: bAddr, kind: 'embedded' } });

    // Alice's market onchain, Bob buys two keys; the Holding mirror as the indexer writes it.
    await send(op, keys, swayKeysAbi, 'openMarket', [aAddr, BigInt(a.user.xId)]);
    await send(bob, keys, swayKeysAbi, 'buy', [aAddr, 200n], quoteWei(100n, 'buy', 200n).total);
    const m = await prisma.keyMarket.create({
      data: {
        subject: aAddr,
        userId: a.user.id,
        xId: a.user.xId,
        opened: true,
        claimed: true,
        supplyUnits: 300n,
        holders: 2,
      },
    });
    await prisma.holding.createMany({
      data: [
        { marketId: m.id, address: aAddr, units: 100n },
        { marketId: m.id, address: bAddr, units: 200n },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    anvil?.kill();
  });

  it('attests, launches, trades to the wei, claims fees and the airdrop', async () => {
    const aAddr = lower(alice.account!.address);
    const bAddr = lower(bob.account!.address);
    const preview = await get<LaunchpadResponse>('/api/launchpad', cookies.alice);
    expect(preview.terms!.holders.map((h) => [h.address, h.amount])).toEqual([
      [bAddr, LAUNCH_HOLDER_ALLOCATION.toString()],
    ]);

    const att = await post<LaunchAttestation>('/api/launchpad/attest', cookies.alice);
    const message = {
      creator: aAddr,
      name: att.name,
      symbol: att.symbol,
      startCapWei: BigInt(att.startCapWei),
      graduationCapWei: BigInt(att.graduationCapWei),
      airdropRoot: att.airdropRoot,
      deadline: BigInt(att.deadline),
    };
    const digest = await pub.readContract({
      address: c.pad,
      abi: swayLaunchpadAbi,
      functionName: 'launchDigest',
      args: [
        message.creator,
        message.name,
        message.symbol,
        message.startCapWei,
        message.graduationCapWei,
        message.airdropRoot,
        message.deadline,
      ],
    });
    expect(
      hashTypedData({
        domain: launchDomain(31337, c.pad),
        types: LAUNCH_TYPES,
        primaryType: 'Launch',
        message,
      }),
    ).toBe(digest);
    const signer = await recoverTypedDataAddress({
      domain: launchDomain(31337, c.pad),
      types: LAUNCH_TYPES,
      primaryType: 'Launch',
      message,
      signature: att.signature,
    });
    expect(lower(signer)).toBe(lower(op.account!.address));

    await send(alice, c.pad, swayLaunchpadAbi, 'launch', [
      att.name,
      att.symbol,
      message.startCapWei,
      message.graduationCapWei,
      att.airdropRoot,
      message.deadline,
      att.signature,
    ]);
    const token = lower(
      (await pub.readContract({
        address: c.pad,
        abi: swayLaunchpadAbi,
        functionName: 'tokenOf',
        args: [aAddr],
      })) as string,
    );

    // Before any indexer: GET /api/launchpad finds it through tokenOf and reads the curve live.
    let lp = await get<LaunchpadResponse>('/api/launchpad', cookies.alice);
    expect(lp).toMatchObject({ launched: true, tokenAddress: token });
    expect(lp.token!.source).toBe('chain');
    expect(lp.token!.marketCapWei).toBe(
      String(
        await pub.readContract({
          address: c.pad,
          abi: swayLaunchpadAbi,
          functionName: 'marketCap',
          args: [token],
        }),
      ),
    );

    // Buy: the TS quote equals quoteBuy, minTokensOut with 1% slippage.
    const ethIn = 10n ** 16n;
    const qTs = launchQuoteBuy(curveOf(lp.token!), ethIn);
    const qChain = (await pub.readContract({
      address: c.pad,
      abi: swayLaunchpadAbi,
      functionName: 'quoteBuy',
      args: [token, ethIn],
    })) as readonly [bigint, bigint];
    expect([qTs.tokensOut, qTs.fee]).toEqual([...qChain]);
    await send(bob, c.pad, swayLaunchpadAbi, 'buy', [token, launchMinOut(qTs.tokensOut)], ethIn);
    let view = await get<LaunchTokenResponse>('/api/launchpad/tokens/alicelaunch', cookies.bob);
    expect(view.token!.balances).toEqual([
      { address: bAddr, balance: qTs.tokensOut.toString(), allowance: '0' },
    ]);
    expect(view.token!.ethReserveWei).toBe((ethIn - qTs.fee).toString());

    // Sell half after approving the launchpad.
    const half = qTs.tokensOut / 2n;
    await send(bob, token, erc20Abi, 'approve', [c.pad, half]);
    view = await get<LaunchTokenResponse>('/api/launchpad/tokens/alicelaunch', cookies.bob);
    expect(view.token!.balances[0]!.allowance).toBe(half.toString());
    const sTs = launchQuoteSell(curveOf(view.token!), half);
    const sChain = (await pub.readContract({
      address: c.pad,
      abi: swayLaunchpadAbi,
      functionName: 'quoteSell',
      args: [token, half],
    })) as readonly [bigint, bigint];
    expect([sTs.ethOut, sTs.fee]).toEqual([...sChain]);
    await send(bob, c.pad, swayLaunchpadAbi, 'sell', [token, half, launchMinOut(sTs.ethOut)]);

    // Creator fees accrue and are claimable.
    lp = await get<LaunchpadResponse>('/api/launchpad', cookies.alice);
    expect(lp.token!.creatorFeesWei).toBe((qTs.fee + sTs.fee).toString());
    await send(alice, c.pad, swayLaunchpadAbi, 'claimCreatorFees');
    expect((await get<LaunchpadResponse>('/api/launchpad', cookies.alice)).token!.creatorFeesWei).toBe('0');

    // The stored proof claims onchain; then the allocation drops out of the list.
    const drops = await get<AirdropsResponse>('/api/launchpad/airdrops', cookies.bob);
    expect(drops.allocations).toHaveLength(1);
    const d = drops.allocations[0]!;
    expect(d).toMatchObject({
      token,
      address: bAddr,
      walletKind: 'account',
      amount: LAUNCH_HOLDER_ALLOCATION.toString(),
    });
    const before = await pub.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [bAddr],
    });
    await send(bob, c.pad, swayLaunchpadAbi, 'claimAirdrop', [token, BigInt(d.amount), d.proof]);
    const after = await pub.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [bAddr],
    });
    expect(after - before).toBe(LAUNCH_HOLDER_ALLOCATION);
    expect((await get<AirdropsResponse>('/api/launchpad/airdrops', cookies.bob)).allocations).toEqual([]);
    // Launched: a second attestation is refused.
    const again = await app.inject({
      method: 'POST',
      url: '/api/launchpad/attest',
      headers: { cookie: cookies.alice },
    });
    expect(again.json().error).toBe('already_launched');
  });

  it('faucet $SWAY, then stake, request unstake, cooldown and withdraw', async () => {
    const bAddr = lower(bob.account!.address);
    const f = await post<{ txHash: string; swayTxHash?: string }>('/api/dev/faucet', cookies.bob);
    expect(f.swayTxHash).toMatch(/^0x/);
    let s = await get<StakingResponse>('/api/staking', cookies.bob);
    expect(s).toMatchObject({
      enabled: true,
      address: bAddr,
      tokenAddress: c.sway,
      balanceWei: DEV_FAUCET_SWAY.toString(),
      level: 0,
      stakedWei: '0',
    });
    expect(s.levels.map((l) => l.thresholdWei)).toEqual(
      [1_000n, 10_000n, 50_000n, 250_000n].map((v) => (v * E18).toString()),
    );

    const amount = 1_000n * E18;
    await send(bob, c.sway, erc20Abi, 'approve', [c.staking, amount]);
    expect((await get<StakingResponse>('/api/staking', cookies.bob)).allowanceWei).toBe(amount.toString());
    await send(bob, c.staking, swayStakingAbi, 'stake', [amount]);
    s = await get<StakingResponse>('/api/staking', cookies.bob);
    expect(s).toMatchObject({
      level: 1,
      stakedWei: amount.toString(),
      totalStakedWei: amount.toString(),
      balanceWei: (DEV_FAUCET_SWAY - amount).toString(),
    });

    await send(bob, c.staking, swayStakingAbi, 'requestUnstake', [amount]);
    s = await get<StakingResponse>('/api/staking', cookies.bob);
    expect(s).toMatchObject({
      level: 0,
      stakedWei: '0',
      unstakingWei: amount.toString(),
      canWithdraw: false,
    });
    expect(new Date(s.unlockAt!).getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);

    await testClient.increaseTime({ seconds: 7 * 86400 + 1 });
    await testClient.mine({ blocks: 1 });
    expect((await get<StakingResponse>('/api/staking', cookies.bob)).canWithdraw).toBe(true);
    await send(bob, c.staking, swayStakingAbi, 'withdraw');
    s = await get<StakingResponse>('/api/staking', cookies.bob);
    expect(s).toMatchObject({ unstakingWei: '0', unlockAt: null, balanceWei: DEV_FAUCET_SWAY.toString() });
  });
});
