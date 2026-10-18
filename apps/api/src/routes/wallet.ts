/** Wallet link (signature), onboarding (market open/claim), wallet page, activity log and the dev faucet. */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAddress, type Hash } from 'viem';
import { Prisma, decToBig, decToStr, type Activity } from '@sway/db';
import { quoteWei, usdToWei } from '@sway/curve';
import type { ActivityDTO, Address as Addr, HoldingDTO, MeDTO, OnboardingStatus, WalletDTO, WalletNonceResponse } from '@sway/shared';
import { Address, TxHash, WeiString, body } from './_util';
import { requireViewer, resetViewer } from '../plugins/auth';
import { badRequest, conflict, forbidden, notFound, unavailable } from '../errors';
import { buildMe } from '../services/me';
import { fundDevWallet, onboardingStatus, openOrClaimMarket, welcomeWei } from '../services/onboarding';
import { marketDTO, marketStats } from '../services/markets';
import { getEthUsd } from '../services/price';

const NONCE_TTL_S = 600;
const nonceKey = (userId: string) => `wnonce:${userId}`;
export const ADDRESS_PLACEHOLDER = '{address}';

export function linkMessage(handle: string, chainId: number, nonce: string, issuedAt: string): string {
  return [
    `Sway wants you to link this wallet to @${handle}.`,
    '',
    'Signing is free and sends no transaction. One wallet per member, one member per wallet.',
    '',
    `Address: ${ADDRESS_PLACEHOLDER}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

export const activityDTO = (a: Activity): ActivityDTO => ({
  id: a.id,
  label: a.label,
  amountWei: decToStr(a.amountWei),
  createdAt: a.createdAt.toISOString(),
  txHash: a.txHash,
});

export async function walletRoutes(app: FastifyInstance) {
  const { config, prisma, redis, chain } = app.deps;

  app.post('/wallet/nonce', async (req): Promise<WalletNonceResponse> => {
    const v = await requireViewer(req);
    const b = body(z.object({ address: Address.optional() }), req);
    const nonce = randomBytes(16).toString('hex');
    const template = linkMessage(v.user.handle, config.chain.id, nonce, new Date().toISOString());
    await redis.set(nonceKey(v.user.id), JSON.stringify({ nonce, template }), 'EX', NONCE_TTL_S);
    return { nonce, message: b.address ? template.replace(ADDRESS_PLACEHOLDER, b.address) : template };
  });

  const LinkBody = z.object({
    address: Address,
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'must be a hex signature').max(20_000),
    kind: z.enum(['embedded', 'external']),
  });

  app.post('/wallet/link', async (req): Promise<MeDTO> => {
    const v = await requireViewer(req);
    const b = body(LinkBody, req);
    const address = b.address.toLowerCase();
    if (v.wallet) {
      if (v.wallet.address === address) return buildMe(prisma, v);
      throw conflict('wallet_exists', 'Your account already has a wallet. One wallet per member.');
    }
    const raw = await redis.get(nonceKey(v.user.id));
    if (!raw) throw badRequest('nonce_expired', 'The link request expired. Request a new message and sign again.');
    const { template } = JSON.parse(raw) as { nonce: string; template: string };

    const checksum = getAddress(b.address);
    const candidates = [...new Set([b.address, address, checksum])];
    let ok = false;
    for (const c of candidates) {
      if (await chain.verifyMessage(checksum, template.replace(ADDRESS_PLACEHOLDER, c), b.signature as `0x${string}`)) {
        ok = true;
        break;
      }
    }
    if (!ok) throw badRequest('bad_signature', 'The signature does not match this address and message');

    const taken = await prisma.wallet.findUnique({ where: { address } });
    if (taken && taken.userId !== v.user.id) throw conflict('wallet_taken', 'This wallet is linked to another member. One member per wallet.');
    let wallet;
    try {
      wallet = await prisma.wallet.create({ data: { userId: v.user.id, address, kind: b.kind } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw conflict('wallet_taken', 'This wallet or account is already linked');
      }
      throw e;
    }
    await redis.del(nonceKey(v.user.id));

    if (config.chain.isLocal && config.devAuth) {
      void fundDevWallet(app.deps, wallet, welcomeWei(), 'Welcome funds (local chain)', req.log);
    }
    resetViewer(req);
    return buildMe(prisma, await requireViewer(req));
  });

  app.get('/onboarding', async (req): Promise<OnboardingStatus> => onboardingStatus(app.deps, await requireViewer(req)));

  app.post('/onboarding/market', async (req): Promise<OnboardingStatus> => {
    const v = await requireViewer(req);
    const r = await openOrClaimMarket(app.deps, v, req.log);
    resetViewer(req);
    const status = onboardingStatus(app.deps, await requireViewer(req));
    return { ...status, marketTx: r.tx ?? status.marketTx };
  });

  app.get('/wallet', async (req): Promise<WalletDTO> => {
    const v = await requireViewer(req);
    if (!v.wallet) throw notFound('No wallet linked yet', 'no_wallet');
    const address = v.wallet.address as Addr;
    const holdings = await prisma.holding.findMany({ where: { address }, include: { market: { include: { user: true } } } });
    const held = holdings.filter((h) => h.units > 0n && h.market.userId !== v.user.id);
    const subjects = [...new Set([...holdings.map((h) => h.market.subject), ...(v.market ? [v.market.subject] : [])])] as Addr[];
    const zero = { creator: 0n, holder: 0n, referral: 0n, protocol: 0n };

    const [stats, cash, earned, claimed, activity] = await Promise.all([
      marketStats(prisma, held.map((h) => h.market)),
      chain.getBalance(address).catch(() => 0n),
      chain.claimable(address, subjects).catch(() => zero),
      prisma.earningsClaim.aggregate({ where: { address }, _sum: { creatorWei: true, holderWei: true, referralWei: true } }),
      prisma.activity.findMany({ where: { userId: v.user.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);

    const rows: HoldingDTO[] = held.map((h) => {
      const supply = h.market.supplyUnits;
      const sellable = h.units < supply - 100n ? h.units : supply - 100n;
      const valueWei = sellable > 0n ? quoteWei(supply, 'sell', sellable).total : 0n;
      return { market: marketDTO(h.market, stats.get(h.market.id)), units: h.units.toString(), valueWei: valueWei.toString() };
    });
    const keysValue = rows.reduce((s, r) => s + BigInt(r.valueWei), 0n);
    const units = held.reduce((s, h) => s + h.units, 0n);
    const claimedWei = decToBig(claimed._sum.creatorWei) + decToBig(claimed._sum.holderWei) + decToBig(claimed._sum.referralWei);

    return {
      address,
      kind: v.wallet.kind,
      cashWei: cash.toString(),
      keysValueWei: keysValue.toString(),
      earnings: {
        creatorWei: earned.creator.toString(),
        holderWei: earned.holder.toString(),
        referralWei: earned.referral.toString(),
        totalWei: (earned.creator + earned.holder + earned.referral).toString(),
        claimedWei: claimedWei.toString(),
        claimSubjects: subjects,
      },
      keys: { units: units.toString(), markets: held.length },
      holdings: rows.sort((a, b) => (BigInt(b.valueWei) > BigInt(a.valueWei) ? 1 : -1)),
      activity: activity.map(activityDTO),
    };
  });

  const ActivityBody = z.object({ label: z.string().trim().min(1).max(80), amountWei: WeiString, txHash: TxHash });

  app.post('/wallet/activity', async (req): Promise<ActivityDTO> => {
    const v = await requireViewer(req);
    if (!v.wallet) throw notFound('No wallet linked yet', 'no_wallet');
    const b = body(ActivityBody, req);
    const ref = `client:${b.txHash}`;
    const dup = await prisma.activity.findUnique({ where: { ref } });
    if (dup) {
      if (dup.userId !== v.user.id) throw conflict('tx_used', 'This transaction is already recorded');
      return activityDTO(dup);
    }
    if (chain.rpcEnabled) {
      let tx;
      try {
        tx = await chain.getTransaction(b.txHash as Hash);
      } catch (e) {
        req.log.warn({ err: e }, 'tx lookup failed; recording unverified');
        tx = undefined;
      }
      if (tx === null) throw badRequest('tx_not_found', 'That transaction was not found onchain');
      if (tx && tx.from !== v.wallet.address) throw forbidden('tx_not_yours', 'That transaction was not sent from your wallet');
      if (tx && tx.status === 'reverted') throw badRequest('tx_reverted', 'That transaction reverted');
    }
    const row = await prisma.activity.create({ data: { userId: v.user.id, label: b.label, amountWei: b.amountWei, txHash: b.txHash, ref } });
    return activityDTO(row);
  });

  app.post('/dev/faucet', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    if (!config.chain.isLocal || config.isProd) throw forbidden('dev_only', 'The faucet only runs on the local dev chain');
    const v = await requireViewer(req);
    if (!v.wallet) throw notFound('No wallet linked yet', 'no_wallet');
    const { ethUsd } = await getEthUsd(redis, config.ethUsdFallback);
    const hash = await fundDevWallet(app.deps, v.wallet, usdToWei(100, ethUsd), 'Deposit (dev faucet)', req.log);
    if (!hash) throw unavailable('chain_unavailable', 'The local chain or operator key is not available');
    return { txHash: hash };
  });
}
