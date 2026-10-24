/**
 * Collects everything a wallet the server holds a key for (the operator) can still turn into ETH: SwayKeys earnings,
 * launchpad creator fees, unclaimed key-holder airdrops, launchpad tokens (sold on the curve) and keys beyond the
 * locked first one. Each step asks first. scripts/sweep.ts runs it for the operator.
 */
import type { prisma as Prisma } from '@sway/db';
import { swayKeysAbi, swayLaunchpadAbi } from '@sway/shared/abi';
import { erc20Abi, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from 'viem';

const LOCKED = 100n;
const lc = (a: string) => a.toLowerCase();

export interface SweepContext {
  prisma: typeof Prisma;
  pub: PublicClient;
  wallet: WalletClient<Transport, Chain, Account>;
  keys: Address;
  launchpad: Address | null;
  /** Asks before each transaction; false skips that step. */
  confirm(question: string): Promise<boolean>;
  log(msg: string): void;
  eth(wei: bigint): string;
}

export interface SweepResult {
  claimedKeys: bigint;
  creatorFees: bigint;
  airdrops: number;
  soldTokens: bigint;
  soldKeys: bigint;
  toppedUp: bigint;
}

export async function sweep(ctx: SweepContext, topUps: Array<{ address: Address; label: string; wei: bigint }> = []): Promise<SweepResult> {
  const { pub, wallet, keys, launchpad } = ctx;
  const me = wallet.account.address;
  const send = async (hash: Hex) => {
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`transaction ${hash} reverted`);
  };
  const out: SweepResult = { claimedKeys: 0n, creatorFees: 0n, airdrops: 0, soldTokens: 0n, soldKeys: 0n, toppedUp: 0n };

  // Keys beyond the locked first one, at the curve's sell price (1% under the quote as slippage room).
  const holdings = await ctx.prisma.holding.findMany({ where: { address: lc(me), units: { gt: 0n } }, include: { market: { select: { subject: true, user: { select: { handle: true } } } } } });
  for (const h of holdings) {
    const subject = h.market.subject as Address;
    const [units, market] = await Promise.all([
      pub.readContract({ address: keys, abi: swayKeysAbi, functionName: 'balanceOf', args: [subject, me] }) as Promise<bigint>,
      pub.readContract({ address: keys, abi: swayKeysAbi, functionName: 'markets', args: [subject] }) as Promise<readonly unknown[]>,
    ]);
    const owner = lc(String(market[0])) === lc(me);
    const supply = market[6] as bigint;
    const sellable = owner ? units - LOCKED : units;
    if (sellable <= 0n || supply - sellable < LOCKED) continue;
    // The contract's own quote for this seller: it includes the anti-dump fee when they bought in the last 24h.
    const q = (await pub.readContract({ address: keys, abi: swayKeysAbi, functionName: 'quote', args: [subject, sellable, false, me] })) as readonly bigint[];
    const total = q[5]!;
    if (!(await ctx.confirm(`Sell ${Number(sellable) / 100} keys of @${h.market.user.handle} for ${ctx.eth(total)}?`))) continue;
    await send(await wallet.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'sell', args: [subject, sellable, (total * 99n) / 100n] }));
    out.soldKeys += total;
    ctx.log(`sold: ${ctx.eth(total)}`);
  }

  // SwayKeys earnings: creator, holder (settled per market held), referral, protocol.
  const subjects = holdings.map((h) => h.market.subject as Address);
  const [c, hd, r, p] = (await pub.readContract({ address: keys, abi: swayKeysAbi, functionName: 'claimable', args: [me, subjects] })) as readonly bigint[];
  const earned = c! + hd! + r! + p!;
  if (earned > 0n && (await ctx.confirm(`Claim ${ctx.eth(earned)} of SwayKeys earnings?`))) {
    await send(await wallet.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'claim', args: [subjects] }));
    out.claimedKeys = earned;
    ctx.log('claimed');
  }

  if (launchpad) {
    // Key-holder airdrops the mirror has a proof for and the chain says are still open.
    const drops = await ctx.prisma.launchAirdrop.findMany({ where: { address: lc(me) }, include: { launchToken: { select: { symbol: true, tokenAddress: true } } } });
    for (const d of drops) {
      const token = d.launchToken.tokenAddress as Address | null;
      if (!token) continue;
      if (await pub.readContract({ address: launchpad, abi: swayLaunchpadAbi, functionName: 'airdropClaimed', args: [token, me] })) continue;
      const amount = BigInt(d.amount.toFixed(0));
      if (!(await ctx.confirm(`Claim the ${(Number(amount) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0 })} $${d.launchToken.symbol} airdrop?`))) continue;
      await send(await wallet.writeContract({ address: launchpad, abi: swayLaunchpadAbi, functionName: 'claimAirdrop', args: [token, amount, d.proof as Hex[]] }));
      out.airdrops++;
      ctx.log('claimed');
    }

    // Every launched token this wallet holds, read from the chain, sold on its curve.
    const tokens = await ctx.prisma.launchToken.findMany({ where: { tokenAddress: { not: null }, graduated: false }, select: { symbol: true, tokenAddress: true } });
    for (const t of tokens) {
      const token = t.tokenAddress as Address;
      const balance = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
      if (balance === 0n) continue;
      const [ethOut] = (await pub.readContract({ address: launchpad, abi: swayLaunchpadAbi, functionName: 'quoteSell', args: [token, balance] })) as readonly bigint[];
      if (!ethOut) continue;
      const amount = (Number(balance) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0 });
      if (!(await ctx.confirm(`Sell ${amount} $${t.symbol} on the launchpad for ${ctx.eth(ethOut)}?`))) continue;
      const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [me, launchpad] });
      if (allowance < balance) await send(await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [launchpad, balance] }));
      await send(await wallet.writeContract({ address: launchpad, abi: swayLaunchpadAbi, functionName: 'sell', args: [token, balance, (ethOut * 99n) / 100n] }));
      out.soldTokens += ethOut;
      ctx.log(`sold: ${ctx.eth(ethOut)}`);
    }
    // Last: selling a token this wallet created pays it a creator fee too.
    const fees = (await pub.readContract({ address: launchpad, abi: swayLaunchpadAbi, functionName: 'creatorFees', args: [me] })) as bigint;
    if (fees > 0n && (await ctx.confirm(`Claim ${ctx.eth(fees)} of launchpad creator fees?`))) {
      await send(await wallet.writeContract({ address: launchpad, abi: swayLaunchpadAbi, functionName: 'claimCreatorFees' }));
      out.creatorFees = fees;
      ctx.log('claimed');
    }
  }

  // Gas for wallets whose keys live in a browser, so they can sell and withdraw from the app.
  for (const t of topUps) {
    const has = await pub.getBalance({ address: t.address });
    if (has >= t.wei) continue;
    if (!(await ctx.confirm(`Send ${ctx.eth(t.wei - has)} of gas to ${t.label} ${t.address}?`))) continue;
    await send(await wallet.sendTransaction({ to: t.address, value: t.wei - has }));
    out.toppedUp += t.wei - has;
    ctx.log('sent');
  }
  return out;
}
