/**
 * Onboarding after X sign-in: wallet, then the member's key market. If the member's X id already backs an
 * unclaimed fan market, the operator calls claimFanMarket(subject, wallet); otherwise openMarket(wallet, xId).
 * The KeyMarket row is written the same way the indexer writes it on MarketOpened (subject lowercase,
 * opened=false until the receipt, then opened/openTx/openedAt), so both paths are idempotent.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { KeyMarket, Wallet } from '@sway/db';
import { ethToWei } from '@sway/curve';
import type { Address, OnboardingStatus } from '@sway/shared';
import type { AppDeps, Viewer } from '../deps';
import { conflict } from '../errors';
import { ChainError, withRedisLock } from './chain';
import { ZERO_ADDRESS } from './dto';

export function onboardingStatus(deps: AppDeps, v: Viewer): OnboardingStatus {
  const m = v.market;
  return {
    profile: true,
    engagement: v.user.scoreInputs !== null,
    scored: v.user.scoredAt !== null,
    wallet: !!v.wallet,
    // Without deployed contracts (local dev) the DB row is the market.
    market: !!m && m.claimed && (m.opened || !deps.chain.keysEnabled),
    marketTx: m?.openTx ?? null,
  };
}

export interface MarketResult {
  market: KeyMarket;
  tx: string | null;
}

export async function openOrClaimMarket(
  deps: AppDeps,
  v: Viewer,
  log: FastifyBaseLogger,
): Promise<MarketResult> {
  const { prisma, redis, chain } = deps;
  if (!v.wallet) throw conflict('no_wallet', 'Link a wallet before opening your market');
  const wallet = v.wallet.address.toLowerCase() as Address;
  const user = v.user;

  return withRedisLock(redis, `lock:market:${user.id}`, async () => {
    const existing = await prisma.keyMarket.findFirst({
      where: { OR: [{ userId: user.id }, { xId: user.xId }] },
    });

    /* ---------------- fan market waiting for this account: claim it */
    if (existing && existing.fan && !existing.claimed) {
      const subject = existing.subject as Address;
      if (!chain.operatorEnabled) {
        log.warn(
          { subject },
          'fan market claim skipped onchain: SwayKeys/operator not configured; marking claimed in the DB only',
        );
        const market = await prisma.keyMarket.update({
          where: { id: existing.id },
          data: { claimed: true, userId: user.id },
        });
        return { market, tx: null };
      }
      const onchain = await chain.market(subject);
      if (onchain && onchain.owner !== ZERO_ADDRESS) {
        const market = await prisma.keyMarket.update({
          where: { id: existing.id },
          data: { claimed: true, userId: user.id, opened: true },
        });
        return { market, tx: null };
      }
      const r = await chain.claimFanMarket(subject, wallet);
      if (r.status === 'reverted') throw new ChainError('claimFanMarket reverted', 'reverted');
      const market =
        r.status === 'success'
          ? await prisma.keyMarket.update({
              where: { id: existing.id },
              data: { claimed: true, userId: user.id, opened: true },
            })
          : existing;
      return { market, tx: r.hash };
    }

    if (existing && existing.claimed && existing.opened) return { market: existing, tx: existing.openTx };

    /* ---------------- the member's own market */
    let market =
      existing ??
      (await prisma.keyMarket.upsert({
        where: { xId: user.xId },
        create: {
          subject: wallet,
          userId: user.id,
          xId: user.xId,
          fan: false,
          claimed: true,
          category: 'creators',
          opened: false,
          supplyUnits: 100n,
          holders: 1,
        },
        update: {},
      }));
    await prisma.holding.createMany({
      data: [{ marketId: market.id, address: wallet, units: 100n }],
      skipDuplicates: true,
    });

    if (!chain.operatorEnabled) {
      log.warn({ subject: market.subject }, 'market open skipped onchain: SwayKeys/operator not configured');
      return { market, tx: null };
    }
    const onchain = await chain.market(market.subject as Address);
    if (onchain) {
      market = await prisma.keyMarket.update({
        where: { id: market.id },
        data: { opened: true, openedAt: market.openedAt ?? new Date() },
      });
      return { market, tx: market.openTx };
    }
    const r = await chain.openMarket(market.subject as Address, BigInt(user.xId));
    if (r.status === 'reverted') throw new ChainError('openMarket reverted', 'reverted');
    market = await prisma.keyMarket.update({
      where: { id: market.id },
      data: {
        openTx: r.hash,
        ...(r.status === 'success' ? { opened: true, openedAt: market.openedAt ?? new Date() } : {}),
      },
    });
    return { market, tx: r.hash };
  });
}

export const DEV_WELCOME_ETH = '0.75';

/** Local chain + DEV_AUTH: the operator funds a freshly linked wallet (the prototype's starting balance). */
export async function fundDevWallet(
  deps: AppDeps,
  wallet: Wallet,
  wei: bigint,
  label: string,
  log: FastifyBaseLogger,
): Promise<string | null> {
  if (!deps.chain.rpcEnabled) return null;
  try {
    const r = await deps.chain.sendEth(wallet.address as Address, wei);
    if (r.status !== 'reverted') {
      await deps.prisma.activity.create({
        data: {
          userId: wallet.userId,
          label,
          amountWei: wei.toString(),
          txHash: r.hash,
          ref: `faucet:${r.hash}`,
        },
      });
    }
    return r.hash;
  } catch (e) {
    log.warn({ err: e }, 'dev faucet failed');
    return null;
  }
}

export const welcomeWei = () => ethToWei(DEV_WELCOME_ETH);
