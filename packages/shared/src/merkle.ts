/**
 * Merkle tree for the launchpad's key-holder airdrop, compatible with OpenZeppelin MerkleProof
 * (sorted-pair keccak256) and the leaf SwayLaunchpad.claimAirdrop checks:
 *   leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount))))
 */
import { concat, encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from 'viem';

export function airdropLeaf(account: Address | string, amount: bigint): Hex {
  return keccak256(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [getAddress(account), amount])));
}

const hashPair = (a: Hex, b: Hex): Hex => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

export interface MerkleTree {
  root: Hex;
  /** Proof per input leaf, in input order. */
  proofs: Hex[][];
}

/** Builds the tree over `leaves` (any order). A node without a sibling moves up unchanged. */
export function buildMerkleTree(leaves: Hex[]): MerkleTree {
  if (!leaves.length) throw new Error('empty tree');
  const sorted = [...new Set(leaves)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const layers: Hex[][] = [sorted];
  while (layers[layers.length - 1]!.length > 1) {
    const prev = layers[layers.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i]!, prev[i + 1]!) : prev[i]!);
    layers.push(next);
  }
  const proofOf = (leaf: Hex): Hex[] => {
    const proof: Hex[] = [];
    let idx = sorted.indexOf(leaf);
    for (let l = 0; l < layers.length - 1; l++) {
      const layer = layers[l]!;
      const sib = idx ^ 1;
      if (sib < layer.length) proof.push(layer[sib]!);
      idx = Math.floor(idx / 2);
    }
    return proof;
  };
  return { root: layers[layers.length - 1]![0]!, proofs: leaves.map(proofOf) };
}

export function verifyMerkleProof(root: Hex, leaf: Hex, proof: Hex[]): boolean {
  return proof.reduce((h, p) => hashPair(h, p), leaf).toLowerCase() === root.toLowerCase();
}

export interface AirdropEntry {
  address: Address;
  amount: bigint;
  proof: Hex[];
}

/**
 * Splits `total` across holders pro rata to units (floored); the remainder goes one unit each to the
 * largest holders first. Returns the root and each holder's proof.
 */
export function buildAirdrop(holders: Array<{ address: string; units: bigint }>, total: bigint): { root: Hex; entries: AirdropEntry[] } {
  const live = holders.filter((h) => h.units > 0n);
  const sum = live.reduce((s, h) => s + h.units, 0n);
  if (!live.length || sum === 0n) throw new Error('no holders');
  const rows = live.map((h) => ({ address: getAddress(h.address), amount: (total * h.units) / sum, units: h.units }));
  let left = total - rows.reduce((s, r) => s + r.amount, 0n);
  for (const r of [...rows].sort((a, b) => (b.units > a.units ? 1 : b.units < a.units ? -1 : 0))) {
    if (left === 0n) break;
    r.amount += 1n;
    left -= 1n;
  }
  const leaves = rows.map((r) => airdropLeaf(r.address, r.amount));
  const tree = buildMerkleTree(leaves);
  return { root: tree.root, entries: rows.map((r, i) => ({ address: r.address, amount: r.amount, proof: tree.proofs[i]! })) };
}
