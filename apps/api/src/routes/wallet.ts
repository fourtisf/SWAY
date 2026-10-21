/**
 * Account-wallet link (signature), onboarding (market open/claim), trade permits, wallet page, activity log and
 * the dev faucet.
 * More wallets are added through routes/wallets.ts; the wallet page sums every wallet of the member.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Hash } from 'viem';
import { decToStr, type Activity } from '@sway/db';
import { usdToWei } from '@sway/curve';
import {
  WALLET_CONNECTOR_RE,
  type ActivityDTO,
  type Address as Addr,
  type MeDTO,
  type OnboardingStatus,
  type TradePermitsResponse,
  type WalletDTO,
  type WalletNonceResponse,
} from '@sway/shared';
import { Address, TxHash, WeiString, body } from './_util';
import { requireViewer, resetViewer } from '../plugins/auth';
import { badRequest, conflict, forbidden, notFound, unavailable } from '../errors';
import { buildMe } from '../services/me';
import { fundDevWallet, onboardingStatus, openOrClaimMarket, welcomeWei } from '../services/onboarding';
import { getEthUsd } from '../services/price';
import { memberAddresses } from '../services/access';
import { createAccountWallet, maybeGasDrip, verifyLinkSignature, walletOverview } from '../services/wallets';
import { fundDevSway } from '../services/launch';
import { tradePermits } from '../services/permits';

const NONCE_TTL_S = 600;
const nonceKey = (userId: string) => `wnonce:${userId}`;
export const ADDRESS_PLACEHOLDER = '{address}';

export function linkMessage(handle: string, chainId: number, nonce: string, issuedAt: string): string {
  return [
    `Sway wants you to link this wallet to @${handle}.`,
    '',
    'Signing is free and sends no transaction. This becomes your account wallet: it owns your key market.',
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
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, 'must be a hex signature')
      .max(20_000),
    kind: z.enum(['embedded', 'external']),
    /* [A] logo key of the wallet app */
    connector: z.string().regex(WALLET_CONNECTOR_RE, 'must be a wallet id').optional(),
  });

  app.post('/wallet/link', async (req): Promise<MeDTO> => {
    const v = await requireViewer(req);
    const b = body(LinkBody, req);
    const address = b.address.toLowerCase();
    if (b.kind === 'embedded' && config.wallets.embedded === 'off')
      throw conflict('embedded_off', 'Browser-made Sway wallets are off on this network: connect a wallet app instead');
    if (v.wallet) {
      if (v.wallet.address === address) return buildMe(prisma, v);
      throw conflict('wallet_exists', 'Your account already has a wallet. Add more wallets from the Wallet page.');
    }
    const raw = await redis.get(nonceKey(v.user.id));
    if (!raw)
      throw badRequest('nonce_expired', 'The link request expired. Request a new message and sign again.');
    const { template } = JSON.parse(raw) as { nonce: string; template: string };

    if (!(await verifyLinkSignature(chain, template, b.address, b.signature as `0x${string}`)))
      throw badRequest('bad_signature', 'The signature does not match this address and message');

    // One member per address across account and linked wallets (one serializable transaction).
    const wallet = await createAccountWallet(prisma, {
      userId: v.user.id,
      address,
      kind: b.kind,
      connector: b.connector ?? (b.kind === 'embedded' ? 'sway' : null),
    });
    await redis.del(nonceKey(v.user.id));

    if (config.chain.isLocal && config.devAuth) {
      void fundDevWallet(app.deps, wallet, welcomeWei(), 'Welcome funds (local chain)', req.log);
    }
    // [A] Real chains: a one-time gas drip for qualifying X accounts (no-op unless GAS_DRIP_WEI is set).
    void maybeGasDrip(app.deps, v.user, address, req.session, req.log).catch((e) =>
      req.log.warn({ err: e }, 'gas drip failed'),
    );
    resetViewer(req);
    return buildMe(prisma, await requireViewer(req));
  });

  app.get('/onboarding', async (req): Promise<OnboardingStatus> =>
    onboardingStatus(app.deps, await requireViewer(req)),
  );

  app.post('/onboarding/market', async (req): Promise<OnboardingStatus> => {
    const v = await requireViewer(req);
    const r = await openOrClaimMarket(app.deps, v, req.log);
    resetViewer(req);
    const status = onboardingStatus(app.deps, await requireViewer(req));
    return { ...status, marketTx: r.tx ?? status.marketTx };
  });

  app.post('/trade/permits', async (req): Promise<TradePermitsResponse> => {
    const v = await requireViewer(req);
    const b = body(z.object({ subject: Address, trader: Address }), req);
    return { permits: await tradePermits(app.deps, v, b.subject as Addr, b.trader as Addr) };
  });

  app.get('/wallet', async (req): Promise<WalletDTO> => {
    const v = await requireViewer(req);
    if (!v.wallet) throw notFound('No wallet linked yet', 'no_wallet');
    // [A] Summed across every wallet of the member, with the per-wallet breakdown in `wallets`.
    const [o, activity] = await Promise.all([
      walletOverview(app.deps, v),
      prisma.activity.findMany({ where: { userId: v.user.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    return {
      address: v.wallet.address as Addr,
      kind: v.wallet.kind,
      cashWei: o.total.cashWei.toString(),
      keysValueWei: o.total.keysValueWei.toString(),
      earnings: o.total.earnings,
      keys: { units: o.total.units.toString(), markets: o.total.markets },
      holdings: o.holdings,
      activity: activity.map(activityDTO),
      wallets: o.wallets,
    };
  });

  const ActivityBody = z.object({
    label: z.string().trim().min(1).max(80),
    amountWei: WeiString,
    txHash: TxHash,
  });

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
      if (tx && !(await memberAddresses(prisma, v.user.id)).includes(tx.from))
        throw forbidden('tx_not_yours', 'That transaction was not sent from your wallet');
      if (tx && tx.status === 'reverted') throw badRequest('tx_reverted', 'That transaction reverted');
    }
    const row = await prisma.activity.create({
      data: { userId: v.user.id, label: b.label, amountWei: b.amountWei, txHash: b.txHash, ref },
    });
    return activityDTO(row);
  });

  app.post('/dev/faucet', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    if (!config.chain.isLocal || config.isProd)
      throw forbidden('dev_only', 'The faucet only runs on the local dev chain');
    const v = await requireViewer(req);
    if (!v.wallet) throw notFound('No wallet linked yet', 'no_wallet');
    // [A] Any of the member's wallets (default: the account wallet).
    const b = body(z.object({ address: Address.optional() }), req);
    const to = b.address?.toLowerCase() ?? v.wallet.address;
    if (!(await memberAddresses(prisma, v.user.id)).includes(to))
      throw notFound('That wallet is not one of yours', 'wallet_not_found');
    const { ethUsd } = await getEthUsd(redis, config.ethUsdFallback);
    const hash = await fundDevWallet(
      app.deps,
      { address: to, userId: v.user.id },
      usdToWei(100, ethUsd),
      'Deposit (dev faucet)',
      req.log,
    );
    if (!hash) throw unavailable('chain_unavailable', 'The local chain or operator key is not available');
    // [C] 10,000 $SWAY for staking (local chains only).
    const swayTxHash = await fundDevSway(app, to, req.log);
    return { txHash: hash, ...(swayTxHash ? { swayTxHash } : {}) };
  });
}
