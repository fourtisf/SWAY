import { describe, expect, it } from 'vitest';
import { keccak256, concat, type Hex } from 'viem';
import { airdropLeaf, buildAirdrop, buildMerkleTree, verifyMerkleProof } from '../src/merkle';

const addr = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}`;

describe('merkle', () => {
  it('matches the two-leaf tree in SwayLaunchpad.t.sol', () => {
    const a = airdropLeaf(addr(0), 60n);
    const b = airdropLeaf(addr(1), 40n);
    const expected = BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
    const t = buildMerkleTree([a, b]);
    expect(t.root).toBe(expected);
    expect(t.proofs[0]).toEqual([b]);
  });

  it('every proof verifies for odd and even sizes', () => {
    for (const n of [1, 2, 3, 5, 8, 13, 100]) {
      const leaves = Array.from({ length: n }, (_, i) => airdropLeaf(addr(i), BigInt(i + 1)));
      const t = buildMerkleTree(leaves);
      leaves.forEach((l, i) => expect(verifyMerkleProof(t.root, l, t.proofs[i]!)).toBe(true));
      expect(verifyMerkleProof(t.root, airdropLeaf(addr(999), 1n), t.proofs[0]! as Hex[])).toBe(n === 1 ? false : false);
    }
  });

  it('airdrop splits the whole allocation pro rata', () => {
    const total = 100_000_000n * 10n ** 18n + 7n;
    const d = buildAirdrop([{ address: addr(0), units: 300n }, { address: addr(1), units: 100n }, { address: addr(2), units: 0n }], total);
    expect(d.entries).toHaveLength(2);
    expect(d.entries.reduce((s, e) => s + e.amount, 0n)).toBe(total);
    expect(d.entries[0]!.amount / 3n).toBeGreaterThanOrEqual(d.entries[1]!.amount - 1n);
    d.entries.forEach((e) => expect(verifyMerkleProof(d.root, airdropLeaf(e.address, e.amount), e.proof)).toBe(true));
  });
});
