/**
 * Turns what the operator wallet still holds on Sway into ETH in that wallet (src/sweep.ts), asking before each
 * transaction, then lists what other accounts still have to collect and sends their wallets a little gas so they
 * can do it from the app (their keys live in the browser, not here).
 *
 *   bash deploy/sweep.sh [handle|0xaddress …]
 *   bash deploy/sweep.sh --key      empties a wallet whose private key you type (hidden, never saved), such as a
 *                                   member's Sway wallet backed up from the app, into the operator wallet
 */
import { prisma } from '@sway/db';
import { swayChain } from '@sway/shared';
import { swayLaunchpadAbi } from '@sway/shared/abi';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createPublicClient, createWalletClient, erc20Abi, http, type Address, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../config';
import { sweep } from '../sweep';

const cfg = loadConfig();
if (!cfg.contracts.swayKeys) throw new Error('SWAY_KEYS_ADDRESS is not set');
if (!cfg.operatorKey) throw new Error('OPERATOR_PRIVATE_KEY is not set');
const chain = swayChain({ chainId: cfg.chainId, rpcUrl: cfg.rpcUrl });
const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient;
const account = privateKeyToAccount(cfg.operatorKey);
const wallet = createWalletClient({ chain, account, transport: http(cfg.rpcUrl) });
const me = account.address.toLowerCase();
const lc = (a: string) => a.toLowerCase();

let ethUsd = Number(process.env.ETH_USD_FALLBACK || 0);
try {
  const r = await fetch(`http://127.0.0.1:${process.env.API_PORT || 4000}/api/price`, { signal: AbortSignal.timeout(4000) });
  if (r.ok) ethUsd = ((await r.json()) as { ethUsd: number }).ethUsd || ethUsd;
} catch {
  /* ETH only */
}
const eth = (w: bigint) => `${(Number(w) / 1e18).toFixed(6)} ETH${ethUsd ? ` ($${((Number(w) / 1e18) * ethUsd).toFixed(2)})` : ''}`;
// A private key is read without echoing it: readline writes through this stream, muted while it's typed or pasted.
let muted = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk, encoding);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
const confirm = async (q: string) => (await rl.question(`${q} Type yes: `)).trim() === 'yes';
const askHidden = async (q: string) => {
  process.stdout.write(q);
  muted = true;
  const a = await rl.question('');
  muted = false;
  process.stdout.write('\n');
  return a.replace(/\s+/g, '');
};

if (process.argv.includes('--key')) {
  // Empty a wallet whose key is typed here (a member's backed-up Sway wallet) into the operator wallet.
  const raw = await askHidden('Private key of the wallet to empty (hidden, never saved): ');
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
    console.log('That isn’t a private key (64 hex characters). Nothing was sent.');
    process.exit(1);
  }
  const theirs = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`);
  const from = lc(theirs.address) as Address;
  const who =
    (await prisma.wallet.findUnique({ where: { address: from }, select: { user: { select: { handle: true } } } }))?.user.handle ??
    (await prisma.linkedWallet.findUnique({ where: { address: from }, select: { user: { select: { handle: true } } } }))?.user.handle;
  console.log(`Wallet ${from}${who ? ` (@${who})` : ''}: ${eth(await pub.getBalance({ address: from }))}`);
  if (from === me) {
    console.log('That is the operator wallet itself: run it without --key.');
    process.exit(1);
  }
  const theirWallet = createWalletClient({ chain, account: theirs, transport: http(cfg.rpcUrl) });
  // It pays its own gas: top it up from the operator when it's nearly empty.
  const gasPrice = await pub.getGasPrice();
  const gas = gasPrice * 4_500_000n > 30_000_000_000_000n ? gasPrice * 4_500_000n : 30_000_000_000_000n;
  const has = await pub.getBalance({ address: from });
  if (has < gas && (await confirm(`It needs gas: send it ${eth(gas - has)} from the operator wallet?`))) {
    await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: from, value: gas - has }) });
    console.log('  sent');
  }
  const done = await sweep({ prisma, pub, wallet: theirWallet, keys: cfg.contracts.swayKeys, launchpad: cfg.contracts.launchpad, confirm, log: (m) => console.log(`  ${m}`), eth });
  // Everything but this transfer's gas goes to the operator wallet.
  const [balance, price] = await Promise.all([pub.getBalance({ address: from }), pub.getGasPrice()]);
  const keep = price * 900_000n > 10_000_000_000_000n ? price * 900_000n : 10_000_000_000_000n;
  if (balance > keep && (await confirm(`Send ${eth(balance - keep)} from ${from} to the operator wallet ${me}?`))) {
    const r = await pub.waitForTransactionReceipt({ hash: await theirWallet.sendTransaction({ to: me as Address, value: balance - keep }) });
    console.log(`  sent (${r.transactionHash})`);
  }
  console.log(
    `\nDone: tokens sold ${eth(done.soldTokens)}, keys sold ${eth(done.soldKeys)}, earnings ${eth(done.claimedKeys)}, creator fees ${eth(done.creatorFees)}, ${done.airdrops} airdrops claimed.` +
      `\nOperator ${me}: ${eth(await pub.getBalance({ address: me as Address }))}`,
  );
  rl.close();
  await prisma.$disconnect();
  process.exit(0);
}

// Other accounts: their wallets get gas, and their leftovers are listed for the app.
const others: Array<{ address: Address; label: string }> = [];
for (const a of process.argv.slice(2).filter((x) => !x.startsWith('--'))) {
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) others.push({ address: lc(a) as Address, label: '(address)' });
  else {
    const u = await prisma.user.findFirst({
      where: { handle: { equals: a.replace(/^@/, ''), mode: 'insensitive' } },
      select: { handle: true, wallet: { select: { address: true } }, linkedWallets: { select: { address: true } } },
    });
    if (!u) console.log(`! @${a}: no member with that handle`);
    for (const w of [u?.wallet?.address, ...(u?.linkedWallets.map((l) => l.address) ?? [])]) if (w) others.push({ address: lc(w) as Address, label: `@${u!.handle}` });
  }
}
const targets = others.filter((o) => o.address !== me);

console.log(`Operator ${me}: ${eth(await pub.getBalance({ address: me as Address }))}`);
// Enough for a few transactions each (claims, approve, sell, withdraw), at least 0.00003 ETH.
const gasPrice = await pub.getGasPrice();
const gas = gasPrice * 4_500_000n > 30_000_000_000_000n ? gasPrice * 4_500_000n : 30_000_000_000_000n;
const done = await sweep(
  { prisma, pub, wallet, keys: cfg.contracts.swayKeys, launchpad: cfg.contracts.launchpad, confirm, log: (m) => console.log(`  ${m}`), eth },
  targets.map((t) => ({ ...t, wei: gas })),
);
console.log(
  `\nOperator ${me}: ${eth(await pub.getBalance({ address: me as Address }))}` +
    ` (keys sold ${eth(done.soldKeys)}, earnings ${eth(done.claimedKeys)}, creator fees ${eth(done.creatorFees)}, tokens sold ${eth(done.soldTokens)}, ${done.airdrops} airdrops claimed)`,
);

// What the other accounts still have to collect themselves, in the Sway app signed in as them.
const pad = cfg.contracts.launchpad;
if (targets.length && pad) {
  const tokens = await prisma.launchToken.findMany({ where: { tokenAddress: { not: null }, graduated: false }, select: { symbol: true, tokenAddress: true, user: { select: { handle: true } } } });
  for (const t of targets) {
    const todo: string[] = [];
    const fees = (await pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'creatorFees', args: [t.address] })) as bigint;
    if (fees > 0n) todo.push(`claim ${eth(fees)} of creator fees on your token's page`);
    for (const d of await prisma.launchAirdrop.findMany({ where: { address: t.address }, include: { launchToken: { select: { symbol: true, tokenAddress: true } } } })) {
      const token = d.launchToken.tokenAddress as Address | null;
      if (token && !(await pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'airdropClaimed', args: [token, t.address] })))
        todo.push(`claim the $${d.launchToken.symbol} airdrop (Wallet page)`);
    }
    for (const k of tokens) {
      const bal = await pub.readContract({ address: k.tokenAddress as Address, abi: erc20Abi, functionName: 'balanceOf', args: [t.address] });
      if (bal === 0n) continue;
      const [out] = (await pub.readContract({ address: pad, abi: swayLaunchpadAbi, functionName: 'quoteSell', args: [k.tokenAddress as Address, bal] })) as readonly bigint[];
      todo.push(`sell ${(Number(bal) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0 })} $${k.symbol} for ${eth(out ?? 0n)} (@${k.user.handle}'s token page → Sell)`);
    }
    const bal = await pub.getBalance({ address: t.address });
    console.log(`\n${t.label} ${t.address}: ${eth(bal)}`);
    for (const x of todo) console.log(`  - ${x}`);
    console.log(`  - then Wallet → Withdraw everything to ${me}`);
  }
}
rl.close();
await prisma.$disconnect();
