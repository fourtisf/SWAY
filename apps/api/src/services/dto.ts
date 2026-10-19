/** Row → DTO mappers shared by REST routes and the WebSocket hub. */
import type { KeyMarket, Notification, PrismaClient, Trade, User } from '@sway/db';
import { decToStr, Prisma } from '@sway/db';
import {
  shortAddress,
  type Address,
  type MessageDTO,
  type NotificationDTO,
  type RichText,
  type TradeDTO,
  type UserRef,
} from '@sway/shared';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export function userRef(
  u: Pick<User, 'handle' | 'name' | 'avatarUrl' | 'verified' | 'official'>,
  market?: Pick<KeyMarket, 'claimed'> | null,
): UserRef {
  return {
    handle: u.handle,
    name: u.name,
    avatarUrl: u.avatarUrl,
    verified: u.verified,
    official: u.official,
    claimed: market ? market.claimed : true,
  };
}

/** Identity for an address that belongs to no member (direct contract users, the fan escrow). */
export function addressRef(address: string, fanEscrow?: string | null): UserRef {
  if (fanEscrow && address.toLowerCase() === fanEscrow.toLowerCase()) {
    return {
      handle: 'escrow',
      name: 'Fan escrow',
      avatarUrl: null,
      verified: false,
      official: false,
      claimed: true,
    };
  }
  const s = shortAddress(address);
  return { handle: s, name: s, avatarUrl: null, verified: false, official: false, claimed: true };
}

/** Lowercase address → member (via Wallet, or LinkedWallet for a member's extra wallets). */
export async function membersByAddress(
  prisma: PrismaClient,
  addresses: string[],
): Promise<Map<string, User & { market: KeyMarket | null }>> {
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()))];
  if (!uniq.length) return new Map();
  const include = { user: { include: { market: true } } } as const;
  const [wallets, linked] = await Promise.all([
    prisma.wallet.findMany({ where: { address: { in: uniq } }, include }),
    prisma.linkedWallet.findMany({ where: { address: { in: uniq } }, include }),
  ]);
  return new Map([...linked, ...wallets].map((w) => [w.address, w.user]));
}

export type TradeRow = Trade & { market: KeyMarket & { user: User } };

export async function tradeDTOs(
  prisma: PrismaClient,
  trades: TradeRow[],
  fanEscrow?: string | null,
): Promise<TradeDTO[]> {
  const members = await membersByAddress(
    prisma,
    trades.map((t) => t.trader),
  );
  return trades.map((t) => {
    const m = members.get(t.trader.toLowerCase());
    return {
      txHash: t.txHash,
      logIndex: t.logIndex,
      trader: {
        ...(m ? userRef(m, m.market) : addressRef(t.trader, fanEscrow)),
        address: t.trader.toLowerCase() as Address,
      },
      market: { ...userRef(t.market.user, t.market), subject: t.market.subject as Address },
      isBuy: t.isBuy,
      units: t.units.toString(),
      baseWei: decToStr(t.baseWei),
      totalWei: decToStr(t.totalWei),
      supplyAfter: t.supplyAfter.toString(),
      ts: t.ts.toISOString(),
    };
  });
}

export const TRADE_INCLUDE = { market: { include: { user: true } } } satisfies Prisma.TradeInclude;

export function notificationDTO(
  n: Notification & { from: (User & { market?: KeyMarket | null }) | null },
): NotificationDTO {
  const body = Array.isArray(n.body) ? (n.body as unknown as RichText) : [{ t: String(n.body ?? '') }];
  return {
    id: n.id,
    type: n.type,
    from: n.from ? userRef(n.from, n.from.market ?? null) : null,
    body,
    link: n.link,
    createdAt: n.createdAt.toISOString(),
    read: n.readAt !== null,
  };
}

export function messageDTO(
  m: {
    id: string;
    text: string;
    createdAt: Date;
    authorId: string;
    author: User & { market?: KeyMarket | null };
  },
  viewerId: string | null,
): MessageDTO {
  return {
    id: m.id,
    from: userRef(m.author, m.author.market ?? null),
    text: m.text,
    createdAt: m.createdAt.toISOString(),
    mine: viewerId !== null && m.authorId === viewerId,
  };
}
