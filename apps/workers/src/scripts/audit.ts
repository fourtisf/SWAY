/**
 * Read-only audit of members' wallets (src/audit.ts): where their ETH came from and went, what their key trades
 * cost, which fees went where, and what is still waiting to be claimed. Sends nothing.
 *
 *   pnpm --filter @sway/workers audit:wallets swaydotfamily _sonic_hub bittez_ [0xExtraWallet …]
 *   pnpm --filter @sway/workers audit:wallets --all
 *
 * Handles take every wallet of that member (account + linked). Every key trade pays 10% in fees (creator 6%,
 * protocol 2%, holders 1%, referral 1%; +5% to holders on a sell within 24h of the seller's last buy), credited in
 * SwayKeys until claimed, so a round trip between your own wallets shows as a loss until those are claimed.
 */
import { prisma } from '@sway/db';
import { ROBINHOOD_MAINNET_EXPLORER, swayChain } from '@sway/shared';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { KEYS_ABI, auditWallet, blockscout, sum4, totals, type AuditContext, type WalletReport } from '../audit';
import { loadConfig } from '../config';

const cfg = loadConfig();
if (!cfg.contracts.swayKeys) throw new Error('SWAY_KEYS_ADDRESS is not set');
const keys: Address = cfg.contracts.swayKeys;
const pub = createPublicClient({ chain: swayChain({ chainId: cfg.chainId, rpcUrl: cfg.rpcUrl }), transport: http(cfg.rpcUrl) }) as PublicClient;
const explorer = cfg.explorerUrl || (cfg.chainId === 4663 ? ROBINHOOD_MAINNET_EXPLORER : '');
const lc = (a: string) => a.toLowerCase();

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

// Who: handles (all their wallets), extra addresses, or --all.
const args = process.argv.slice(2);
const owners = new Map<string, string>();
const addMembers = async (where: object | undefined) => {
  const users = await prisma.user.findMany({ where, select: { handle: true, wallet: { select: { address: true } }, linkedWallets: { select: { address: true } } } });
  for (const u of users) for (const a of [u.wallet?.address, ...u.linkedWallets.map((w) => w.address)]) if (a) owners.set(lc(a), `@${u.handle}`);
};
if (args.includes('--all')) {
  await addMembers(undefined);
  for (const t of await prisma.trade.findMany({ distinct: ['trader'], select: { trader: true } })) if (!owners.has(lc(t.trader))) owners.set(lc(t.trader), '(not a member)');
} else {
  const handles = args.filter((a) => !a.startsWith('0x')).map((h) => h.replace(/^@/, '').toLowerCase());
  if (handles.length) await addMembers({ handle: { in: handles, mode: 'insensitive' } });
  const found = new Set([...owners.values()].map((h) => h.slice(1).toLowerCase()));
  for (const h of handles) if (!found.has(h)) console.log(`! @${h}: no member with that handle, or no wallet yet`);
  for (const a of args.filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x))) if (!owners.has(lc(a))) owners.set(lc(a), '(extra)');
}
if (!owners.size) {
  console.log('Usage: bash deploy/audit-wallets.sh <handle|0xaddress>… | --all');
  process.exit(1);
}

const treasury = lc(await pub.readContract({ address: keys, abi: KEYS_ABI, functionName: 'treasury' }));
const staking = lc(await pub.readContract({ address: keys, abi: KEYS_ABI, functionName: 'staking' }));
const noStaking = /^0x0{40}$/.test(staking);
const ctx: AuditContext = {
  prisma,
  pub,
  keys,
  owners,
  operator: cfg.operatorKey ? lc(privateKeyToAccount(cfg.operatorKey).address) : null,
  swayContracts: new Set(Object.values(cfg.contracts).filter((v): v is Address => typeof v === 'string' && /^0x/.test(v) && lc(v) !== lc(keys)).map(lc)),
  txs: explorer ? blockscout(explorer) : null,
};

console.log(`Sway audit · chain ${cfg.chainId} · SwayKeys ${keys}${ethUsd ? ` · ETH $${ethUsd}` : ''}`);
console.log(`Treasury ${treasury}${owners.has(treasury) ? ' (one of the audited wallets)' : ''} · staking ${noStaking ? 'off' : staking}${explorer ? '' : ' · no explorer: deposits, withdrawals and gas are skipped'}`);
const reports: WalletReport[] = [];
for (const a of owners.keys()) {
  reports.push(await auditWallet(ctx, a));
  await new Promise((ok) => setTimeout(ok, 300));
}

for (const r of reports) {
  console.log(`\n${r.owner} ${r.address}${r.referrer ? ` · referred by ${owners.get(r.referrer) ?? r.referrer}` : ''}`);
  if (r.explorerOk) {
    line('ETH deposited from outside', r.depositsIn);
    some('gas drip from Sway', r.fromOperator);
    some('moved from / to own wallets (net)', r.fromOwn - r.toOwn);
    some('sent out to other addresses', -r.withdrawnOut, 'bridges, exchanges, Pons…');
    some('paid into SwayKeys (buys)', -r.toKeysContract);
    some('paid out by SwayKeys (sells, claims)', r.fromKeysContract);
    some('other Sway contracts (net)', r.fromOtherSway - r.toOtherSway, 'launchpad, staking…');
    some('gas', -r.gas);
    line('ETH in the wallet now', r.balance, r.balance === r.expectedBalance ? 'matches the history' : `the history adds up to ${eth(r.expectedBalance)}: check the explorer`);
    if (r.others.length) console.log('  outside addresses:');
    for (const o of r.others.slice(0, 8)) {
      const name = o.address === treasury ? ' (treasury)' : '';
      console.log(`    ${o.address}${name}  in ${eth(o.in)} · out ${eth(o.out)}`);
    }
    if (r.others.length > 8) console.log(`    … and ${r.others.length - 8} more`);
  } else line('ETH in the wallet now', r.balance, explorer ? '(explorer unreachable: deposits skipped)' : '');
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

const t = totals(reports);
console.log(`\nALL ${reports.length} WALLETS TOGETHER (moves between them cancel out)`);
if (t.net !== null) {
  line('ETH deposited from outside', t.deposits);
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
if (!owners.has(treasury)) {
  const [, , , tp] = await pub.readContract({ address: keys, abi: KEYS_ABI, functionName: 'claimable', args: [treasury as Address, []] });
  line('treasury: protocol fees to claim', tp, treasury);
}
if (t.net !== null) line('net result', t.net, 'ETH + claimable + keys now, against deposits minus withdrawals');
await prisma.$disconnect();
