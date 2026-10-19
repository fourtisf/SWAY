/**
 * Mock-mode wallet: "transactions" mutate the in-memory world, receipts resolve at once. Each address trades,
 * claims and pays from its own balance (the account wallet or one of the member's linked wallets).
 */
import { weiToEth } from '@sway/curve';
import type { Address, Hex } from 'viem';
import { getWorld } from '../mock';
import { fakeHash } from '../mock/seed';
import type { SwayWallet } from './types';

let n = 0;
const txHash = (s: string): Hex => fakeHash(`${s}:${Date.now()}:${++n}`);

/** The Sway-wallet "private key" mock mode shows in Back up (deterministic, never a real key). */
export const mockPrivateKey = (address: string): Hex => fakeHash('pk:' + address.toLowerCase());

export function mockWallet(address: Address, kind: 'embedded' | 'external' = 'embedded'): SwayWallet {
  const w = getWorld();
  const linked = () => w.linkedOf(address);
  return {
    address,
    kind,
    async signMessage(msg) {
      return fakeHash('sig:' + address + msg);
    },
    async buy(subject, units) {
      const c = w.bySubject(subject);
      if (!c) throw new Error('Market not found');
      w.execTrade(c.handle, 'buy', units, address);
      return txHash('buy');
    },
    async sell(subject, units) {
      const c = w.bySubject(subject);
      if (!c) throw new Error('Market not found');
      w.execTrade(c.handle, 'sell', units, address);
      return txHash('sell');
    },
    async claim() {
      const l = linked();
      const v = l ? l.earnedHolder : w.earned.creator + w.earned.holder + w.earned.ref;
      if (v <= 0) throw new Error('Nothing to claim');
      if (l) {
        l.eth += v;
        l.claimed += v;
        l.earnedHolder = 0;
      } else {
        w.eth += v;
        w.claimed += v;
        w.earned = { creator: 0, holder: 0, ref: 0 };
      }
      const h = txHash('claim');
      w.log('Claimed earnings', v, h);
      return h;
    },
    async sendEth(to, wei) {
      const eth = weiToEth(wei);
      const l = linked();
      if (eth > (l ? l.eth : w.eth) + 1e-12) throw new Error('Not enough balance');
      if (l) l.eth -= eth;
      else w.eth -= eth;
      const h = txHash('send');
      w.txs.set(h, { to, eth });
      return h;
    },
    async writeContract(call) {
      // Mock-mode handlers for non-SwayKeys contracts register on the world (see lib/mock).
      const h = w.mockContractWrite?.(call);
      if (!h) throw new Error(`${call.functionName} isn't available in mock mode`);
      return h;
    },
    async waitForReceipt() {
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}
