/**
 * Read-only audit of members' wallets (src/audit.ts): where their ETH came from and went, what their key trades
 * cost, which fees went where, who traded their keys, and what is still waiting to be claimed. Sends nothing.
 *
 *   bash deploy/audit-wallets.sh swaydotfamily _sonic_hub bittez [operator] [treasury] [0xExtraWallet …]
 *   bash deploy/audit-wallets.sh --all
 *
 * Handles take every wallet of that member (account + linked). Every key trade pays 10% in fees (creator 6%,
 * protocol 2%, holders 1%, referral 1%; +5% to holders on a sell within 24h of the seller's last buy), credited in
 * SwayKeys until claimed, so a round trip between your own wallets shows as a loss until those are claimed.
 * EXPLORER_API_URL / EXPLORER_API_KEY override the explorer used for deposits.
 */
import { prisma } from '@sway/db';
import { ROBINHOOD_MAINNET_EXPLORER, swayChain } from '@sway/shared';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { KEYS_ABI, LOCKED, auditWallet, blockscout, sellValue, sum4, totals, type AuditContext, type WalletReport } from '../audit';
import { loadConfig } from '../config';

const cfg = loadConfig();
if (!cfg.contracts.swayKeys) throw new Error('SWAY_KEYS_ADDRESS is not set');
const keys: Address = cfg.contracts.swayKeys;
const pub = createPublicClient({ chain: swayChain({ chainId: cfg.chainId, rpcUrl: cfg.rpcUrl }), transport: http(cfg.rpcUrl) }) as PublicClient;
const explorer = process.env.EXPLORER_API_URL || cfg.explorerUrl || (cfg.chainId === 4663 ? ROBINHOOD_MAINNET_EXPLORER : '');
const lc = (a: string) => a.toLowerCase();
const ZERO = /^0x0{40}$/;
const big = (d: unknown) => BigInt(String(d ?? 0).split('.')[0] || '0');

let ethUsd = Number(process.env.ETH_USD_FALLBACK || 0);
try {
  const r = await fetch(`http://127.0.0.1:${process.env.API_PORT || 4000}/api/price`, { signal: AbortSignal.timeout(4000) });
  if (r.ok) ethUsd = ((await r.json()) as { ethUsd: number }).ethUsd || ethUsd;
} catch {
  /* API not reachable: the fallback price, or ETH only */
}
const eth = (w: bigint) => {
  const e = Number(w) / 1e18;
  const s = `${e < 0 ? '−' : ''}${Math.abs(e).toFixed(6)} ETH`;
  return ethUsd > 0 ? `${s} (${e < 0 ? '−' : ''}$${Math.abs(e * ethUsd).toFixed(2)})` : s;
};
const line = (label: string, w: bigint, note = '') => console.log(`  ${label.padEnd(38)} ${eth(w).padStart(28)}${note ? `  ${note}` : ''}`);
const some = (label: string, w: bigint, note = '') => w !== 0n && line(label, w, note);
const split = (f: { creator: bigint; holder: bigint; referral: bigint; protocol: bigint }) =>
  (['creator', 'holder', 'referral', 'protocol'] as const).filter((k) => f[k]).map((k) => `${k} ${eth(f[k])}`).join(', ');
const keysOf = (units: bigint) => `${Number(units) / 100} key${units === 100n ? '' : 's'}`;

const treasury = lc(await pub.readContract({ address: keys, abi: KEYS_ABI, functionName: 'treasury' }));
const staking = lc(await pub.readContract({ address: keys, abi: KEYS_ABI, functionName: 'staking' }));
const noStaking = ZERO.test(staking);
const operator = cfg.operatorKey ? lc(privateKeyToAccount(cfg.operatorKey).address) : null;

// Who: handles (all their wallets), extra addresses, `operator` / `treasury`, or --all.
const args = process.argv.slice(2);
const owners = new Map<string, string>();
const userIds = new Set<string>();
const memberSelect = { id: true, handle: true, name: true, wallet: { select: { address: true } }, linkedWallets: { select: { address: true } } } as const;
const addMembers = (users: Array<{ id: string; handle: string; wallet: { address: string } | null; linkedWallets: Array<{ address: string }> }>) => {
  for (const u of users) {
    userIds.add(u.id);
    for (const a of [u.wallet?.address, ...u.linkedWallets.map((w) => w.address)]) if (a) owners.set(lc(a), `@${u.handle}`);
  }
};
if (args.includes('--all')) {
  addMembers(await prisma.user.findMany({ select: memberSelect }));
  for (const t of await prisma.trade.findMany({ distinct: ['trader'], select: { trader: true } })) if (!owners.has(lc(t.trader))) owners.set(lc(t.trader), '(not a member)');
} else {
  if (args.includes('treasury')) owners.set(treasury, '(treasury)');
  if (args.includes('operator')) {
    if (operator) owners.set(operator, '(operator)');
    else console.log('! operator: OPERATOR_PRIVATE_KEY is not set');
  }
  for (const h of args.filter((a) => !a.startsWith('0x') && a !== 'operator' && a !== 'treasury').map((x) => x.replace(/^@/, ''))) {
    const u = await prisma.user.findFirst({ where: { handle: { equals: h, mode: 'insensitive' } }, select: memberSelect });
    if (u && (u.wallet || u.linkedWallets.length)) {
      addMembers([u]);
      continue;
    }
    if (u) {
      console.log(`! @${u.handle} has no Sway wallet or linked wallet: add their wallet's 0x address instead`);
      continue;
    }
    const like = await prisma.user.findMany({
      where: { OR: [{ handle: { contains: h, mode: 'insensitive' } }, { name: { contains: h, mode: 'insensitive' } }] },
      select: { handle: true, name: true },
      take: 5,
    });
    console.log(`! @${h}: no member with that handle${like.length ? `; did you mean ${like.map((x) => `@${x.handle} (${x.name})`).join(', ')}?` : ''}`);
  }
  for (const a of args.filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x))) if (!owners.has(lc(a))) owners.set(lc(a), '(extra)');
}
if (!owners.size) {
  console.log('Usage: bash deploy/audit-wallets.sh <handle|0xaddress|operator|treasury>… | --all');
  process.exit(1);
}

const ownMarkets = await prisma.keyMarket.findMany({
  where: { OR: [{ userId: { in: [...userIds] } }, { subject: { in: [...owners.keys()] } }] },
  select: { id: true, subject: true, supplyUnits: true, volumeWei: true, user: { select: { handle: true, wallet: { select: { address: true } } } } },
});
const members = new Map<string, string>();
for (const w of await prisma.wallet.findMany({ select: { address: true, user: { select: { handle: true } } } })) members.set(lc(w.address), `@${w.user.handle}`);
for (const w of await prisma.linkedWallet.findMany({ select: { address: true, user: { select: { handle: true } } } })) members.set(lc(w.address), `@${w.user.handle}`);
const contractNames: Record<string, string> = { fanEscrow: 'FanEscrow', swayStaking: 'SwayStaking', genesisPass: 'GenesisPass', launchpad: 'Launchpad', drops: 'Drops' };
const swayContracts = new Map<string, string>();
for (const [k, v] of Object.entries(cfg.contracts)) if (typeof v === 'string' && /^0x/.test(v) && !ZERO.test(v) && lc(v) !== lc(keys)) swayContracts.set(lc(v), contractNames[k] ?? k);
const progress = (msg: string) => process.stderr.write(`\r  explorer: ${msg}`.slice(0, 100).padEnd(100));
const ctx: AuditContext = {
  prisma,
  pub,
  keys,
  owners,
  ownSubjects: new Set(ownMarkets.map((m) => lc(m.subject))),
  operator,
  swayContracts,
  members,
  txs: explorer ? blockscout(explorer, { apiKey: process.env.EXPLORER_API_KEY ?? '', progress }) : null,
};

console.log(`Sway audit · chain ${cfg.chainId} · ETH $${ethUsd || '?'} · explorer ${explorer || 'none: deposits, withdrawals and gas are skipped'}`);
console.log('\nSWAY’S OWN WALLETS AND CONTRACTS');
const [, , , treasuryFees] = await pub.readContract({ address: keys, abi: KEYS_ABI, functionName: 'claimable', args: [treasury as Address, []] });
line('SwayKeys holds', await pub.getBalance({ address: keys }), `${lc(keys)} (key reserves + unclaimed earnings)`);
line('treasury: ETH in the wallet', await pub.getBalance({ address: treasury as Address }), treasury);
line('treasury: protocol fees to claim', treasuryFees, 'claim([]) from the treasury wallet');
if (!noStaking) {
  const [, , , stakers] = await pub.readContract({ address: keys, abi: KEYS_ABI, functionName: 'claimable', args: [staking as Address, []] });
  line("stakers' fees waiting in SwayKeys", stakers, `${staking} (harvest() pays them to stakers)`);
  some('staking contract holds', await pub.getBalance({ address: staking as Address }), "harvested, not paid out yet");
}
if (operator) {
  line('operator: ETH in the wallet', await pub.getBalance({ address: operator as Address }), `${operator} (pays Sway's own transactions)`);
  const who = members.get(operator);
  if (who) console.log(`  ! the operator is also ${who}'s wallet: Sway's running costs (gas, gas drips) come out of that account`);
}
const drips = await prisma.activity.aggregate({ where: { ref: { startsWith: 'gasdrip:' }, txHash: { not: null } }, _sum: { amountWei: true }, _count: { _all: true } });
line('gas drips sent to new members', big(drips._sum.amountWei), `${drips._count._all} members · GAS_DRIP_WEI=${process.env.GAS_DRIP_WEI || '0'} · SPONSOR_ONBOARDING=${process.env.SPONSOR_ONBOARDING || '0'}`);

const reports: WalletReport[] = [];
for (const a of owners.keys()) {
  reports.push(await auditWallet(ctx, a));
  await new Promise((ok) => setTimeout(ok, 300));
}
if (explorer) process.stderr.write(`\r${' '.repeat(100)}\r`);

let explorerErrorShown = false;
for (const r of reports) {
  console.log(`\n${r.owner} ${r.address}${r.referrer ? ` · referred by ${owners.get(r.referrer) ?? r.referrer}` : ''}`);
  if (r.explorerOk) {
    line('ETH deposited from outside', r.depositsIn);
    some('gas drip from Sway', r.fromOperator);
    some('received from your other wallets', r.fromOwn);
    some('sent to your other wallets', -r.toOwn);
    some('received from other members', r.fromMembers);
    some('sent to other members', -r.toMembers, r.address === operator ? 'gas drips and transfers' : '');
    some('sent out to other addresses', -r.withdrawnOut, 'bridges, exchanges, Pons…');
    some('paid into SwayKeys (buys)', -r.toKeysContract);
    some('paid out by SwayKeys (sells, claims)', r.fromKeysContract);
    some('other Sway contracts (net)', r.fromOtherSway - r.toOtherSway, 'launchpad, staking…');
    some('gas', -r.gas);
    line('ETH in the wallet now', r.balance, r.balance === r.expectedBalance ? 'matches the history' : `the history adds up to ${eth(r.expectedBalance)}: check the explorer`);
    if (r.actions.length) console.log('  what this wallet’s transactions did:');
    for (const x of r.actions.slice(0, 12))
      console.log(`    ${x.action.padEnd(34)} ${String(x.count).padStart(5)} tx · gas ${eth(x.gas)}${x.value ? ` · sent ${eth(x.value)}` : ''}`);
    if (r.actions.length > 12) console.log(`    … and ${r.actions.length - 12} more kinds`);
    if (r.others.length) console.log('  other addresses it sent ETH to or got ETH from:');
    for (const o of r.others.slice(0, 10)) {
      const name = o.address === treasury ? '(treasury)' : (members.get(o.address) ?? '');
      console.log(`    ${o.address} ${name.padEnd(18)} in ${eth(o.in)} · out ${eth(o.out)}`);
    }
    if (r.others.length > 10) console.log(`    … and ${r.others.length - 10} more`);
  } else {
    line('ETH in the wallet now', r.balance);
    if (r.explorerError) {
      console.log(`  deposits skipped: ${explorerErrorShown ? 'explorer failed (see above)' : `explorer failed: ${r.explorerError}`}`);
      explorerErrorShown = true;
    }
  }
  if (r.buys + r.sells) {
    console.log(`  key trades: ${r.buys} buys, ${r.sells} sells`);
    line('paid for buys', -r.paid);
    line('received from sells', r.received);
    line('fees inside those trades', sum4(r.fees), split(r.fees));
    some('  to own markets (creator fee)', r.creatorFeesToOwn);
    some('  to other creators (creator fee)', r.creatorFeesToOthers);
  } else console.log('  key trades: none');
  some('earnings claimed so far', sum4(r.claimed), split(r.claimed));
  line('earnings waiting to be claimed', sum4(r.claimable), split(r.claimable));
  some('keys held, sell value now', r.keysValue);
}

// Who traded the audited members' keys: wallets left out of the audit show here with what they paid and hold.
const outsiders = new Set<string>();
for (const m of ownMarkets) {
  const rows = await prisma.trade.groupBy({ by: ['trader', 'isBuy'], where: { marketId: m.id }, _sum: { totalWei: true }, _count: { _all: true } });
  const holds = await prisma.holding.findMany({ where: { marketId: m.id, units: { gt: 0n } }, select: { address: true, units: true } });
  const by = new Map<string, { buys: number; sells: number; paid: bigint; got: bigint; units: bigint }>();
  const row = (a: string) => by.get(a) ?? by.set(a, { buys: 0, sells: 0, paid: 0n, got: 0n, units: 0n }).get(a)!;
  for (const x of rows) {
    const t = row(lc(x.trader));
    if (x.isBuy) (t.buys += x._count._all), (t.paid += big(x._sum.totalWei));
    else (t.sells += x._count._all), (t.got += big(x._sum.totalWei));
  }
  for (const h of holds) row(lc(h.address)).units = h.units;
  const ownerWallet = lc(m.user.wallet?.address ?? m.subject);
  const list = [...by.entries()].filter(([a, t]) => t.buys + t.sells > 0 || a !== ownerWallet).sort((x, y) => (y[1].paid > x[1].paid ? 1 : -1));
  const names = new Map<string, string>();
  const addrs = list.map(([a]) => a);
  for (const w of await prisma.wallet.findMany({ where: { address: { in: addrs } }, select: { address: true, user: { select: { handle: true } } } })) names.set(lc(w.address), `@${w.user.handle}`);
  for (const w of await prisma.linkedWallet.findMany({ where: { address: { in: addrs } }, select: { address: true, user: { select: { handle: true } } } })) names.set(lc(w.address), `@${w.user.handle} (linked)`);
  console.log(`\nWHO TRADED THE KEY OF @${m.user.handle} (${keysOf(m.supplyUnits)} out, volume ${eth(big(m.volumeWei))})`);
  if (!list.length) console.log('  nobody yet');
  for (const [a, t] of list.slice(0, 30)) {
    const audited = owners.has(a);
    if (!audited) outsiders.add(a);
    const value = sellValue(m.supplyUnits, a === ownerWallet ? t.units - LOCKED : t.units);
    console.log(
      `  ${(names.get(a) ?? 'not a member').padEnd(24)} ${a}${audited ? ' ✓' : '  '} ${t.buys} buys / ${t.sells} sells · paid ${eth(t.paid)} · got ${eth(t.got)}` +
        `${t.units ? ` · holds ${keysOf(t.units)}${value ? ` worth ${eth(value)}` : ''}` : ''}`,
    );
  }
  if (list.length > 30) console.log(`  … and ${list.length - 30} more`);
}
if (outsiders.size) console.log(`\n(✓ = in this audit. Wallets without ✓ that are yours: add their handle or 0x address to count them in.)`);

// One summary per account (all its wallets), then everything together.
const accounts = [...new Set(reports.map((r) => r.owner))];
if (accounts.length > 1) {
  console.log('\nPER ACCOUNT');
  for (const acc of accounts) {
    const a = totals(reports.filter((r) => r.owner === acc));
    console.log(`  ${acc}`);
    if (a.net !== null) {
      line('  in: from outside / other members', a.deposits + a.fromMembers);
      line('  in − out with your other accounts', a.fromOwn - a.toOwn);
      line('  out: to outside / other members', -(a.withdrawals + a.toMembers));
      line('  gas', -a.gas);
    }
    line('  key trades: received − paid', a.received - a.paid);
    line('  earnings claimed', a.claimed);
    line('  now: ETH + to claim + keys', a.balance + a.claimable + a.keysValue);
    if (a.net !== null) line('  result', a.net);
  }
}

const t = totals(reports);
console.log(`\nALL ${reports.length} AUDITED WALLETS TOGETHER (moves between them cancel out)`);
if (t.net !== null) {
  line('ETH deposited from outside', t.deposits);
  some('received from other members', t.fromMembers);
  some('sent to other members', -t.toMembers, owners.has(operator ?? '') ? 'includes gas drips' : '');
  line('sent out to other addresses', -t.withdrawals);
  line('gas', -t.gas);
}
line('key trades: received − paid', t.received - t.paid);
line('fees inside those trades', sum4(t.fees));
line('  creator fees to own markets', t.creatorFeesToOwn, 'come back as creator earnings');
line('  creator fees to other creators', t.creatorFeesToOthers, 'went to other members');
line('  holder fees', t.fees.holder, `these wallets earned ${eth(t.holderRewardsEarned)} in holder rewards`);
line('  protocol fees', t.fees.protocol, `${noStaking ? '' : 'half to stakers, half '}to the treasury${owners.has(treasury) ? ' (audited here)' : ''}`);
line('  referral fees', t.fees.referral, 'half to each side’s referrer, else to the protocol');
line('earnings claimed so far', t.claimed);
line('earnings waiting to be claimed', t.claimable, 'Wallet → Claim on each wallet');
line('ETH in the wallets now', t.balance);
line('keys held, sell value now', t.keysValue);
if (!owners.has(treasury)) line('treasury: protocol fees to claim', treasuryFees, treasury);
if (t.net !== null) line('net result', t.net, 'ETH + claimable + keys now, against everything in minus everything out');
await prisma.$disconnect();
