/** Mock-mode wallet: "transactions" mutate the in-memory world, receipts resolve at once. */
import { weiToEth } from '@sway/curve';
import type { Address, Hex } from 'viem';
import { getWorld } from '../mock';
import { fakeHash } from '../mock/seed';
import type { SwayWallet } from './types';

let n = 0;
const txHash = (s: string): Hex => fakeHash(`${s}:${Date.now()}:${++n}`);

export function mockWallet(address: Address): SwayWallet {
  const w = getWorld();
  return {
    address,
    kind: 'embedded',
    async signMessage(msg) {
      return fakeHash('sig:' + msg);
    },
    async buy(subject, units) {
      const c = w.bySubject(subject);
      if (!c) throw new Error('Market not found');
      w.execTrade(c.handle, 'buy', units);
      return txHash('buy');
    },
    async sell(subject, units) {
      const c = w.bySubject(subject);
      if (!c) throw new Error('Market not found');
      w.execTrade(c.handle, 'sell', units);
      return txHash('sell');
    },
    async claim() {
      const v = w.claimable();
      if (v <= 0) throw new Error('Nothing to claim');
      w.eth += v;
      w.claimed += v;
      w.earned = { creator: 0, holder: 0, ref: 0 };
      const h = txHash('claim');
      w.log('Claimed earnings', v, h);
      return h;
    },
    async sendEth(to, wei) {
      const eth = weiToEth(wei);
      if (eth > w.eth + 1e-12) throw new Error('Not enough balance');
      w.eth -= eth;
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
