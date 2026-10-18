import { randomUUID } from 'node:crypto';
import type { Account, Chain, Transport, WalletClient } from 'viem';
import type { Clients } from './clients';

/** Same key and release rule as apps/api/src/services/chain.ts: one sender, one nonce sequence. */
export const OPERATOR_LOCK_KEY = 'lock:operator';
const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

type Wallet = WalletClient<Transport, Chain, Account>;

/** The lock that serializes transactions from `wallet` across the API and the workers. */
export function lockKeyFor(c: Clients, wallet: Wallet): string {
  const op = c.operator?.account.address.toLowerCase();
  const me = wallet.account.address.toLowerCase();
  return me === op ? OPERATOR_LOCK_KEY : `lock:sender:${me}`;
}

/** Holds the sender lock from sending until the receipt, so concurrent processes never reuse a nonce. */
export async function withSenderLock<T>(c: Clients, wallet: Wallet, fn: () => Promise<T>, opts: { ttlMs?: number; waitMs?: number } = {}): Promise<T> {
  const key = lockKeyFor(c, wallet);
  const token = randomUUID();
  const deadline = Date.now() + (opts.waitMs ?? 60_000);
  while ((await c.redis.set(key, token, 'PX', opts.ttlMs ?? 90_000, 'NX')) !== 'OK') {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${key}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    return await fn();
  } finally {
    await c.redis.eval(RELEASE_LUA, 1, key, token).catch(() => undefined);
  }
}
