/**
 * [A] A member's wallets: the account wallet (Wallet, 1:1 with the user) plus linked wallets (LinkedWallet,
 * up to MAX_LINKED_WALLETS). An address belongs to at most one member across both tables, checked in one
 * serializable transaction. Balances, holdings and earnings are read per wallet and summed for the wallet page.
 */
import type { FastifyBaseLogger } from 'fastify';
import { getAddress } from 'viem';
import { Prisma, decToBig, type Holding, type KeyMarket, type LinkedWallet, type PrismaClient, type User, type Wallet } from '@sway/db';
import { quoteWei } from '@sway/curve';
import {
  MAX_LINKED_WALLETS,
  type Address,
  type EarningsDTO,
  type HoldingDTO,
  type WalletBalanceDTO,
  type WalletInfoDTO,
} from '@sway/shared';
import type { AppDeps, SessionData, Viewer } from '../deps';
import type { Config } from '../config';
import { conflict } from '../errors';
import type { ChainClient, Claimable } from './chain';
import { marketDTO, marketStats } from './markets';

export const ADDRESS_PLACEHOLDER = '{address}';

/** The message a wallet signs to be added to a member (the account wallet has its own, in routes/wallet). */
export function addWalletMessage(handle: string, chainId: number, nonce: string, issuedAt: string): string {
  return [
    `Sway wants you to add this wallet to @${handle}.`,
    '',
    'Signing is free and sends no transaction. Keys in this wallet count toward your rooms and points.',
    '',
    `Address: ${ADDRESS_PLACEHOLDER}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

/** Checks a personal_sign over `template` with "{address}" filled in as sent, lowercase or checksummed. */
export async function verifyLinkSignature(
  chain: ChainClient,
  template: string,
  address: string,
  signature: `0x${string}`,
): Promise<boolean> {
  const checksum = getAddress(address);
  for (const c of new Set([address, address.toLowerCase(), checksum])) {
    if (await chain.verifyMessage(checksum, template.replace(ADDRESS_PLACEHOLDER, c), signature)) return true;
  }
  return false;
}

export const accountInfo = (w: Wallet): WalletInfoDTO => ({
  address: w.address as Address,
  kind: w.kind,
  connector: w.connector,
  label: null,
  account: true,
  createdAt: w.createdAt.toISOString(),
});

export const linkedInfo = (w: LinkedWallet): WalletInfoDTO => ({
  address: w.address as Address,
  kind: w.kind,
  connector: w.connector,
  label: w.label,
  account: false,
  createdAt: w.createdAt.toISOString(),
});

/** Every wallet of a member: account first, then linked wallets oldest first. */
export async function memberWallets(prisma: PrismaClient, userId: string): Promise<WalletInfoDTO[]> {
  const [account, linked] = await Promise.all([
    prisma.wallet.findUnique({ where: { userId } }),
    prisma.linkedWallet.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  ]);
  return [...(account ? [accountInfo(account)] : []), ...linked.map(linkedInfo)];
}

/* ------------------------------------------------------------------ linking */

const isKnown = (e: unknown, code: string) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === code;
const taken = () => conflict('wallet_taken', 'This wallet is linked to another member. One member per wallet.');

/** Runs fn in a serializable transaction, retrying serialization failures; unique clashes read as wallet_taken. */
async function serializable<T>(prisma: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (e) {
      if ((isKnown(e, 'P2034') || /could not serialize/i.test(String(e))) && attempt < 4) continue;
      if (isKnown(e, 'P2002')) throw taken();
      throw e;
    }
  }
}

/** Creates the account wallet, refusing an address that is another member's (account or linked) wallet. */
export function createAccountWallet(
  prisma: PrismaClient,
  data: { userId: string; address: string; kind: 'embedded' | 'external'; connector: string | null },
): Promise<Wallet> {
  return serializable(prisma, async (tx) => {
    const [acct, linked] = await Promise.all([
      tx.wallet.findUnique({ where: { address: data.address } }),
      tx.linkedWallet.findUnique({ where: { address: data.address } }),
    ]);
    if ((acct && acct.userId !== data.userId) || linked) throw taken();
    return tx.wallet.create({ data });
  });
}

/** Adds a linked wallet. Re-linking one of your own linked wallets is a no-op (connector/label refreshed if sent). */
export function addLinkedWallet(
  prisma: PrismaClient,
  data: { userId: string; address: string; kind: 'embedded' | 'external'; connector: string | null; label: string | null },
): Promise<LinkedWallet> {
  return serializable(prisma, async (tx) => {
    const [acct, linked, count] = await Promise.all([
      tx.wallet.findUnique({ where: { address: data.address } }),
      tx.linkedWallet.findUnique({ where: { address: data.address } }),
      tx.linkedWallet.count({ where: { userId: data.userId } }),
    ]);
    if (acct) {
      if (acct.userId === data.userId) throw conflict('wallet_is_account', 'This is already your account wallet');
      throw taken();
    }
    if (linked) {
      if (linked.userId !== data.userId) throw taken();
      return tx.linkedWallet.update({
        where: { id: linked.id },
        data: { connector: data.connector ?? linked.connector, label: data.label ?? linked.label },
      });
    }
    if (count >= MAX_LINKED_WALLETS)
      throw conflict('wallet_limit', `You can add up to ${MAX_LINKED_WALLETS} wallets. Remove one to add another.`);
    return tx.linkedWallet.create({ data });
  });
}

/* ------------------------------------------------------------------ balances, holdings, earnings */

type HoldingRow = Holding & { market: KeyMarket & { user: User } };

const ZERO_CLAIM: Claimable = { creator: 0n, holder: 0n, referral: 0n, protocol: 0n };

/** Sell value after fees, capped so the creator's locked key is never counted. */
export function holdingValueWei(supply: bigint, units: bigint): bigint {
  const sellable = units < supply - 100n ? units : supply - 100n;
  return sellable > 0n ? quoteWei(supply, 'sell', sellable).total : 0n;
}

export function holdingDTO(h: HoldingRow, stats: Awaited<ReturnType<typeof marketStats>>): HoldingDTO {
  const valueWei = holdingValueWei(h.market.supplyUnits, h.units);
  const basis = decToBig(h.costBasisWei);
  return {
    market: marketDTO(h.market, stats.get(h.market.id)),
    units: h.units.toString(),
    valueWei: valueWei.toString(),
    address: h.address as Address,
    costBasisWei: basis.toString(),
    avgCostWei: (h.units > 0n ? (basis * 100n) / h.units : 0n).toString(),
    unrealizedPnlWei: (valueWei - basis).toString(),
    realizedPnlWei: decToBig(h.realizedPnlWei).toString(),
  };
}

export interface WalletOverview {
  /** Per wallet, account first. */
  wallets: WalletBalanceDTO[];
  /** One row per (wallet, market) with units > 0, own market excluded, by value. */
  holdings: HoldingDTO[];
  /** Sums across wallets; claimSubjects are the account wallet's. */
  total: { cashWei: bigint; keysValueWei: bigint; units: bigint; markets: number; earnings: EarningsDTO };
}

const earningsDTO = (c: Claimable, claimed: bigint, subjects: Address[]): EarningsDTO => ({
  creatorWei: c.creator.toString(),
  holderWei: c.holder.toString(),
  referralWei: c.referral.toString(),
  totalWei: (c.creator + c.holder + c.referral).toString(),
  claimedWei: claimed.toString(),
  claimSubjects: subjects,
});

export async function walletOverview(deps: Pick<AppDeps, 'prisma' | 'chain'>, v: Viewer): Promise<WalletOverview> {
  const { prisma, chain } = deps;
  const infos = await memberWallets(prisma, v.user.id);
  const addrs = infos.map((w) => w.address.toLowerCase());
  const rows: HoldingRow[] = addrs.length
    ? await prisma.holding.findMany({
        where: { address: { in: addrs } },
        include: { market: { include: { user: true } } },
      })
    : [];
  const held = rows.filter((h) => h.units > 0n && h.market.userId !== v.user.id);
  const subjectsOf = (w: WalletInfoDTO): Address[] =>
    [
      ...new Set([
        ...rows.filter((h) => h.address === w.address).map((h) => h.market.subject),
        ...(w.account && v.market ? [v.market.subject] : []),
      ]),
    ] as Address[];

  const [stats, cash, earned, claimed] = await Promise.all([
    marketStats(prisma, [...new Map(held.map((h) => [h.market.id, h.market])).values()]),
    Promise.all(infos.map((w) => chain.getBalance(w.address).catch(() => 0n))),
    Promise.all(infos.map((w) => chain.claimable(w.address, subjectsOf(w)).catch(() => ZERO_CLAIM))),
    addrs.length
      ? prisma.earningsClaim.groupBy({
          by: ['address'],
          where: { address: { in: addrs } },
          _sum: { creatorWei: true, holderWei: true, referralWei: true },
        })
      : [],
  ]);
  const claimedBy = new Map(
    claimed.map((c) => [c.address, decToBig(c._sum.creatorWei) + decToBig(c._sum.holderWei) + decToBig(c._sum.referralWei)]),
  );

  const holdings = held.map((h) => holdingDTO(h, stats)).sort((a, b) => (BigInt(b.valueWei) > BigInt(a.valueWei) ? 1 : -1));
  const sum: Claimable = { creator: 0n, holder: 0n, referral: 0n, protocol: 0n };
  let claimedTotal = 0n;
  const wallets: WalletBalanceDTO[] = infos.map((w, i) => {
    const mine = holdings.filter((h) => h.address === w.address);
    const c = earned[i]!;
    sum.creator += c.creator;
    sum.holder += c.holder;
    sum.referral += c.referral;
    claimedTotal += claimedBy.get(w.address) ?? 0n;
    return {
      ...w,
      cashWei: cash[i]!.toString(),
      keysValueWei: mine.reduce((s, h) => s + BigInt(h.valueWei), 0n).toString(),
      keys: { units: mine.reduce((s, h) => s + BigInt(h.units), 0n).toString(), markets: mine.length },
      earnings: earningsDTO(c, claimedBy.get(w.address) ?? 0n, subjectsOf(w)),
    };
  });
  const account = infos.find((w) => w.account);
  return {
    wallets,
    holdings,
    total: {
      cashWei: cash.reduce((s, x) => s + x, 0n),
      keysValueWei: holdings.reduce((s, h) => s + BigInt(h.valueWei), 0n),
      units: held.reduce((s, h) => s + h.units, 0n),
      markets: new Set(held.map((h) => h.marketId)).size,
      earnings: earningsDTO(sum, claimedTotal, account ? subjectsOf(account) : []),
    },
  };
}

/* ------------------------------------------------------------------ gas drip */

export const GAS_DRIP_LABEL = 'Gas for your first trades';
export const GAS_DRIP_MIN_AGE_DAYS = 30;
export const GAS_DRIP_MIN_FOLLOWERS = 50;
export const gasDripRef = (userId: string) => `gasdrip:${userId}`;

/**
 * Why a member gets no gas drip, or null when they qualify: the drip is on (GAS_DRIP_WEI > 0), the chain is not
 * local, they signed in with real X (not dev auth), and their X account is ≥ 30 days old with ≥ 50 followers and
 * no bot flag.
 */
export function gasDripBlocker(
  config: Pick<Config, 'gasDripWei' | 'chain'>,
  user: Pick<User, 'followers' | 'xCreatedAt' | 'botFlag'>,
  session: Pick<SessionData, 'x' | 'dev'> | null,
  now = Date.now(),
): string | null {
  if (config.gasDripWei <= 0n) return 'off';
  if (config.chain.isLocal) return 'local_chain';
  if (!session?.x || session.dev) return 'not_x';
  if (user.botFlag) return 'bot_flag';
  if (user.followers < GAS_DRIP_MIN_FOLLOWERS) return 'followers';
  if (!user.xCreatedAt || now - user.xCreatedAt.getTime() < GAS_DRIP_MIN_AGE_DAYS * 86_400_000) return 'account_age';
  return null;
}

export type GasDripResult = { status: 'sent'; txHash: string } | { status: 'skipped' | 'failed'; reason: string };

/**
 * Sends GAS_DRIP_WEI once per member from the operator (ChainClient.sendEth holds the operator lock). The Activity
 * row with ref gasdrip:<userId> is written first, so concurrent or repeated calls never send twice; it is
 * removed again if the transfer fails.
 */
export async function maybeGasDrip(
  deps: Pick<AppDeps, 'prisma' | 'chain' | 'config'>,
  user: User,
  address: string,
  session: SessionData | null,
  log: FastifyBaseLogger,
): Promise<GasDripResult> {
  const why = gasDripBlocker(deps.config, user, session) ?? (deps.chain.rpcEnabled ? null : 'no_rpc');
  if (why) return { status: 'skipped', reason: why };
  const wei = deps.config.gasDripWei;
  if (await deps.prisma.activity.findUnique({ where: { ref: gasDripRef(user.id) }, select: { id: true } }))
    return { status: 'skipped', reason: 'already_sent' };
  let row;
  try {
    row = await deps.prisma.activity.create({
      data: { userId: user.id, label: GAS_DRIP_LABEL, amountWei: wei.toString(), txHash: null, ref: gasDripRef(user.id) },
    });
  } catch (e) {
    if (isKnown(e, 'P2002')) return { status: 'skipped', reason: 'already_sent' };
    throw e;
  }
  try {
    const r = await deps.chain.sendEth(address.toLowerCase() as Address, wei);
    if (r.status === 'reverted') throw new Error('gas drip transfer reverted');
    await deps.prisma.activity.update({ where: { id: row.id }, data: { txHash: r.hash } });
    log.info({ userId: user.id, tx: r.hash }, 'gas drip sent');
    return { status: 'sent', txHash: r.hash };
  } catch (e) {
    await deps.prisma.activity.delete({ where: { id: row.id } }).catch(() => undefined);
    log.warn({ err: e, userId: user.id }, 'gas drip failed');
    return { status: 'failed', reason: e instanceof Error ? e.message : 'send failed' };
  }
}
