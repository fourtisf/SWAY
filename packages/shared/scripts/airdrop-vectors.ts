/**
 * Writes contracts/test/vectors/airdrop.json: a 7-holder airdrop built by packages/shared/src/merkle.ts,
 * which AirdropVectors.t.sol claims leaf by leaf through SwayLaunchpad. Run `pnpm vectors`.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAirdrop } from '../src/merkle';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/test/vectors/airdrop.json');
const holders = [500n, 300n, 120n, 77n, 3n, 1n, 1n].map((units, i) => ({ address: `0x${(0xa11ce0 + i).toString(16).padStart(40, '0')}`, units }));
const d = buildAirdrop(holders, 100_000_000n * 10n ** 18n);
writeFileSync(
  out,
  JSON.stringify({ root: d.root, accounts: d.entries.map((e) => e.address), amounts: d.entries.map((e) => e.amount.toString()), proofs: d.entries.map((e) => e.proof) }, null, 1) + '\n',
);
console.log(`wrote ${d.entries.length} airdrop leaves to ${out}`);
