/**
 * Writes contracts/test/vectors/curve.json: quotes computed by packages/curve that the Foundry suite
 * replays against SwayKeys.sol (CurveVectors.t.sol). Run `pnpm vectors` after changing curve math.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVectors } from '../src/vectors';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/test/vectors/curve.json');
mkdirSync(dirname(out), { recursive: true });
const v = buildVectors();
writeFileSync(out, JSON.stringify(v, null, 1) + '\n');
console.log(`wrote ${v.supply.length} vectors to ${out}`);
