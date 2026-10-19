/**
 * [A] Extra wallets (WALLET_ROUTES): list with balances, add by signature, rename, remove. The account wallet
 * is linked through POST /api/wallet/link and can't be renamed or removed here.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  MAX_LINKED_WALLETS,
  WALLET_CONNECTOR_RE,
  WALLET_LABEL_MAX,
  type MeDTO,
  type WalletInfoDTO,
  type WalletNonceResponse,
  type WalletsResponse,
} from '@sway/shared';
import { Address, body, params } from './_util';
import { requireViewer, resetViewer } from '../plugins/auth';
import { badRequest, conflict, notFound } from '../errors';
import { buildMe } from '../services/me';
import {
  ADDRESS_PLACEHOLDER,
  addLinkedWallet,
  addWalletMessage,
  linkedInfo,
  verifyLinkSignature,
  walletOverview,
} from '../services/wallets';

const NONCE_TTL_S = 600;
const nonceKey = (userId: string) => `wlnonce:${userId}`;

const Label = z
  .string()
  .trim()
  .max(WALLET_LABEL_MAX, `must be at most ${WALLET_LABEL_MAX} characters`)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'must not contain control characters');

const LinkBody = z.object({
  address: Address,
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'must be a hex signature')
    .max(20_000),
  connector: z.string().regex(WALLET_CONNECTOR_RE, 'must be a wallet id'),
  label: Label.optional(),
  kind: z.enum(['embedded', 'external']).default('external'),
});

const AddressParams = z.object({ address: Address.transform((a) => a.toLowerCase()) });

export async function walletsRoutes(app: FastifyInstance) {
  const { config, prisma, redis, chain } = app.deps;

  /** The viewer's linked wallet at :address, or 404 (409 for the account wallet). */
  async function linkedOf(req: FastifyRequest) {
    const v = await requireViewer(req);
    const { address } = params(AddressParams, req);
    if (v.wallet?.address === address)
      throw conflict('account_wallet', 'Your account wallet owns your key market, so it stays as it is');
    const row = await prisma.linkedWallet.findUnique({ where: { address } });
    if (!row || row.userId !== v.user.id) throw notFound('That wallet is not one of yours', 'wallet_not_found');
    return { v, row };
  }

  app.get('/wallets', async (req): Promise<WalletsResponse> => {
    const v = await requireViewer(req);
    const o = await walletOverview(app.deps, v);
    return { wallets: o.wallets, maxLinked: MAX_LINKED_WALLETS };
  });

  app.post('/wallets/nonce', async (req): Promise<WalletNonceResponse> => {
    const v = await requireViewer(req);
    const b = body(z.object({ address: Address.optional() }), req);
    const nonce = randomBytes(16).toString('hex');
    const template = addWalletMessage(v.user.handle, config.chain.id, nonce, new Date().toISOString());
    await redis.set(nonceKey(v.user.id), JSON.stringify({ nonce, template }), 'EX', NONCE_TTL_S);
    return { nonce, message: b.address ? template.replace(ADDRESS_PLACEHOLDER, b.address) : template };
  });

  app.post('/wallets/link', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<MeDTO> => {
    const v = await requireViewer(req);
    const b = body(LinkBody, req);
    const address = b.address.toLowerCase();
    if (!v.wallet) throw conflict('no_wallet', 'Set up your account wallet first');
    if (v.wallet.address === address) throw conflict('wallet_is_account', 'This is already your account wallet');

    const raw = await redis.get(nonceKey(v.user.id));
    if (!raw) throw badRequest('nonce_expired', 'The request expired. Request a new message and sign again.');
    const { template } = JSON.parse(raw) as { nonce: string; template: string };
    if (!(await verifyLinkSignature(chain, template, b.address, b.signature as `0x${string}`)))
      throw badRequest('bad_signature', 'The signature does not match this address and message');

    await addLinkedWallet(prisma, {
      userId: v.user.id,
      address,
      kind: b.kind,
      connector: b.connector,
      label: b.label || null,
    });
    await redis.del(nonceKey(v.user.id));
    resetViewer(req);
    return buildMe(prisma, await requireViewer(req));
  });

  app.patch('/wallets/:address', async (req): Promise<WalletInfoDTO> => {
    const { row } = await linkedOf(req);
    const b = body(z.object({ label: Label.nullable() }), req);
    const updated = await prisma.linkedWallet.update({ where: { id: row.id }, data: { label: b.label || null } });
    return linkedInfo(updated);
  });

  app.delete('/wallets/:address', async (req): Promise<MeDTO> => {
    const { row } = await linkedOf(req);
    // Keys stay onchain at that address; they simply stop counting for this member.
    await prisma.linkedWallet.delete({ where: { id: row.id } });
    resetViewer(req);
    return buildMe(prisma, await requireViewer(req));
  });
}
