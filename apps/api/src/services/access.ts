/**
 * Room and holder-only post access (brief §4): onchain SwayKeys.balanceOf(subject, wallet) summed over every
 * wallet of the member (account + linked) ≥ 100 units, each balance cached in Redis for 60s
 * (`acc:<subject>:<wallet>` → units). Market owners always have access. Unclaimed fan markets have no room.
 * Subscriber access is an unexpired Subscription row.
 */
import type { Redis } from 'ioredis';
import type { KeyMarket, PrismaClient } from '@sway/db';
import type { Address, RoomAccess } from '@sway/shared';
import type { ChainClient } from './chain';

export const ACCESS_UNITS = 100n;
export const ACCESS_TTL_S = 60;
export const accessKey = (subject: string, holder: string) =>
  `acc:${subject.toLowerCase()}:${holder.toLowerCase()}`;

export interface AccessViewer {
  userId: string;
  /** The account wallet. A viewer without one has no linked wallets either (linking needs it). */
  wallet: string | null;
  /** Every wallet of the member, account first; looked up when omitted. */
  wallets?: string[];
}

type MarketLike = Pick<KeyMarket, 'id' | 'subject' | 'userId' | 'claimed'>;

/**
 * Lowercase addresses of every wallet of a member: the account wallet first, then linked wallets oldest
 * first. Keys held across all of them count together everywhere access or holdings are checked.
 */
export async function memberAddresses(
  prisma: Pick<PrismaClient, 'wallet' | 'linkedWallet'>,
  userId: string,
): Promise<string[]> {
  const [account, linked] = await Promise.all([
    prisma.wallet.findUnique({ where: { userId }, select: { address: true } }),
    prisma.linkedWallet.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { address: true },
    }),
  ]);
  const out = account ? [account.address.toLowerCase()] : [];
  for (const l of linked) if (!out.includes(l.address.toLowerCase())) out.push(l.address.toLowerCase());
  return out;
}

export class AccessService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly chain: ChainClient,
  ) {}

  /** Onchain balances for many markets for one wallet: Redis first, then one multicall for the misses. */
  async balances(wallet: string, subjects: string[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    const uniq = [...new Set(subjects.map((s) => s.toLowerCase()))];
    if (!uniq.length) return out;
    if (!this.chain.keysEnabled) {
      for (const s of uniq) out.set(s, 0n);
      return out;
    }
    const keys = uniq.map((s) => accessKey(s, wallet));
    const cached = await this.redis.mget(...keys).catch(() => keys.map(() => null));
    const misses: string[] = [];
    uniq.forEach((s, i) => {
      const v = cached[i];
      if (v !== null && v !== undefined && /^\d+$/.test(v)) out.set(s, BigInt(v));
      else misses.push(s);
    });
    if (misses.length) {
      let bals: bigint[];
      try {
        bals = await this.chain.keyBalances(
          misses.map((s) => ({ subject: s as Address, holder: wallet.toLowerCase() as Address })),
        );
      } catch {
        bals = misses.map(() => 0n); // chain unreachable: no access, nothing cached
        misses.forEach((s, i) => out.set(s, bals[i]!));
        return out;
      }
      const pipe = this.redis.pipeline();
      misses.forEach((s, i) => {
        out.set(s, bals[i]!);
        pipe.set(accessKey(s, wallet), bals[i]!.toString(), 'EX', ACCESS_TTL_S);
      });
      await pipe.exec().catch(() => undefined);
    }
    return out;
  }

  /** Units per subject summed across several wallets (each read through the per-wallet cache). */
  async balancesAcross(wallets: string[], subjects: string[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    const per = await Promise.all([...new Set(wallets.map((w) => w.toLowerCase()))].map((w) => this.balances(w, subjects)));
    for (const m of per) for (const [s, v] of m) out.set(s, (out.get(s) ?? 0n) + v);
    return out;
  }

  /**
   * Holder access per market id for a viewer (owner → true, unclaimed fan market → false). Units across all
   * of the member's wallets count together.
   */
  async holderAccess(viewer: AccessViewer | null, markets: MarketLike[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    const toCheck: MarketLike[] = [];
    for (const m of markets) {
      if (viewer && m.claimed && m.userId === viewer.userId) out.set(m.id, true);
      else if (!viewer || !viewer.wallet || !m.claimed) out.set(m.id, false);
      else toCheck.push(m);
    }
    if (toCheck.length && viewer?.wallet) {
      const wallets = viewer.wallets ?? (await memberAddresses(this.prisma, viewer.userId));
      const bals = await this.balancesAcross(
        wallets.length ? wallets : [viewer.wallet],
        toCheck.map((m) => m.subject),
      );
      for (const m of toCheck) out.set(m.id, (bals.get(m.subject.toLowerCase()) ?? 0n) >= ACCESS_UNITS);
    }
    return out;
  }

  async roomAccess(viewer: AccessViewer | null, market: MarketLike): Promise<RoomAccess> {
    if (!market.claimed) return 'unclaimed';
    const m = await this.holderAccess(viewer, [market]);
    return m.get(market.id) ? 'open' : 'locked';
  }

  /** Creator user ids the viewer has an unexpired subscription to. */
  async subscribedTo(viewerId: string | null, creatorIds: string[]): Promise<Set<string>> {
    if (!viewerId || !creatorIds.length) return new Set();
    const rows = await this.prisma.subscription.findMany({
      where: {
        subscriberId: viewerId,
        creatorId: { in: [...new Set(creatorIds)] },
        expiresAt: { gt: new Date() },
      },
      select: { creatorId: true },
    });
    return new Set(rows.map((r) => r.creatorId));
  }

  /** Drops cached balances after a trade so buying (or selling the last key) applies at once. */
  async invalidate(subject: string, holder: string): Promise<void> {
    await this.redis.del(accessKey(subject, holder)).catch(() => undefined);
  }
}
