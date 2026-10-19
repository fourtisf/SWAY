/**
 * End-to-end check of the Phase 1 definition of done against a running local stack
 * (anvil + api + workers, DEV_AUTH=1):
 *   new member connects (dev X sign-in) → wallet linked by signature → key market opened onchain →
 *   another member buys a key (amounts from packages/curve) → indexer mirrors it → room and holder-only
 *   posts unlock → creator sees the trade notification and a claimable fee equal to the quote →
 *   selling the last key re-locks the room → the creator claims earnings onchain.
 *
 *   pnpm --filter @sway/workers e2e:stack        (API_URL defaults to http://localhost:4000)
 */
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { inAntiDumpWindow, quoteWei } from '@sway/curve';
import { swayChain, type MeDTO, type ProfileDTO, type RoomResponse, type WalletDTO, type FeedResponse, type NotificationDTO } from '@sway/shared';
import { swayKeysAbi } from '@sway/shared/abi';

const API = (process.env.API_URL || 'http://localhost:4000') + '/api';
const step = (s: string) => console.log(`✓ ${s}`);
const fail = (s: string): never => {
  throw new Error(s);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Session {
  cookie = '';
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(API + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) if (c.startsWith('sway_sid=')) this.cookie = c.split(';')[0]!;
    const text = await res.text();
    if (!res.ok) fail(`${method} ${path} → ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) fail(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function main() {
  const config = await new Session().call<{ chainId: number; rpcUrl: string; contracts: { swayKeys: Address } }>('GET', '/config');
  const chain = swayChain({ chainId: config.chainId, rpcUrl: config.rpcUrl });
  const pub = createPublicClient({ chain, transport: http(config.rpcUrl), pollingInterval: 250 });
  const keys = config.contracts.swayKeys ?? fail('contracts not configured');
  const tag = Date.now().toString(36).slice(-5);

  async function member(handle: string) {
    const s = new Session();
    const me = await s.call<MeDTO>('POST', '/auth/dev', { handle });
    const key: Hex = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const { message } = await s.call<{ message: string }>('POST', '/wallet/nonce', { address: account.address });
    const signature = await account.signMessage({ message });
    await s.call<MeDTO>('POST', '/wallet/link', { address: account.address, signature, kind: 'embedded' });
    const wallet = createWalletClient({ chain, account, transport: http(config.rpcUrl), pollingInterval: 250 });
    return { s, me, wallet, address: account.address, handle: me.user.handle };
  }

  const creator = await member(`e2ecreator${tag}`);
  step(`@${creator.handle} signed in (score ${creator.me.user.score}) and linked ${creator.address}`);
  await creator.s.call('POST', '/onboarding/market');
  await until('market open', async () => (await creator.s.call<{ market: boolean }>('GET', '/onboarding')).market);
  const supply0 = ((await pub.readContract({ address: keys, abi: swayKeysAbi, functionName: 'markets', args: [creator.address] })) as readonly unknown[])[6] as bigint;
  if (supply0 !== 100n) fail(`expected supply 100 after open, got ${supply0}`);
  step('key market open onchain; first key locked to the creator');

  const fan = await member(`e2efan${tag}`);
  const bal = await until('welcome funds', async () => {
    const b = await pub.getBalance({ address: fan.address });
    return b > 0n ? b : null;
  });
  step(`@${fan.handle} linked a wallet holding ${Number(bal) / 1e18} ETH`);

  const locked = await fan.s.call<RoomResponse>('GET', `/users/${creator.handle}/room`);
  if (locked.access !== 'locked') fail(`room should be locked before buying, got ${locked.access}`);
  const post = await creator.s.call<{ id: string }>('POST', '/posts', { text: `holders only ${tag}`, visibility: 'holders' });
  step('room is locked for a non-holder; creator posted a holders-only post');

  const q = quoteWei(100n, 'buy', 100n);
  if (BigInt(locked.oneKeyTotalWei) !== q.total) fail(`API quote ${locked.oneKeyTotalWei} != curve ${q.total}`);
  const buyHash = await fan.wallet.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'buy', args: [creator.address, 100n], value: q.total, chain, account: fan.wallet.account! });
  const rcpt = await pub.waitForTransactionReceipt({ hash: buyHash });
  if (rcpt.status !== 'success') fail('buy reverted');
  step(`bought 1 key for ${Number(q.total) / 1e18} ETH (curve ${Number(q.base) / 1e18} + 10% fees)`);

  const prof = await until('indexer mirror', async () => {
    const p = await fan.s.call<ProfileDTO>('GET', `/users/${creator.handle}`);
    return p.supplyUnits === '200' ? p : null;
  });
  if (prof.heldUnits !== '100') fail(`expected 100 held units, got ${prof.heldUnits}`);
  step('indexer mirrored the trade: supply 2 keys, the fan holds 1');

  const open = await until('room open', async () => {
    const r = await fan.s.call<RoomResponse>('GET', `/users/${creator.handle}/room`);
    return r.access === 'open' ? r : null;
  });
  await fan.s.call('POST', `/users/${creator.handle}/room`, { text: 'hello from a holder' });
  const feed = await fan.s.call<FeedResponse>('GET', '/feed?tab=latest');
  const seen = feed.posts.find((p) => p.id === post.id);
  if (!seen || seen.locked || !seen.text?.includes(tag)) fail('holder should read the holders-only post');
  const guestFeed = await new Session().call<FeedResponse>('GET', '/feed?tab=latest');
  const guestSees = guestFeed.posts.find((p) => p.id === post.id);
  if (guestSees && (!guestSees.locked || guestSees.text)) fail('guest must not see holder-only text');
  step(`room open (${open.messages.length} messages) and the holders-only post unlocked; guests still locked`);

  const notes = await until('trade notification', async () => {
    const n = await creator.s.call<NotificationDTO[]>('GET', '/notifications?tab=trades');
    return n.length ? n : null;
  });
  const w = await creator.s.call<WalletDTO>('GET', '/wallet');
  if (BigInt(w.earnings.creatorWei) !== q.creatorFee) fail(`creator earnings ${w.earnings.creatorWei} != 6% ${q.creatorFee}`);
  step(`creator notified ("${notes[0]!.body.map((b) => b.t).join('')}") and can claim exactly the 6% fee`);

  // Selling inside 24h of the buy pays the 5% anti-dump fee to holders (here, the creator's locked key).
  const afterBuy = await fan.s.call<ProfileDTO>('GET', `/users/${creator.handle}`);
  if (!inAntiDumpWindow(afterBuy.lastBuyAt?.[fan.address.toLowerCase()])) fail('profile does not report the fan\'s last buy (anti-dump window)');
  const sellQ = quoteWei(200n, 'sell', 100n, { antiDump: true });
  const sellHash = await fan.wallet.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'sell', args: [creator.address, 100n, sellQ.total], chain, account: fan.wallet.account! });
  await pub.waitForTransactionReceipt({ hash: sellHash });
  await until('room re-locked', async () => (await fan.s.call<RoomResponse>('GET', `/users/${creator.handle}/room`)).access === 'locked');
  step(`sold the last key for ${Number(sellQ.total) / 1e18} ETH (5% anti-dump fee to holders); the room is locked again`);

  const before = await pub.getBalance({ address: creator.address });
  const claimHash = await creator.wallet.writeContract({ address: keys, abi: swayKeysAbi, functionName: 'claim', args: [w.earnings.claimSubjects], chain, account: creator.wallet.account! });
  const cr = await pub.waitForTransactionReceipt({ hash: claimHash });
  const gas = cr.gasUsed * cr.effectiveGasPrice;
  const got = (await pub.getBalance({ address: creator.address })) - before + gas;
  const expected = q.creatorFee + sellQ.creatorFee + sellQ.antiDumpFee;
  if (got < expected) fail(`claimed ${got}, expected at least the two creator fees and the anti-dump fee ${expected}`);
  await until('claim mirrored', async () => {
    const ww = await creator.s.call<WalletDTO>('GET', '/wallet');
    return BigInt(ww.earnings.claimedWei) > 0n ? ww : null;
  });
  step(`creator claimed ${Number(got) / 1e18} ETH onchain (both creator fees + holder rewards on the first key, anti-dump fee included)`);
  console.log('\nPhase 1 definition of done: OK');
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
