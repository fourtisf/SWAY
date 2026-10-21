/**
 * [C] Mock mode for the launchpad, staking and the Genesis list: token curves with the exact SwayLaunchpad
 * math (@sway/shared launch.ts), real merkle airdrops, $SWAY staking with the 7-day cooldown, and a frozen
 * Genesis list. Contract calls arrive through MockWorld.mockContractWrite (SwayWallet.writeContract).
 */
import { ethToWei, weiToEth } from '@sway/curve';
import { allocateGenesis } from '@sway/scoring';
import {
  DEV_FAUCET_SWAY,
  LAUNCH_HOLDER_ALLOCATION,
  LAUNCH_TOTAL_SUPPLY,
  POST_MAX_STAKED,
  STAKING_COOLDOWN_S,
  STAKING_DEFAULT_THRESHOLDS,
  STAKING_LEVELS,
  buildAirdrop,
  launchInitialCurve,
  launchMarketCap,
  launchPriceWei,
  launchProgress,
  launchQuoteBuy,
  launchQuoteSell,
  launchStartCapUsd,
  launchSymbol,
  normalizeSymbol,
  symbolProblem,
  tokenNameProblem,
  shortAddress,
  type Address,
  type AirdropsResponse,
  type GenesisListResponse,
  type GenesisResponse,
  type LaunchAttestBody,
  type LaunchAttestation,
  type LaunchCurveState,
  type LaunchTermsDTO,
  type LaunchTokenDTO,
  type LaunchTokenResponse,
  type LaunchpadResponse,
  type StakingResponse,
} from '@sway/shared';
import { keccak256, toBytes } from 'viem';
import { ApiRequestError, notifyAuthRequired, type SwayApi } from '../api';
import type { ContractCall } from '../wallet/types';
import { ETH_USD, fakeAddress, fakeHash } from './seed';
import type { MockWorld } from './state';

export const MOCK_LAUNCHPAD = fakeAddress('launchpad');
export const MOCK_STAKING = fakeAddress('staking');
export const MOCK_SWAY = fakeAddress('sway-token');
const E18 = 10n ** 18n;
const GRAD_USD = 69_000;
const GENESIS_POOL = 50_000_000n * E18;

interface MockToken {
  handle: string;
  address: Address;
  name: string;
  symbol: string;
  curve: LaunchCurveState;
  startCapWei: bigint;
  graduationCapWei: bigint;
  root: `0x${string}`;
  graduated: boolean;
  fees: bigint;
  volume: bigint;
  launchedAt: number;
  launchTx: `0x${string}`;
  balance: bigint;
  allowance: bigint;
  /** Airdrop leaves by lowercase address. */
  drops: Map<string, { amount: bigint; proof: `0x${string}`[]; claimed: boolean }>;
}

interface LaunchState {
  tokens: Map<string, MockToken>;
  sway: { balance: bigint; allowance: bigint; staked: bigint; unstaking: bigint; unlockAt: number; rewards: bigint; since: number };
  totalStakedOthers: bigint;
  /** Seconds added to the clock by warp() (cooldowns in e2e). */
  offset: number;
  genesis: { id: string; takenAt: number; listHash: `0x${string}`; list: GenesisListResponse['rows'] } | null;
}

const states = new WeakMap<MockWorld, LaunchState>();
/** Mock holder wallets: keccak-derived so they never collide with the viewer's wallet (fakeAddress can). */
const holderAddress = (handle: string): Address => `0x${keccak256(toBytes('sway-mock-holder:' + handle)).slice(-40)}`;
let n = 0;
const txh = (s: string) => fakeHash(`${s}:${Date.now()}:${++n}`);
const now = (st: LaunchState) => Math.floor(Date.now() / 1000) + st.offset;
const lc = (a: string) => a.toLowerCase();

function needUser(w: MockWorld) {
  if (!w.user) {
    notifyAuthRequired();
    throw new ApiRequestError(401, 'auth_required', 'Connect X first');
  }
  return w.user;
}

function caps(score: number) {
  return { startCapWei: ethToWei(launchStartCapUsd(score) / ETH_USD), graduationCapWei: ethToWei(GRAD_USD / ETH_USD) };
}

/** Holders of a creator's keys in the mock world (the creator's locked key excluded), as airdrop inputs. */
function holdersOf(w: MockWorld, handle: string): Array<{ handle: string; address: Address; units: bigint }> {
  const c = w.C[handle];
  if (!c) return [];
  const out: Array<{ handle: string; address: Address; units: bigint }> = [];
  if (c.isMe) {
    for (const [h, k] of Object.entries(c.extraHolders || {})) if (k > 0) out.push({ handle: h, address: holderAddress(h), units: BigInt(Math.round(k * 100)) });
  } else {
    for (const h of w.holdersOf(handle)) {
      const units = BigInt(h.units) - (h.handle === handle ? 100n : 0n);
      if (units <= 0n) continue;
      const address = h.you && w.user ? w.user.wallet : holderAddress(h.handle);
      out.push({ handle: h.handle, address, units });
    }
  }
  return out;
}

function plan(w: MockWorld, handle: string, creatorAddress: Address) {
  const holders = holdersOf(w, handle);
  const creatorOnly = holders.length === 0;
  const inputs = creatorOnly ? [{ handle, address: creatorAddress, units: 1n }] : holders;
  const d = buildAirdrop(inputs.map((h) => ({ address: h.address, units: h.units })), LAUNCH_HOLDER_ALLOCATION);
  return { ...d, inputs, creatorOnly };
}

function launchToken(
  w: MockWorld,
  st: LaunchState,
  handle: string,
  creatorAddress: Address,
  score: number,
  name: string,
  symbol = launchSymbol(handle, name),
): MockToken {
  const { startCapWei, graduationCapWei } = caps(score);
  const p = plan(w, handle, creatorAddress);
  const t: MockToken = {
    handle,
    address: fakeAddress('token:' + handle),
    name,
    symbol,
    curve: launchInitialCurve(startCapWei),
    startCapWei,
    graduationCapWei,
    root: p.root,
    graduated: false,
    fees: 0n,
    volume: 0n,
    launchedAt: Date.now(),
    launchTx: txh('launch:' + handle),
    balance: 0n,
    allowance: 0n,
    drops: new Map(p.entries.map((e) => [lc(e.address), { amount: e.amount, proof: e.proof, claimed: false }])),
  };
  st.tokens.set(handle, t);
  return t;
}

function stateOf(w: MockWorld): LaunchState {
  let st = states.get(w);
  if (!st) {
    st = {
      tokens: new Map(),
      sway: { balance: 0n, allowance: 0n, staked: 0n, unstaking: 0n, unlockAt: 0, rewards: 0n, since: 0 },
      totalStakedOthers: 4_200_000n * E18,
      offset: 0,
      genesis: null,
    };
    states.set(w, st);
    // A creator who already launched, so any visitor can browse a live token.
    const mako = w.C['makotrades'];
    if (mako) {
      const t = launchToken(w, st, 'makotrades', fakeAddress('owner:makotrades'), mako.score, mako.name);
      for (const eth of ['0.12', '0.4', '0.05']) {
        const q = launchQuoteBuy(t.curve, ethToWei(eth));
        t.curve = { ...t.curve, ethReserve: t.curve.ethReserve + ethToWei(eth) - q.fee, tokenReserve: t.curve.tokenReserve - q.tokensOut };
        t.fees += q.fee;
        t.volume += ethToWei(eth);
      }
      t.launchedAt = Date.now() - 3 * 86400_000;
    }
  }
  return st;
}

function tokenDTO(w: MockWorld, t: MockToken): LaunchTokenDTO {
  const cap = launchMarketCap(t.curve);
  const mine = w.isMine(t.handle);
  return {
    address: t.address,
    name: t.name,
    symbol: t.symbol,
    creator: w.ref(t.handle),
    creatorAddress: mine && w.user ? w.user.wallet : fakeAddress('owner:' + t.handle),
    priceWei: launchPriceWei(t.curve).toString(),
    marketCapWei: cap.toString(),
    startCapWei: t.startCapWei.toString(),
    graduationCapWei: t.graduationCapWei.toString(),
    progress: t.graduated ? 1 : launchProgress(cap, t.startCapWei, t.graduationCapWei),
    virtualEthWei: t.curve.virtualEth.toString(),
    ethReserveWei: t.curve.ethReserve.toString(),
    tokenReserve: t.curve.tokenReserve.toString(),
    volumeWei: t.volume.toString(),
    graduated: t.graduated,
    pool: null,
    creatorFeesWei: t.fees.toString(),
    balances: w.user ? [{ address: w.user.wallet, balance: t.balance.toString(), allowance: t.allowance.toString() }] : [],
    isMine: mine,
    launchTx: t.launchTx,
    launchedAt: new Date(t.launchedAt).toISOString(),
    explorer: null,
    source: 'chain',
  };
}

function termsDTO(w: MockWorld): LaunchTermsDTO {
  const u = w.user!;
  const { startCapWei, graduationCapWei } = caps(u.score);
  const p = plan(w, u.handle, u.wallet);
  const units = new Map(p.inputs.map((h) => [lc(h.address), h]));
  return {
    name: u.name,
    symbol: launchSymbol(u.handle, u.name),
    startCapWei: startCapWei.toString(),
    startCapUsd: launchStartCapUsd(u.score),
    graduationCapWei: graduationCapWei.toString(),
    graduationCapUsd: GRAD_USD,
    totalSupply: LAUNCH_TOTAL_SUPPLY.toString(),
    holderAllocation: LAUNCH_HOLDER_ALLOCATION.toString(),
    holders: p.entries
      .map((e) => {
        const h = units.get(lc(e.address))!;
        return {
          user: w.ref(h.handle),
          address: lc(e.address) as Address,
          units: (p.creatorOnly ? 0n : h.units).toString(),
          amount: e.amount.toString(),
          sharePct: Number((e.amount * 1_000_000n) / LAUNCH_HOLDER_ALLOCATION) / 10_000,
        };
      })
      .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1)),
    creatorOnly: p.creatorOnly,
  };
}

function levelOf(staked: bigint): number {
  let level = 0;
  STAKING_DEFAULT_THRESHOLDS.forEach((t, i) => {
    if (staked >= t) level = i + 1;
  });
  return level;
}

/** Variable staker rewards: a trickle of ETH per staked token while staked (mock only). */
function accrue(st: LaunchState) {
  const s = st.sway;
  const t = now(st);
  if (s.staked > 0n && s.since) s.rewards += (s.staked * BigInt(Math.max(0, t - s.since))) / (2_000_000n * 3600n);
  s.since = t;
}

function syncLevel(w: MockWorld, st: LaunchState) {
  w.level = levelOf(st.sway.staked);
  w.staked = Number(st.sway.staked / E18);
}

/** Contract calls from SwayWallet.writeContract in mock mode. Returns null for calls that aren't ours. */
function handleWrite(w: MockWorld, st: LaunchState, call: ContractCall): `0x${string}` | null {
  const to = lc(call.address);
  const a = (call.args ?? []) as readonly unknown[];
  const fail = (m: string): never => {
    throw new Error(m);
  };
  if (to === lc(MOCK_LAUNCHPAD)) {
    const u = needUser(w);
    const tokenAt = (addr: unknown) => [...st.tokens.values()].find((t) => lc(t.address) === lc(String(addr))) ?? fail('Unknown token');
    switch (call.functionName) {
      case 'launch': {
        if (st.tokens.has(u.handle)) fail('AlreadyLaunched');
        if (Number(a[5]) < now(st)) fail('Expired');
        // The "signature" covers the airdrop root: holdings that moved since the attestation invalidate it.
        if (plan(w, u.handle, u.wallet).root !== a[4]) fail('BadSignature');
        return launchToken(w, st, u.handle, u.wallet, u.score, String(a[0]), String(a[1])).launchTx;
      }
      case 'buy': {
        const t = tokenAt(a[0]);
        if (t.graduated) fail('CurveClosed');
        const ethIn = call.value ?? 0n;
        if (ethIn <= 0n) fail('ZeroAmount');
        if (ethIn > ethToWei(w.eth)) fail('Not enough balance');
        // As SwayLaunchpad: a buy past the graduation cap spends only what reaches it and refunds the rest.
        const q = launchQuoteBuy({ ...t.curve, graduationCapWei: t.graduationCapWei }, ethIn);
        if (q.tokensOut < BigInt(a[1] as bigint)) fail('Slippage');
        t.curve = { ...t.curve, ethReserve: t.curve.ethReserve + q.spent - q.fee, tokenReserve: t.curve.tokenReserve - q.tokensOut };
        t.fees += q.fee;
        t.volume += q.spent;
        t.balance += q.tokensOut;
        if (q.graduates || launchMarketCap(t.curve) >= t.graduationCapWei) t.graduated = true;
        w.eth -= weiToEth(q.spent);
        w.log(`Bought ${fmtTokens(q.tokensOut)} $${t.symbol}`, -weiToEth(q.spent));
        return txh('tbuy');
      }
      case 'sell': {
        const t = tokenAt(a[0]);
        const tokensIn = BigInt(a[1] as bigint);
        if (t.graduated) fail('CurveClosed');
        if (tokensIn > t.balance) fail('ERC20InsufficientBalance');
        if (tokensIn > t.allowance) fail('ERC20InsufficientAllowance');
        const q = launchQuoteSell(t.curve, tokensIn);
        if (q.ethOut < BigInt(a[2] as bigint)) fail('Slippage');
        t.curve = { ...t.curve, ethReserve: t.curve.ethReserve - q.ethOut - q.fee, tokenReserve: t.curve.tokenReserve + tokensIn };
        t.fees += q.fee;
        t.volume += q.ethOut;
        t.balance -= tokensIn;
        t.allowance -= tokensIn;
        w.eth += weiToEth(q.ethOut);
        w.log(`Sold ${fmtTokens(tokensIn)} $${t.symbol}`, weiToEth(q.ethOut));
        return txh('tsell');
      }
      case 'claimAirdrop': {
        const t = tokenAt(a[0]);
        const d = t.drops.get(lc(u.wallet));
        if (!d || d.amount !== BigInt(a[1] as bigint)) fail('BadProof');
        if (d!.claimed) fail('AlreadyClaimed');
        d!.claimed = true;
        t.balance += d!.amount;
        w.log(`Claimed ${fmtTokens(d!.amount)} $${t.symbol} airdrop`, 0);
        return txh('drop');
      }
      case 'claimCreatorFees': {
        const t = st.tokens.get(u.handle) ?? fail('ZeroAmount');
        if (t.fees <= 0n) fail('ZeroAmount');
        w.eth += weiToEth(t.fees);
        w.log('Claimed token creator fees', weiToEth(t.fees));
        t.fees = 0n;
        return txh('fees');
      }
    }
    return null;
  }
  const token = [...st.tokens.values()].find((t) => lc(t.address) === to);
  if (token && call.functionName === 'approve') {
    token.allowance = BigInt(a[1] as bigint);
    return txh('approve');
  }
  if (to === lc(MOCK_SWAY) && call.functionName === 'approve') {
    st.sway.allowance = BigInt(a[1] as bigint);
    return txh('approve');
  }
  if (to === lc(MOCK_STAKING)) {
    needUser(w);
    const s = st.sway;
    accrue(st);
    switch (call.functionName) {
      case 'stake': {
        const amt = BigInt(a[0] as bigint);
        if (amt <= 0n) fail('ZeroAmount');
        if (amt > s.allowance) fail('ERC20InsufficientAllowance');
        if (amt > s.balance) fail('ERC20InsufficientBalance');
        s.balance -= amt;
        s.allowance -= amt;
        s.staked += amt;
        syncLevel(w, st);
        return txh('stake');
      }
      case 'requestUnstake': {
        const amt = BigInt(a[0] as bigint);
        if (amt <= 0n || amt > s.staked) fail('InsufficientStake');
        s.staked -= amt;
        s.unstaking += amt;
        s.unlockAt = now(st) + STAKING_COOLDOWN_S;
        syncLevel(w, st);
        return txh('unstake');
      }
      case 'withdraw': {
        if (s.unstaking === 0n) fail('NothingToWithdraw');
        if (now(st) < s.unlockAt) fail('StillCoolingDown');
        s.balance += s.unstaking;
        s.unstaking = 0n;
        return txh('withdraw');
      }
      case 'harvest':
        return txh('harvest');
      case 'claimRewards': {
        if (s.rewards === 0n) fail('ZeroAmount');
        w.eth += weiToEth(s.rewards);
        w.log('Claimed staking rewards', weiToEth(s.rewards));
        s.rewards = 0n;
        return txh('rewards');
      }
    }
  }
  return null;
}

const fmtTokens = (v: bigint) => {
  const x = Number(v / E18);
  return x >= 1e6 ? `${(x / 1e6).toFixed(1).replace(/\.0$/, '')}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1).replace(/\.0$/, '')}K` : String(x);
};

function buildGenesis(w: MockWorld, st: LaunchState) {
  const rows = w.LB.map((r) => ({ handle: r.handle, pts: r.pts, me: false }));
  if (w.user) rows.push({ handle: w.user.handle, pts: w.userPoints(), me: true });
  rows.sort((a, b) => b.pts - a.pts);
  const top = rows.slice(0, 500);
  const alloc = allocateGenesis(GENESIS_POOL, top.length);
  const list = top.map((r, i) => {
    const wallet = r.me && w.user ? w.user.wallet : holderAddress(r.handle);
    return {
      rank: i + 1,
      user: w.ref(r.handle),
      wallet,
      walletShort: shortAddress(wallet),
      points: Math.round(r.pts),
      sharePct: Number((alloc[i]!.units * 10n ** 10n) / GENESIS_POOL) / 1e8,
      units: alloc[i]!.units.toString(),
      minted: i < 40,
      mintTx: i < 40 ? fakeHash('mint:' + r.handle) : null,
      me: r.me,
    };
  });
  st.genesis = { id: 'gen-' + Date.now().toString(36), takenAt: Date.now(), listHash: fakeHash('list:' + list.length), list };
}

function listResponse(st: LaunchState, w: MockWorld): GenesisListResponse {
  const g = st.genesis!;
  return {
    snapshotId: g.id,
    takenAt: new Date(g.takenAt).toISOString(),
    listHash: g.listHash,
    poolUnits: GENESIS_POOL.toString(),
    published: true,
    count: g.list.length,
    minted: g.list.filter((r) => r.minted).length,
    rows: g.list.map((r) => ({ ...r, me: !!w.user && r.user.handle === w.user.handle })),
  };
}

/** The [C] SwayApi methods for the mock adapter. */
export function launchMockApi(w: MockWorld): Pick<SwayApi, 'launchAttest' | 'launchToken' | 'launchAirdrops' | 'staking' | 'genesisLatest' | 'genesisSnapshot'> {
  const st = () => stateOf(w);
  return {
    async launchAttest(choice: LaunchAttestBody = {}): Promise<LaunchAttestation> {
      const u = needUser(w);
      if (st().tokens.has(u.handle)) throw new ApiRequestError(409, 'already_launched', 'Your token is already live');
      const t = termsDTO(w);
      const name = choice.name?.trim() || t.name;
      const symbol = choice.symbol?.trim() ? normalizeSymbol(choice.symbol) : t.symbol;
      const badName = tokenNameProblem(name);
      if (badName) throw new ApiRequestError(400, 'bad_name', badName);
      const badSymbol = symbolProblem(symbol);
      if (badSymbol) throw new ApiRequestError(400, 'bad_symbol', badSymbol);
      if ([...st().tokens.values()].some((x) => x.symbol === symbol))
        throw new ApiRequestError(409, 'symbol_taken', `$${symbol} is already live on Sway. Pick another ticker.`);
      const p = plan(w, u.handle, u.wallet);
      return {
        launchpad: MOCK_LAUNCHPAD,
        creator: u.wallet,
        name,
        symbol,
        startCapWei: t.startCapWei,
        graduationCapWei: t.graduationCapWei,
        airdropRoot: p.root,
        deadline: now(st()) + 30 * 60,
        signature: fakeHash('attest:' + p.root),
        holders: p.creatorOnly ? 0 : p.entries.length,
        permit: null,
      };
    },
    async launchToken(handle): Promise<LaunchTokenResponse> {
      const c = w.C[handle];
      if (!c) throw new ApiRequestError(404, 'user_not_found', `No account @${handle}`);
      const t = st().tokens.get(handle);
      return { creator: { ...w.ref(handle), score: c.score }, symbol: '$' + (t?.symbol ?? launchSymbol(handle, c.name)), launched: !!t, token: t ? tokenDTO(w, t) : null };
    },
    async launchAirdrops(): Promise<AirdropsResponse> {
      if (!w.user) return { launchpad: MOCK_LAUNCHPAD, allocations: [] };
      const me = lc(w.user.wallet);
      const allocations = [...st().tokens.values()].flatMap((t) => {
        const d = t.drops.get(me);
        return d && !d.claimed
          ? [{ token: t.address, name: t.name, symbol: t.symbol, creator: w.ref(t.handle), address: w.user!.wallet, walletKind: 'account' as const, amount: d.amount.toString(), proof: d.proof }]
          : [];
      });
      return { launchpad: MOCK_LAUNCHPAD, allocations };
    },
    async staking(): Promise<StakingResponse> {
      const s = st();
      accrue(s);
      const sw = s.sway;
      const signed = !!w.user;
      return {
        enabled: true,
        stakingAddress: MOCK_STAKING,
        tokenAddress: MOCK_SWAY,
        tokenSymbol: 'SWAY',
        address: w.user?.wallet ?? null,
        balanceWei: (signed ? sw.balance : 0n).toString(),
        allowanceWei: (signed ? sw.allowance : 0n).toString(),
        stakedWei: (signed ? sw.staked : 0n).toString(),
        unstakingWei: (signed ? sw.unstaking : 0n).toString(),
        unlockAt: signed && sw.unstaking > 0n ? new Date((sw.unlockAt - s.offset) * 1000).toISOString() : null,
        canWithdraw: signed && sw.unstaking > 0n && now(s) >= sw.unlockAt,
        level: signed ? levelOf(sw.staked) : 0,
        levels: STAKING_LEVELS.slice(1).map((l, i) => ({ level: l.level, name: l.name, cut: l.cut, thresholdWei: STAKING_DEFAULT_THRESHOLDS[i]!.toString(), postMax: POST_MAX_STAKED })),
        pendingRewardsWei: (signed ? sw.rewards : 0n).toString(),
        totalStakedWei: (s.totalStakedOthers + sw.staked).toString(),
        cooldownSeconds: STAKING_COOLDOWN_S,
      };
    },
    async genesisLatest() {
      const s = st();
      if (!s.genesis) throw new ApiRequestError(404, 'no_snapshot', 'No Genesis snapshot has been taken yet');
      return listResponse(s, w);
    },
    async genesisSnapshot(id) {
      const s = st();
      if (id === 'demo' && !s.genesis) buildGenesis(w, s);
      if (!s.genesis || (id !== s.genesis.id && id !== 'demo')) throw new ApiRequestError(404, 'snapshot_not_found', 'No Genesis snapshot with that id');
      return listResponse(s, w);
    },
  };
}

/**
 * Wraps the base mock methods that [C] extends (launchpad terms/token, faucet $SWAY, frozen Genesis) and
 * registers the contract-write handlers. Call once after the adapter is built.
 */
export function installLaunchMock(api: SwayApi, w: MockWorld): void {
  const st = () => stateOf(w);
  const prevWrite = w.mockContractWrite;
  w.mockContractWrite = (call) => handleWrite(w, st(), call) ?? prevWrite?.(call) ?? null;

  const baseConfig = api.config.bind(api);
  api.config = async () => {
    const c = await baseConfig();
    return { ...c, contracts: { ...c.contracts, launchpad: c.contracts.launchpad ?? MOCK_LAUNCHPAD, swayStaking: c.contracts.swayStaking ?? MOCK_STAKING } };
  };

  const baseLaunchpad = api.launchpad.bind(api);
  api.launchpad = async (): Promise<LaunchpadResponse> => {
    const base = await baseLaunchpad();
    if (!w.user) return base;
    const t = st().tokens.get(w.user.handle);
    if (t) return { ...base, symbol: '$' + t.symbol, launched: true, tokenAddress: t.address, token: tokenDTO(w, t) };
    return { ...base, terms: termsDTO(w) };
  };

  const baseFaucet = api.faucet.bind(api);
  api.faucet = async (body) => {
    const r = await baseFaucet(body); // [A] faucet takes an optional { address }
    st().sway.balance += DEV_FAUCET_SWAY;
    return r;
  };

  const baseGenesis = api.genesis.bind(api);
  api.genesis = async (): Promise<GenesisResponse> => {
    const base = await baseGenesis();
    const g = st().genesis;
    if (!g) return base;
    const list = listResponse(st(), w);
    const mine = list.rows.find((r) => r.me);
    return {
      ...base,
      snapshotAt: list.takenAt,
      frozen: true,
      snapshotId: g.id,
      listHash: g.listHash,
      me: w.user ? (mine ? { rank: mine.rank, points: mine.points, inCut: true, sharePct: mine.sharePct, toCut: 0 } : { rank: 0, points: 0, inCut: false, sharePct: 0, toCut: 0 }) : null,
      top: list.rows.slice(0, 30).map((r) => ({ rank: r.rank, user: r.user, points: r.points, sharePct: r.sharePct })),
    };
  };

  // Design review / e2e hooks.
  if (typeof window !== 'undefined') (window as unknown as { __mockLaunch: unknown }).__mockLaunch = mockLaunchHooks(w);
}

/** A seeded creator launches (airdropping to the viewer's keys), time travel for cooldowns, Genesis freeze. */
export function mockLaunchHooks(w: MockWorld) {
  const st = () => stateOf(w);
  return {
    launchCreator(handle: string): Address | null {
      const c = w.C[handle];
      if (!c || st().tokens.has(handle)) return null;
      return launchToken(w, st(), handle, fakeAddress('owner:' + handle), c.score, c.name).address;
    },
    warp(seconds: number) {
      st().offset += seconds;
    },
    freezeGenesis(): string {
      buildGenesis(w, st());
      w.snapshot = Date.now() - 1000;
      return st().genesis!.id;
    },
  };
}
