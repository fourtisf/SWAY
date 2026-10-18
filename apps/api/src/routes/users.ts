/** Profiles, holders, trades, rooms, follow, subscribe, tip and claim/takedown requests. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Hash } from 'viem';
import { usdToWei } from '@sway/curve';
import {
  SUBSCRIPTION_USD,
  TIP_USD,
  type Address,
  type HolderDTO,
  type MessageDTO,
  type PostDTO,
  type ProfileDTO,
  type RoomResponse,
  type TradeDTO,
} from '@sway/shared';
import { HandleParams, TxHash, body, params, text, userByHandle } from './_util';
import { getViewer, requireViewer } from '../plugins/auth';
import { badRequest, conflict, forbidden, notFound, unavailable } from '../errors';
import type { Viewer } from '../deps';
import { addressRef, membersByAddress, messageDTO, TRADE_INCLUDE, tradeDTOs, userRef } from '../services/dto';
import { marketDtoForUser, marketStats, oneKeyTotalWei, priceHistory } from '../services/markets';
import { postDTOs, POST_INCLUDE } from '../services/feed';
import { publish } from '../services/bus';
import { getEthUsd } from '../services/price';

const SUB_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

export async function userRoutes(app: FastifyInstance) {
  const { prisma, redis, chain, config } = app.deps;
  const ctx = { prisma, access: app.access };
  const accessViewer = (v: Viewer | null) =>
    v ? { userId: v.user.id, wallet: v.wallet?.address ?? null } : null;

  app.get('/users/:handle', async (req): Promise<ProfileDTO> => {
    const { handle } = params(HandleParams, req);
    const u = await userByHandle(req, handle, { market: true, wallet: true });
    const v = await getViewer(req);
    const m = u.market;
    const [stats, history, follow, sub, held] = await Promise.all([
      m ? marketStats(prisma, [m]) : null,
      m ? priceHistory(prisma, m) : [],
      v
        ? prisma.follow.findUnique({
            where: { followerId_followeeId: { followerId: v.user.id, followeeId: u.id } },
          })
        : null,
      v
        ? prisma.subscription.findFirst({
            where: { subscriberId: v.user.id, creatorId: u.id, expiresAt: { gt: new Date() } },
          })
        : null,
      v?.wallet && m
        ? prisma.holding.findUnique({
            where: { marketId_address: { marketId: m.id, address: v.wallet.address } },
          })
        : null,
    ]);
    const unclaimed = !!m && !m.claimed;
    return {
      ...marketDtoForUser(u, m ? stats?.get(m.id) : undefined),
      bio: u.bio,
      ownerAddress: !unclaimed && u.wallet ? (u.wallet.address as Address) : null,
      isMe: v?.user.id === u.id,
      following: !!follow,
      subscribed: !!sub,
      heldUnits: (held?.units ?? 0n).toString(),
      history,
    };
  });

  app.get('/users/:handle/posts', async (req): Promise<PostDTO[]> => {
    const { handle } = params(HandleParams, req);
    const u = await userByHandle(req, handle, {});
    const posts = await prisma.post.findMany({
      where: { authorId: u.id, deletedAt: null, parentId: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      include: POST_INCLUDE,
    });
    return postDTOs(ctx, await getViewer(req), posts);
  });

  app.get('/users/:handle/holders', async (req): Promise<HolderDTO[]> => {
    const { handle } = params(HandleParams, req);
    const u = await userByHandle(req, handle, { market: true });
    if (!u.market) return [];
    const v = await getViewer(req);
    const rows = await prisma.holding.findMany({
      where: { marketId: u.market.id, units: { gt: 0n } },
      orderBy: { units: 'desc' },
      take: 200,
    });
    const members = await membersByAddress(
      prisma,
      rows.map((r) => r.address),
    );
    return rows.map((r) => {
      const m = members.get(r.address);
      return {
        ...(m ? userRef(m, m.market) : addressRef(r.address, config.contracts.fanEscrow)),
        units: r.units.toString(),
        you: !!v?.wallet && v.wallet.address === r.address,
      };
    });
  });

  app.get('/users/:handle/trades', async (req): Promise<TradeDTO[]> => {
    const { handle } = params(HandleParams, req);
    const u = await userByHandle(req, handle, { market: true });
    if (!u.market) return [];
    const trades = await prisma.trade.findMany({
      where: { marketId: u.market.id },
      orderBy: [{ ts: 'desc' }, { logIndex: 'desc' }],
      take: 50,
      include: TRADE_INCLUDE,
    });
    return tradeDTOs(prisma, trades, config.contracts.fanEscrow);
  });

  /* ------------------------------------------------------------------ rooms */

  async function marketOf(req: FastifyRequest) {
    const { handle } = params(HandleParams, req);
    const u = await userByHandle(req, handle, { market: true });
    if (!u.market) throw notFound(`@${handle} has no key market yet`, 'no_market');
    return { user: u, market: u.market };
  }

  app.get('/users/:handle/room', async (req): Promise<RoomResponse> => {
    const { market } = await marketOf(req);
    const v = await getViewer(req);
    const access = await app.access.roomAccess(accessViewer(v), market);
    let messages: MessageDTO[] = [];
    if (access === 'open') {
      const rows = await prisma.roomMessage.findMany({
        where: { marketId: market.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { author: { include: { market: true } } },
      });
      messages = rows.reverse().map((m) => messageDTO(m, v?.user.id ?? null));
      if (v) {
        await prisma.roomRead.upsert({
          where: { userId_marketId: { userId: v.user.id, marketId: market.id } },
          create: { userId: v.user.id, marketId: market.id, readAt: new Date() },
          update: { readAt: new Date() },
        });
      }
    }
    return { access, messages, oneKeyTotalWei: oneKeyTotalWei(market.supplyUnits).toString() };
  });

  app.post(
    '/users/:handle/room',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req): Promise<MessageDTO> => {
      const v = await requireViewer(req);
      const { market } = await marketOf(req);
      const b = body(z.object({ text: text(1000) }), req);
      const access = await app.access.roomAccess(accessViewer(v), market);
      if (access !== 'open') {
        throw forbidden(
          'locked',
          access === 'unclaimed'
            ? 'This room opens when the account claims its market'
            : 'Hold 1 key to post in this room',
        );
      }
      const now = new Date();
      const msg = await prisma.roomMessage.create({
        data: { marketId: market.id, authorId: v.user.id, text: b.text, createdAt: now },
        include: { author: { include: { market: true } } },
      });
      await prisma.roomRead.upsert({
        where: { userId_marketId: { userId: v.user.id, marketId: market.id } },
        create: { userId: v.user.id, marketId: market.id, readAt: now },
        update: { readAt: now },
      });
      await publish(redis, { kind: 'room', messageId: msg.id }).catch(() => undefined);
      return messageDTO(msg, v.user.id);
    },
  );

  /* ------------------------------------------------------------------ follow */

  app.post('/users/:handle/follow', async (req) => {
    const v = await requireViewer(req);
    const { handle } = params(HandleParams, req);
    const u = await userByHandle(req, handle, {});
    if (u.id === v.user.id) throw badRequest('self', 'You can’t follow yourself');
    const key = { followerId: v.user.id, followeeId: u.id };
    const removed = await prisma.follow.deleteMany({ where: key });
    if (removed.count) return { following: false };
    await prisma.follow.createMany({ data: [key], skipDuplicates: true });
    return { following: true };
  });

  /* ------------------------------------------------------------------ payments (subscribe, tip) */

  /**
   * Checks that `txHash` sent ≥ the USD amount (2% tolerance at the current price) from the viewer's wallet
   * to the creator's wallet. Without an RPC the amount is assumed.
   */
  async function verifyPayment(v: Viewer, creatorWallet: string, usd: number, txHash: Hash): Promise<bigint> {
    const { ethUsd } = await getEthUsd(redis, config.ethUsdFallback);
    const expected = usdToWei(usd, ethUsd);
    if (!chain.rpcEnabled) return expected;
    let tx;
    try {
      tx = await chain.waitForTx(txHash, 15_000);
    } catch {
      throw unavailable('chain_unavailable', 'Could not reach the chain to check the payment. Try again.');
    }
    if (!tx) throw badRequest('tx_not_found', 'That transaction was not found onchain');
    if (tx.status === 'pending')
      throw conflict('tx_pending', 'The payment is not confirmed yet. Try again in a moment.');
    if (tx.status === 'reverted') throw badRequest('tx_reverted', 'That payment reverted');
    if (tx.from !== v.wallet!.address)
      throw forbidden('tx_not_yours', 'That payment was not sent from your wallet');
    if (tx.to !== creatorWallet.toLowerCase())
      throw badRequest('wrong_recipient', 'That payment did not go to this creator');
    if (tx.value * 100n < expected * 98n) throw badRequest('underpaid', `The payment is less than $${usd}`);
    return tx.value;
  }

  async function payTarget(req: FastifyRequest) {
    const v = await requireViewer(req);
    if (!v.wallet) throw conflict('no_wallet', 'Link a wallet first');
    const { handle } = params(HandleParams, req);
    const u = await userByHandle(req, handle, { market: true, wallet: true });
    if (u.id === v.user.id) throw badRequest('self', 'You can’t pay yourself');
    if (!u.wallet || (u.market && !u.market.claimed))
      throw conflict('no_owner', `@${handle} hasn’t claimed this account yet`);
    const { txHash } = body(z.object({ txHash: TxHash }), req);
    return { v, u, wallet: u.wallet, txHash };
  }

  app.post('/users/:handle/subscribe', async (req) => {
    const { v, u, wallet, txHash } = await payTarget(req);
    if (await prisma.subscription.findUnique({ where: { txHash } }))
      throw conflict('tx_used', 'This payment is already recorded');
    const value = await verifyPayment(v, wallet.address, SUBSCRIPTION_USD, txHash);
    const current = await prisma.subscription.findFirst({
      where: { subscriberId: v.user.id, creatorId: u.id, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'desc' },
    });
    const from = current ? current.expiresAt.getTime() : Date.now();
    await prisma.$transaction([
      prisma.subscription.create({
        data: {
          subscriberId: v.user.id,
          creatorId: u.id,
          txHash,
          amountWei: value.toString(),
          expiresAt: new Date(from + SUB_DAYS * DAY_MS),
        },
      }),
      prisma.activity.createMany({
        data: [
          {
            userId: v.user.id,
            label: `Subscribed to ${u.name}`,
            amountWei: (-value).toString(),
            txHash,
            ref: `sub:${txHash}:out`,
          },
          {
            userId: u.id,
            label: `Subscription from ${v.user.name}`,
            amountWei: value.toString(),
            txHash,
            ref: `sub:${txHash}:in`,
          },
        ],
        skipDuplicates: true,
      }),
    ]);
    return { ok: true as const };
  });

  app.post('/users/:handle/tip', async (req) => {
    const { v, u, wallet, txHash } = await payTarget(req);
    if (await prisma.activity.findUnique({ where: { ref: `tip:${txHash}:out` } }))
      throw conflict('tx_used', 'This payment is already recorded');
    const value = await verifyPayment(v, wallet.address, TIP_USD, txHash);
    await prisma.activity.createMany({
      data: [
        {
          userId: v.user.id,
          label: `Tipped ${u.name}`,
          amountWei: (-value).toString(),
          txHash,
          ref: `tip:${txHash}:out`,
        },
        {
          userId: u.id,
          label: `Tip from ${v.user.name}`,
          amountWei: value.toString(),
          txHash,
          ref: `tip:${txHash}:in`,
        },
      ],
      skipDuplicates: true,
    });
    return { ok: true as const };
  });

  /* ------------------------------------------------------------------ fan markets: claim / takedown */

  const ClaimBody = z.object({
    kind: z.enum(['claim', 'takedown']),
    contact: z.string().trim().min(3).max(200),
    note: z.string().trim().max(2000).optional(),
  });

  app.post(
    '/users/:handle/claim-request',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const v = await requireViewer(req);
      const { market } = await marketOf(req);
      const b = body(ClaimBody, req);
      await prisma.claimRequest.create({
        data: {
          marketId: market.id,
          userId: v.user.id,
          kind: b.kind,
          contact: b.contact,
          note: b.note || null,
        },
      });
      return { ok: true as const };
    },
  );
}
