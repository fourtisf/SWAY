import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { swayChain } from '@sway/shared';

/** anvil's well-known dev keys (#0 deploys and operates). Local chains only. */
export const KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
];

export interface TestChain {
  rpcUrl: string;
  chainId: number;
  proc: ChildProcess;
  deployment: Record<string, string | number>;
  pub: ReturnType<typeof createPublicClient>;
  test: ReturnType<typeof createTestClient>;
  wallet(i: number): ReturnType<typeof createWalletClient> & { address: Address };
  stop(): void;
}

export async function startChain(port = 8547, chainId = 31338): Promise<TestChain> {
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc = spawn('anvil', ['--port', String(port), '--chain-id', String(chainId), '--silent'], { stdio: 'ignore' });
  const chain = swayChain({ chainId, rpcUrl });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const contracts = resolve(__dirname, '../../../contracts');
  execSync(`forge script script/Deploy.s.sol:Deploy --rpc-url ${rpcUrl} --private-key ${KEYS[0]} --broadcast`, { cwd: contracts, stdio: 'pipe' });
  const deployment = JSON.parse(readFileSync(resolve(contracts, `deployments/${chainId}.json`), 'utf8'));
  const test = createTestClient({ chain, mode: 'anvil', transport: http(rpcUrl) });
  return {
    rpcUrl,
    chainId,
    proc,
    deployment,
    pub,
    test,
    wallet(i) {
      const account = privateKeyToAccount(KEYS[i]!);
      return Object.assign(createWalletClient({ chain, account, transport: http(rpcUrl) }), { address: account.address });
    },
    stop() {
      proc.kill();
    },
  };
}
