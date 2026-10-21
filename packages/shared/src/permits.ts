/**
 * SwayKeys.Member permits (EIP-712). The operator signs them offchain; the buy that first needs one carries it
 * (SwayKeys.registerAndBuy), so joining costs Sway no gas. One definition for the API (signs), web (submits)
 * and workers (tests against the contract).
 */
import type { Address, MemberPermit } from './api';

export const MEMBER_PERMIT_TYPES = {
  Member: [
    { name: 'wallet', type: 'address' },
    { name: 'xId', type: 'uint64' },
    { name: 'referrer', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export const memberPermitDomain = (chainId: number, swayKeys: Address) =>
  ({ name: 'SwayKeys', version: '1', chainId, verifyingContract: swayKeys }) as const;

/** SwayKeys.registerAndBuy's first two arguments. */
export function permitArgs(permits: MemberPermit[]) {
  return [
    permits.map((p) => ({ wallet: p.wallet, xId: BigInt(p.xId), referrer: p.referrer, deadline: BigInt(p.deadline) })),
    permits.map((p) => p.signature),
  ] as const;
}
