/**
 * Launchpad terms, the key-holder airdrop and the operator's EIP-712 attestation (brief §1, §11 Phase 3).
 *
 * The airdrop is built from the creator's Holding mirror: every holder with units > 0, minus the creator's
 * locked first key (it sits on the subject address). With no other holders the whole 10% goes to the
 * creator's account wallet. Amounts are split pro rata with buildAirdrop (OpenZeppelin-compatible tree), so
 * the root the operator signs is the root SwayLaunchpad.claimAirdrop checks proofs against.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { KeyMarket, LaunchToken, PrismaClient, User } from '@sway/db';
import { dec, decToBig } from '@sway/db';
import { LOCKED_UNITS, usdToWei } from '@sway/curve';
import {
  DEV_FAUCET_SWAY,
  LAUNCH_ATTEST_TTL_S,
  LAUNCH_GRADUATION_USD,
  LAUNCH_HOLDER_ALLOCATION,
  LAUNCH_NAME_MAX,
  LAUNCH_TOTAL_SUPPLY,
  LAUNCH_TYPES,
  buildAirdrop,
  launchDomain,
  launchMarketCap,
  launchPriceWei,
  launchProgress,
  launchStartCapUsd,
  launchSymbol,
  launchVirtualEth,
  normalizeSymbol,
  symbolProblem,
  tokenNameProblem,
  type Address,
  type AirdropEntry,
  type LaunchAttestBody,
  type LaunchAttestation,
  type LaunchTermsDTO,
  type LaunchTokenDTO,
} from '@sway/shared';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AppDeps, Viewer } from '../deps';
import { badRequest, conflict, unavailable } from '../errors';
import { withRedisLock } from './chain';
import { membersByAddress, userRef } from './dto';
import { ViemLaunchChain, type LaunchChain, type LaunchMessage } from './launch-chain';
import { permitsEnabled } from './onboarding';
import { marketPermit } from './permits';
import { getEthUsd } from './price';

/** The LaunchChain for this app: the injected one (tests) or a viem client built once from config. */
const memo = new WeakMap<AppDeps, LaunchChain>();
export function launchChainOf(app: FastifyInstance): LaunchChain {
  const deps = app.deps;
  if (deps.launchChain) return deps.launchChain;
  let lc = memo.get(deps);
  if (!lc) {
    lc = new ViemLaunchChain(deps.config, deps.redis);
    memo.set(deps, lc);
  }
  return lc;
}

/** Suggested token name: the creator's display name (ERC-20 names stay short). They can pick another at launch. */
export const launchName = (u: Pick<User, 'name' | 'handle'>): string =>
  (u.name.trim() || u.handle).slice(0, LAUNCH_NAME_MAX);

/** Suggested ticker ("Sway" → SWAY); only the official account gets a reserved one. */
export const suggestedSymbol = (u: Pick<User, 'name' | 'handle' | 'official'>): string =>
  launchSymbol(u.handle, u.name, u.official);

export interface AirdropPlan {
  root: Hex;
  entries: AirdropEntry[];
  /** Units per address that counted (same order as entries). */
  units: Map<string, bigint>;
  creatorOnly: boolean;
}

/** Holders of the creator's market from the Holding mirror, the locked first key excluded. */
export async function planAirdrop(
  prisma: PrismaClient,
  market: KeyMarket,
  creatorWallet: string,
): Promise<AirdropPlan> {
  const rows = await prisma.holding.findMany({ where: { marketId: market.id, units: { gt: 0n } } });
  const units = new Map<string, bigint>();
  for (const h of rows) {
    const a = h.address.toLowerCase();
    const u = a === market.subject.toLowerCase() ? h.units - LOCKED_UNITS : h.units;
    if (u > 0n) units.set(a, (units.get(a) ?? 0n) + u);
  }
  const creatorOnly = units.size === 0;
  if (creatorOnly) units.set(creatorWallet.toLowerCase(), 1n);
  const { root, entries } = buildAirdrop(
    [...units].map(([address, u]) => ({ address, units: u })),
    LAUNCH_HOLDER_ALLOCATION,
  );
  return { root, entries, units, creatorOnly };
}

export interface LaunchCaps {
  startCapUsd: number;
  startCapWei: bigint;
  graduationCapWei: bigint;
  ethUsd: number;
}

export async function launchCaps(deps: AppDeps, score: number): Promise<LaunchCaps> {
  const { ethUsd } = await getEthUsd(deps.redis, deps.config.ethUsdFallback);
  const startCapUsd = launchStartCapUsd(score);
  return {
    startCapUsd,
    startCapWei: usdToWei(startCapUsd, ethUsd),
    graduationCapWei: usdToWei(LAUNCH_GRADUATION_USD, ethUsd),
    ethUsd,
  };
}

/**
 * The viewer's own non-fan market whose subject is their account wallet: the only kind that can launch. It must be
 * open onchain, unless permits are on (`lazy`): then the launch opens it first with the creator's permit.
 */
export function launchableMarket(v: Viewer, lazy: boolean): KeyMarket | null {
  const m = v.market;
  if (!v.wallet || !m || !(m.opened || lazy) || !m.claimed || m.fan) return null;
  return m.subject.toLowerCase() === v.wallet.address.toLowerCase() ? m : null;
}

export async function termsDTO(deps: AppDeps, v: Viewer, market: KeyMarket): Promise<LaunchTermsDTO> {
  // A name and ticker picked at an earlier attestation (not launched) come back prefilled.
  const picked = await deps.prisma.launchToken.findUnique({ where: { userId: v.user.id }, select: { name: true, symbol: true } });
  const plan = await planAirdrop(deps.prisma, market, v.wallet!.address);
  const caps = await launchCaps(deps, v.user.score);
  const members = await membersByAnyAddress(
    deps.prisma,
    plan.entries.map((e) => e.address),
  );
  const holders = plan.entries
    .map((e) => {
      const a = e.address.toLowerCase();
      const m = members.get(a);
      return {
        user: m ? userRef(m, m.market) : null,
        address: a as Address,
        units: (plan.creatorOnly ? 0n : (plan.units.get(a) ?? 0n)).toString(),
        amount: e.amount.toString(),
        sharePct: Number((e.amount * 1_000_000n) / LAUNCH_HOLDER_ALLOCATION) / 10_000,
      };
    })
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0));
  return {
    name: picked?.name ?? launchName(v.user),
    symbol: picked?.symbol ?? suggestedSymbol(v.user),
    startCapWei: caps.startCapWei.toString(),
    startCapUsd: caps.startCapUsd,
    graduationCapWei: caps.graduationCapWei.toString(),
    graduationCapUsd: LAUNCH_GRADUATION_USD,
    totalSupply: LAUNCH_TOTAL_SUPPLY.toString(),
    holderAllocation: LAUNCH_HOLDER_ALLOCATION.toString(),
    holders,
    creatorOnly: plan.creatorOnly,
  };
}

/** EIP-712 signature of the Launch struct with the operator key (SwayLaunchpad recovers it in launch()). */
export function signLaunch(key: Hex, chainId: number, launchpad: Address, m: LaunchMessage): Promise<Hex> {
  return privateKeyToAccount(key).signTypedData({
    domain: launchDomain(chainId, launchpad),
    types: LAUNCH_TYPES,
    primaryType: 'Launch',
    message: m,
  });
}

/** Token address for a creator: the indexer's mirror, or SwayLaunchpad.tokenOf until the indexer catches up. */
export async function tokenAddressOf(
  lc: LaunchChain,
  lt: LaunchToken | null,
  creatorWallet: string | null,
): Promise<Address | null> {
  if (lt?.tokenAddress) return lt.tokenAddress as Address;
  if (!creatorWallet || !lc.launchEnabled) return null;
  return lc.tokenOf(creatorWallet as Address).catch(() => null);
}

/**
 * Builds and stores the airdrop, then signs the attestation for the creator's chosen name and ticker (the suggested
 * ones when left out). Called under a per-creator lock.
 */
export async function attest(deps: AppDeps, lc: LaunchChain, v: Viewer, choice: LaunchAttestBody = {}): Promise<LaunchAttestation> {
  const { prisma, config, redis } = deps;
  const name = choice.name?.trim() || launchName(v.user);
  const symbol = choice.symbol?.trim() ? normalizeSymbol(choice.symbol) : suggestedSymbol(v.user);
  const badName = tokenNameProblem(name);
  if (badName) throw badRequest('bad_name', badName);
  const badSymbol = symbolProblem(symbol, v.user.official);
  if (badSymbol) throw badRequest('bad_symbol', badSymbol);
  if (!v.wallet) throw conflict('no_wallet', 'Link a wallet before launching');
  const market = launchableMarket(v, permitsEnabled(deps));
  if (!market) throw conflict('no_market', 'Open your key market before launching a token');
  if (!lc.launchEnabled || !lc.launchpad)
    throw unavailable('launch_unavailable', 'The launchpad isn’t deployed on this chain');
  if (!config.operatorKey) throw unavailable('launch_unavailable', 'The launch signer key isn’t configured');
  const creator = v.wallet.address.toLowerCase() as Address;

  return withRedisLock(redis, `lock:launch:${v.user.id}`, async () => {
    const lt = await prisma.launchToken.findUnique({ where: { userId: v.user.id } });
    if (lt?.tokenAddress || lt?.launchedAt) throw conflict('already_launched', 'Your token is already live');
    if (await lc.tokenOf(creator).catch(() => null))
      throw conflict('already_launched', 'Your token is already live');
    const taken = await prisma.launchToken.findFirst({
      where: { symbol: { equals: symbol, mode: 'insensitive' }, tokenAddress: { not: null }, userId: { not: v.user.id } },
      select: { id: true },
    });
    if (taken) throw conflict('symbol_taken', `$${symbol} is already live on Sway. Pick another ticker.`);

    const operator = privateKeyToAccount(config.operatorKey!).address.toLowerCase();
    const signer = await lc.signer().catch(() => null);
    if (!signer) throw unavailable('launch_unavailable', 'Couldn’t read the launchpad signer from the chain');
    if (signer.toLowerCase() !== operator)
      throw unavailable(
        'signer_mismatch',
        `The launchpad signer (${signer}) isn’t this API’s operator key (${operator}); launches can’t be attested`,
      );

    const plan = await planAirdrop(prisma, market, creator);
    const caps = await launchCaps(deps, v.user.score);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + LAUNCH_ATTEST_TTL_S);
    const message: LaunchMessage = {
      creator,
      name,
      symbol,
      startCapWei: caps.startCapWei,
      graduationCapWei: caps.graduationCapWei,
      airdropRoot: plan.root,
      deadline,
    };
    const signature = await signLaunch(config.operatorKey!, config.chain.id, lc.launchpad!, message);

    await prisma.$transaction(async (tx) => {
      const terms = {
        name,
        symbol,
        previewOn: true,
        startCapWei: dec(caps.startCapWei),
        graduationCapWei: dec(caps.graduationCapWei),
        airdropRoot: plan.root,
      };
      const row = await tx.launchToken.upsert({
        where: { userId: v.user.id },
        create: { userId: v.user.id, ...terms },
        update: terms,
      });
      // Not launched yet, so the previous attestation's leaves are replaced by this one's.
      await tx.launchAirdrop.deleteMany({ where: { launchTokenId: row.id } });
      await tx.launchAirdrop.createMany({
        data: plan.entries.map((e) => ({
          launchTokenId: row.id,
          address: e.address.toLowerCase(),
          amount: dec(e.amount),
          proof: e.proof,
        })),
      });
    });

    return {
      launchpad: lc.launchpad!,
      creator,
      name,
      symbol,
      startCapWei: caps.startCapWei.toString(),
      graduationCapWei: caps.graduationCapWei.toString(),
      airdropRoot: plan.root,
      deadline: Number(deadline),
      signature,
      holders: plan.creatorOnly ? 0 : plan.entries.length,
      permit: await marketPermit(deps, { ...market, user: { wallet: v.wallet } }),
    };
  });
}

export interface TokenOwner {
  user: User & { market: KeyMarket | null };
  wallet: string;
}

/** Live token view (SwayLaunchpad + ERC-20 reads), falling back to the indexer's mirror. */
export async function tokenDTO(
  deps: AppDeps,
  lc: LaunchChain,
  owner: TokenOwner,
  lt: LaunchToken | null,
  token: Address,
  viewer: { userId: string; wallets: Address[] } | null,
): Promise<LaunchTokenDTO> {
  const { config } = deps;
  const creatorAddress = owner.wallet.toLowerCase() as Address;
  const startCapWei = decToBig(lt?.startCapWei);
  const wallets = viewer?.wallets ?? [];
  let source: LaunchTokenDTO['source'] = 'chain';
  let curve = {
    virtualEth: launchVirtualEth(startCapWei),
    ethReserve: decToBig(lt?.ethReserveWei),
    tokenReserve: decToBig(lt?.tokenReserve),
    graduationCapWei: decToBig(lt?.graduationCapWei),
    graduated: lt?.graduated ?? false,
  };
  let creatorFees = 0n;
  let balances = wallets.map(() => ({ balance: 0n, allowance: 0n }));
  try {
    const [c, fees, bals] = await Promise.all([
      lc.curve(token),
      lc.creatorFees(creatorAddress),
      wallets.length ? lc.tokenBalances(token, wallets) : Promise.resolve([]),
    ]);
    if (!c) throw new Error('unknown token');
    curve = c;
    creatorFees = fees;
    balances = bals;
  } catch {
    source = 'mirror';
  }
  const capNow = launchMarketCap(curve);
  // Start cap from the stored terms; virtualEth inverts it when the row is missing (launched elsewhere).
  const start =
    startCapWei > 0n
      ? startCapWei
      : (curve.virtualEth * LAUNCH_TOTAL_SUPPLY) / (LAUNCH_TOTAL_SUPPLY - LAUNCH_HOLDER_ALLOCATION);
  return {
    address: token,
    name: lt?.name ?? launchName(owner.user),
    symbol: lt?.symbol ?? suggestedSymbol(owner.user),
    creator: userRef(owner.user, owner.user.market),
    creatorAddress,
    priceWei: launchPriceWei(curve).toString(),
    marketCapWei: capNow.toString(),
    startCapWei: start.toString(),
    graduationCapWei: curve.graduationCapWei.toString(),
    progress: curve.graduated ? 1 : launchProgress(capNow, start, curve.graduationCapWei),
    virtualEthWei: curve.virtualEth.toString(),
    ethReserveWei: curve.ethReserve.toString(),
    tokenReserve: curve.tokenReserve.toString(),
    volumeWei: lt ? lt.volumeWei.toFixed(0) : '0',
    graduated: curve.graduated,
    creatorFeesWei: creatorFees.toString(),
    balances: wallets.map((address, i) => ({
      address,
      balance: (balances[i]?.balance ?? 0n).toString(),
      allowance: (balances[i]?.allowance ?? 0n).toString(),
    })),
    isMine: viewer?.userId === owner.user.id,
    launchTx: lt?.launchTx ?? null,
    launchedAt: lt?.launchedAt?.toISOString() ?? null,
    explorer: config.chain.explorerUrl
      ? `${config.chain.explorerUrl.replace(/\/$/, '')}/token/${token}`
      : null,
    source,
  };
}

/** Lowercase address → member, through account wallets and linked wallets. */
export async function membersByAnyAddress(prisma: PrismaClient, addresses: string[]) {
  const out = await membersByAddress(prisma, addresses);
  const rest = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => !out.has(a));
  if (rest.length) {
    const linked = await prisma.linkedWallet.findMany({
      where: { address: { in: rest } },
      include: { user: { include: { market: true } } },
    });
    for (const l of linked) out.set(l.address, l.user);
  }
  return out;
}

/** Account wallet first, then linked wallets (lowercase). */
export async function viewerWallets(prisma: PrismaClient, v: Viewer): Promise<Address[]> {
  const linked = await prisma.linkedWallet.findMany({
    where: { userId: v.user.id },
    orderBy: { createdAt: 'asc' },
  });
  const out = [...(v.wallet ? [v.wallet.address] : []), ...linked.map((l) => l.address)].map((a) =>
    a.toLowerCase(),
  );
  return [...new Set(out)] as Address[];
}

/** [C] Dev faucet: also send 10,000 $SWAY (dev token minted to the deployer, which is the operator on anvil). */
export async function fundDevSway(
  app: FastifyInstance,
  to: string,
  log: FastifyBaseLogger,
): Promise<string | null> {
  const lc = launchChainOf(app);
  if (!lc.stakingEnabled) return null;
  try {
    const r = await lc.sendSway(to.toLowerCase() as Address, DEV_FAUCET_SWAY);
    return r.status === 'reverted' ? null : r.hash;
  } catch (e) {
    log.warn({ err: e }, 'dev $SWAY faucet failed');
    return null;
  }
}
