/** The explorer client behind the wallet audit, against a stand-in Blockscout. */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockscout } from '../src/audit';

const A = '0x00000000000000000000000000000000000000aa';
let server: Server;
let base = '';
let mode: 'v1' | 'v2' | 'empty' | 'down' = 'v1';
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    hits.push(u.pathname + u.search);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (mode === 'down') {
      res.writeHead(u.pathname === '/api' ? 200 : 404, { 'content-type': 'text/html' });
      return res.end('<html><title>Just a moment...</title></html>');
    }
    if (u.pathname === '/api') {
      if (mode === 'empty') return json(200, { status: '0', message: 'No transactions found', result: [] });
      if (mode === 'v2') return json(200, { status: '0', message: 'NOTOK', result: 'Max rate limit reached' });
      const internal = u.searchParams.get('action') === 'txlistinternal';
      return json(200, { status: '1', message: 'OK', result: internal ? [{ from: '0xkeys', to: A, value: '5', isError: '0' }] : [{ from: A, to: '0xkeys', value: '7', gasUsed: '2', gasPrice: '3', isError: '0' }] });
    }
    if (u.pathname === `/api/v2/addresses/${A}/transactions`) {
      if (!u.searchParams.get('block_number'))
        return json(200, { items: [{ from: { hash: A }, to: { hash: '0xkeys' }, value: '7', fee: { value: '9' }, status: 'ok', method: 'buy', raw_input: '0xcce7ec13' }], next_page_params: { block_number: 10, index: 1 } });
      return json(200, { items: [{ from: { hash: '0xbridge' }, to: { hash: A }, value: '100', fee: { value: '0' }, status: 'ok', method: null, raw_input: '0x' }, { from: { hash: A }, to: { hash: '0xkeys' }, value: '3', fee: { value: '1' }, status: 'error', method: '0xcce7ec13' }], next_page_params: null });
    }
    if (u.pathname === `/api/v2/addresses/${A}/internal-transactions`) return json(200, { items: [{ from: { hash: '0xkeys' }, to: { hash: A }, value: '5', success: true }], next_page_params: null });
    json(404, { message: 'Not found' });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => server.close());

describe('explorer client', () => {
  it('reads the etherscan-style account API', async () => {
    mode = 'v1';
    const h = await blockscout(base, { retryMs: 1 })(A);
    expect(h).toEqual({
      normal: [{ from: A, to: '0xkeys', value: '7', gasUsed: '2', gasPrice: '3', isError: '0' }],
      internal: [{ from: '0xkeys', to: A, value: '5', isError: '0' }],
    });
  });

  it('treats "No transactions found" as an empty history', async () => {
    mode = 'empty';
    expect(await blockscout(base, { retryMs: 1 })(A)).toEqual({ normal: [], internal: [] });
  });

  it('falls back to the v2 API when the account API refuses, following its pages', async () => {
    mode = 'v2';
    hits.length = 0;
    const h = await blockscout(base, { apiKey: 'k', retryMs: 1 })(A);
    expect(h).toEqual({
      normal: [
        { from: A, to: '0xkeys', value: '7', fee: '9', isError: '0', input: '0xcce7ec13', method: 'buy' },
        { from: '0xbridge', to: A, value: '100', fee: '0', isError: '0', input: '0x', method: null },
        { from: A, to: '0xkeys', value: '3', fee: '1', isError: '1', input: undefined, method: '0xcce7ec13' },
      ],
      internal: [{ from: '0xkeys', to: A, value: '5', fee: undefined, isError: '0' }],
    });
    expect(hits).toContain(`/api/v2/addresses/${A}/transactions?block_number=10&index=1&apikey=k`);
  });

  it('says why when neither API answers', async () => {
    mode = 'down';
    const src = blockscout(base, { retryMs: 1 });
    const h = await src(A);
    expect('error' in h && h.error).toMatch(/\/api → not JSON: <html><title>Just a moment.*\/api\/v2 → HTTP 404/);
    // The next address doesn't wait out the retries again.
    hits.length = 0;
    expect(await src(A)).toEqual(h);
    expect(hits).toEqual([]);
  });
});
