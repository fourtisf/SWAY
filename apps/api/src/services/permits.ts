/**
 * Member permits (SwayKeys.register / registerAndBuy). Unless SPONSOR_ONBOARDING is on, joining sends no
 * transaction: the operator signs offchain what it used to send at sign-up (open the member's market, hand them
 * their X account's fan market, record who invited them) and the buy that first needs it onchain carries the
 * permit, paid by the buyer. Permits are signed per buy with a short deadline, for the member's current account
 * wallet, so a stale wallet can't be bound later.
 */
import type { KeyMarket, PrismaClient } from '@sway/db';
import type { Address, MemberPermit } from '@sway/shared';
import type { AppDeps, Viewer } from '../deps';
import { forbidden, notFound } from '../errors';
import { memberAddresses } from './access';
import { ZERO_ADDRESS } from './dto';
import { permitsEnabled } from './onboarding';

export const PERMIT_TTL_S = 30 * 60;
/** Wallets whose referrer is already set onchain (shared with the workers' syncReferrers). */
export const KNOWN_REFERRERS = 'referrer:set';

/** The inviter's account wallet once the invite is credited (brief §6), else null. */
async function creditedReferrer(prisma: Pick<PrismaClient, 'referral'>, userId: string): Promise<Address | null> {
  const r = await prisma.referral.findFirst({
    where: { inviteeId: userId, status: 'credited' },
    select: { inviter: { select: { wallet: { select: { address: true } } } } },
  });
  return (r?.inviter.wallet?.address.toLowerCase() as Address | undefined) ?? null;
}

type PermitDeps = Pick<AppDeps, 'prisma' | 'chain' | 'config' | 'redis'>;
type MarketRow = KeyMarket & { user: { wallet: { address: string } | null } };

async function signPermit(
  chain: AppDeps['chain'],
  kind: MemberPermit['kind'],
  wallet: Address,
  xId: bigint,
  referrer: Address,
): Promise<MemberPermit> {
  const deadline = Math.floor(Date.now() / 1000) + PERMIT_TTL_S;
  const signature = await chain.signMember({ wallet, xId, referrer, deadline: BigInt(deadline) });
  return { kind, wallet, xId: xId.toString(), referrer, deadline, signature };
}

/**
 * What a market still needs onchain before it can be bought: a member's own market not opened yet ('open'), or
 * a fan market its X account has claimed in the app ('claim'). Null when it needs nothing.
 */
export async function marketPermit(deps: PermitDeps, market: MarketRow): Promise<MemberPermit | null> {
  const { prisma, chain } = deps;
  if (!permitsEnabled(deps) || !market.claimed) return null;
  // Already mirrored as done (the indexer saw MarketOpened / FanMarketClaimed): no chain read.
  if (market.fan ? market.claimBlock !== null : market.opened) return null;
  const owner = (market.fan ? market.user.wallet?.address : market.subject)?.toLowerCase() as Address | undefined;
  if (!owner) return null;
  const onchain = await chain.market(market.subject as Address);
  const kind = !onchain ? (market.fan ? null : 'open') : market.fan && onchain.owner === ZERO_ADDRESS ? 'claim' : null;
  if (!kind) return null;
  const ref = await creditedReferrer(prisma, market.userId);
  return signPermit(chain, kind, owner, BigInt(market.xId), ref && ref !== owner ? ref : ZERO_ADDRESS);
}

export async function tradePermits(deps: PermitDeps, v: Viewer, subject: Address, trader: Address): Promise<MemberPermit[]> {
  const { prisma, chain, redis } = deps;
  const buyer = trader.toLowerCase() as Address;
  if (!(await memberAddresses(prisma, v.user.id)).includes(buyer))
    throw forbidden('not_your_wallet', 'That wallet isn’t linked to your account');
  const market = await prisma.keyMarket.findUnique({
    where: { subject: subject.toLowerCase() },
    include: { user: { select: { wallet: { select: { address: true } } } } },
  });
  if (!market) throw notFound('No key market for that address');
  if (!permitsEnabled(deps)) return [];

  const out: MemberPermit[] = [];
  const mp = await marketPermit(deps, market);
  if (mp) out.push(mp);

  // The buyer's own referrer, so their inviter earns the trader's half of the referral fee from this buy on.
  const covered = mp && mp.wallet === buyer && mp.referrer !== ZERO_ADDRESS;
  const ref = covered ? null : await creditedReferrer(prisma, v.user.id);
  if (ref && ref !== buyer && !(await redis.sismember(KNOWN_REFERRERS, buyer))) {
    if (await chain.referrerOf(buyer)) await redis.sadd(KNOWN_REFERRERS, buyer);
    else out.push(await signPermit(chain, 'referrer', buyer, 0n, ref));
  }
  return out;
}
