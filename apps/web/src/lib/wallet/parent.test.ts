import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigDTO, ParentChainDTO } from '@sway/shared';
import { encodeAbiParameters, toFunctionSelector, type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BRIDGE_CHECK_FAILED, SMART_WALLET, assertPlainAccount, checkParentBridge, depositFeeCap } from './parent';

const INBOX = '0x1a07cc4bd17e0118bdb54d70990d2158abad7a2d';
const BRIDGE = '0xdf8755334ce7a73ccf6b581c02ea649ae3e864b3';
const ROLLUP = '0x0000000000000000000000000000000000000c11';
const PLAIN = '0x00000000000000000000000000000000000000a1';
const DELEGATED = '0x00000000000000000000000000000000000000a2';

/** What the fake Ethereum node answers; tests change it. */
const chain = { bridgeOfInbox: BRIDGE as string, allowed: true, rollupChainId: 4663n };
const sel = (sig: string) => toFunctionSelector(sig).slice(2);
const word = (type: 'address' | 'bool' | 'uint256', v: unknown) => encodeAbiParameters([{ type }], [v as never]);

function answer(method: string, params: unknown[]): unknown {
  switch (method) {
    case 'eth_chainId':
      return '0x1';
    case 'eth_call': {
      const { data } = params[0] as { to: string; data: string };
      const to = (params[0] as { to: string }).to.toLowerCase();
      const s = data.slice(2, 10);
      if (to === INBOX && s === sel('bridge()')) return word('address', chain.bridgeOfInbox);
      if (to === BRIDGE && s === sel('allowedDelayedInboxes(address)')) return word('bool', chain.allowed);
      if (to === BRIDGE && s === sel('rollup()')) return word('address', ROLLUP);
      if (to === ROLLUP && s === sel('chainId()')) return word('uint256', chain.rollupChainId);
      return '0x';
    }
    case 'eth_getCode':
      return (params[0] as string).toLowerCase() === DELEGATED ? '0xef0100' + '11'.repeat(20) : '0x';
    case 'eth_estimateGas':
      return '0x186a0'; // 100k
    case 'eth_getBlockByNumber':
      return { baseFeePerGas: '0x3b9aca00', number: '0x1', hash: '0x' + '0'.repeat(64), timestamp: '0x1', transactions: [] };
    case 'eth_maxPriorityFeePerGas':
      return '0x0';
    default:
      throw new Error(method);
  }
}

let server: Server;
let p: ParentChainDTO;
let config: ConfigDTO;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      res.setHeader('content-type', 'application/json');
      try {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: answer(r.method, r.params) }));
      } catch (e) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32601, message: (e as Error).message } }));
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  p = { chainId: 1, name: 'Ethereum', rpcUrl: url, explorerUrl: '', inbox: INBOX, bridge: BRIDGE };
  // The Sway chain's RPC is the same fake node: getCode answers the same on both.
  config = { chainId: 4663, chainName: 'Robinhood Chain', rpcUrl: url, parentChain: p } as ConfigDTO;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

describe('moving ETH from Ethereum', () => {
  it('accepts the Inbox only when its bridge is the expected one, allows it, and belongs to this rollup', async () => {
    await expect(checkParentBridge(p, 4663)).resolves.toBeUndefined();
    // Another chain's rollup: refused (and not cached as good for that chain).
    chain.rollupChainId = 42161n;
    await expect(checkParentBridge(p, 46630)).rejects.toThrow(BRIDGE_CHECK_FAILED);
    chain.rollupChainId = 4663n;
    chain.allowed = false;
    await expect(checkParentBridge({ ...p, name: 'x' }, 4664)).rejects.toThrow(BRIDGE_CHECK_FAILED);
    chain.allowed = true;
    chain.bridgeOfInbox = '0x00000000000000000000000000000000000000b0';
    await expect(checkParentBridge(p, 4665)).rejects.toThrow(BRIDGE_CHECK_FAILED);
    chain.bridgeOfInbox = BRIDGE;
  });

  it('refuses accounts with code (smart wallets, EIP-7702 delegations): the Inbox would credit an alias', async () => {
    await expect(assertPlainAccount(config, PLAIN as Address)).resolves.toBeUndefined();
    await expect(assertPlainAccount(config, DELEGATED as Address)).rejects.toThrow(SMART_WALLET);
  });

  it('keeps twice the estimated network fee back for Max', async () => {
    // 100k gas at a max fee of 1.2 gwei (1 gwei base fee × 1.2, no tip), doubled.
    expect(await depositFeeCap(p, PLAIN as Address)).toBe(100_000n * 1_200_000_000n * 2n);
  });
});
