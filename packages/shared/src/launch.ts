/**
 * SwayLaunchpad constants and its virtual constant-product curve, ported with the contract's bigint rounding
 * so previews, minimum-out amounts and mock mode match quoteBuy / quoteSell / marketCap to the wei.
 * Launch terms are placeholders until the contract is audited (docs/BUILD_NOTES.md).
 */
import type { Address } from './api';

const E18 = 10n ** 18n;
export const LAUNCH_TOTAL_SUPPLY = 1_000_000_000n * E18;
/** 10% airdropped to the creator's key holders (SwayLaunchpad.HOLDER_ALLOCATION). */
export const LAUNCH_HOLDER_ALLOCATION = 100_000_000n * E18;
export const LAUNCH_CURVE_SUPPLY = LAUNCH_TOTAL_SUPPLY - LAUNCH_HOLDER_ALLOCATION;
export const LAUNCH_CREATOR_FEE_BPS = 100n;
const BPS = 10_000n;

/** Start cap = $2,000 + score × $60 (prototype); graduation at $69K. */
export const LAUNCH_START_USD_BASE = 2000;
export const LAUNCH_START_USD_PER_SCORE = 60;
export const LAUNCH_GRADUATION_USD = 69_000;
/** How long an operator attestation stays valid. */
export const LAUNCH_ATTEST_TTL_S = 30 * 60;
/** Default slippage for token buys and sells (1%). */
export const LAUNCH_SLIPPAGE_BPS = 100n;

export const launchStartCapUsd = (score: number): number =>
  LAUNCH_START_USD_BASE + score * LAUNCH_START_USD_PER_SCORE;

/** Tickers are written without the "$": 2 to 10 letters or digits. */
export const LAUNCH_SYMBOL_RE = /^[A-Z0-9]{2,10}$/;
export const LAUNCH_NAME_MAX = 32;
/** Only the official account can launch these, so no creator token passes for the protocol's own. */
export const RESERVED_SYMBOLS: readonly string[] = ['SWAY'];

/** What the creator typed, as a ticker: "$sway " → "SWAY". */
export const normalizeSymbol = (s: string): string => s.trim().replace(/^\$/, '').toUpperCase();

/** Why a ticker can't be used, or null. */
export function symbolProblem(symbol: string, official = false): string | null {
  if (!LAUNCH_SYMBOL_RE.test(symbol)) return 'Use 2 to 10 letters or digits.';
  if (!official && RESERVED_SYMBOLS.includes(symbol)) return 'That ticker is reserved for Sway.';
  return null;
}

/** Why a token name can't be used, or null. */
export function tokenNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give your token a name.';
  if (n.length > LAUNCH_NAME_MAX) return `Keep the name under ${LAUNCH_NAME_MAX + 1} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(n)) return 'The name can’t contain control characters.';
  return null;
}

/**
 * The suggested ticker, which the creator can change at launch: their display name when it makes one ("Sway" →
 * SWAY), else the first ten letters and digits of their handle.
 */
export function launchSymbol(handle: string, name = '', official = false): string {
  const clean = (s: string) => s.replace(/[^a-z0-9]/gi, '').toUpperCase();
  for (const s of [clean(name), clean(handle).slice(0, 10)]) if (!symbolProblem(s, official)) return s;
  return 'TOKEN';
}

export interface LaunchCurveState {
  virtualEth: bigint;
  ethReserve: bigint;
  tokenReserve: bigint;
  /** When set, a buy stops at this market cap (the rest is refunded), as SwayLaunchpad does. */
  graduationCapWei?: bigint;
}

const divUp = (a: bigint, b: bigint): bigint => (a === 0n ? 0n : (a - 1n) / b + 1n);

/** floor(sqrt(n)), as OpenZeppelin's Math.sqrt. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** virtualEth set at launch: price0 = virtualEth / CURVE_SUPPLY and market cap = price × TOTAL_SUPPLY. */
export const launchVirtualEth = (startCapWei: bigint): bigint =>
  (startCapWei * LAUNCH_CURVE_SUPPLY) / LAUNCH_TOTAL_SUPPLY;

export const launchInitialCurve = (startCapWei: bigint): LaunchCurveState => ({
  virtualEth: launchVirtualEth(startCapWei),
  ethReserve: 0n,
  tokenReserve: LAUNCH_CURVE_SUPPLY,
});

/** SwayLaunchpad.marketCap: spot market cap in wei. */
export const launchMarketCap = (c: LaunchCurveState): bigint =>
  c.tokenReserve === 0n ? 0n : ((c.virtualEth + c.ethReserve) * LAUNCH_TOTAL_SUPPLY) / c.tokenReserve;

/** Spot price in wei per whole token (1e18 token units). */
export const launchPriceWei = (c: LaunchCurveState): bigint =>
  c.tokenReserve === 0n ? 0n : ((c.virtualEth + c.ethReserve) * E18) / c.tokenReserve;

/**
 * SwayLaunchpad.quoteBuy: tokens out (rounded against the buyer), the 1% creator fee and the ETH spent. With the
 * curve's graduation cap set, a buy that would pass it spends only what reaches it (`graduates`); the rest of
 * `ethIn` is refunded.
 */
export function launchQuoteBuy(
  c: LaunchCurveState,
  ethIn: bigint,
): { tokensOut: bigint; fee: bigint; spent: bigint; graduates: boolean } {
  const x = c.virtualEth + c.ethReserve;
  const y = c.tokenReserve;
  let spent = ethIn;
  let fee = (ethIn * LAUNCH_CREATOR_FEE_BPS) / BPS;
  let net = ethIn - fee;
  let graduates = false;
  if (c.graduationCapWei) {
    const xCap = isqrt((c.graduationCapWei * x * y) / LAUNCH_TOTAL_SUPPLY) + 1n;
    if (x + net > xCap) {
      graduates = true;
      net = xCap - x;
      spent = divUp(net * BPS, BPS - LAUNCH_CREATOR_FEE_BPS);
      fee = spent - net;
    }
  }
  return { tokensOut: y - divUp(x * y, x + net), fee, spent, graduates };
}

/** SwayLaunchpad.quoteSell: ETH out after the 1% creator fee; never more than the real reserve. */
export function launchQuoteSell(c: LaunchCurveState, tokensIn: bigint): { ethOut: bigint; fee: bigint } {
  const x = c.virtualEth + c.ethReserve;
  const y = c.tokenReserve;
  let gross = x - divUp(x * y, y + tokensIn);
  if (gross > c.ethReserve) gross = c.ethReserve;
  const fee = (gross * LAUNCH_CREATOR_FEE_BPS) / BPS;
  return { ethOut: gross - fee, fee };
}

/** Minimum out with the default 1% slippage. */
export const launchMinOut = (amount: bigint, slippageBps = LAUNCH_SLIPPAGE_BPS): bigint =>
  (amount * (BPS - slippageBps)) / BPS;

/** Graduation progress 0..1 from start cap to graduation cap. */
export function launchProgress(marketCapWei: bigint, startCapWei: bigint, graduationCapWei: bigint): number {
  if (graduationCapWei <= startCapWei) return 1;
  const p =
    Number(((marketCapWei - startCapWei) * 1_000_000n) / (graduationCapWei - startCapWei)) / 1_000_000;
  return Math.max(0, Math.min(1, p));
}

/** EIP-712 domain and struct the operator signs and SwayLaunchpad.launch verifies. */
export const launchDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: 'SwayLaunchpad', version: '1', chainId, verifyingContract }) as const;

export const LAUNCH_TYPES = {
  Launch: [
    { name: 'creator', type: 'address' },
    { name: 'name', type: 'string' },
    { name: 'symbol', type: 'string' },
    { name: 'startCapWei', type: 'uint256' },
    { name: 'graduationCapWei', type: 'uint256' },
    { name: 'airdropRoot', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/** SwayStaking.COOLDOWN. */
export const STAKING_COOLDOWN_S = 7 * 24 * 3600;
/** Dev faucet: $SWAY sent with each local-chain deposit. */
export const DEV_FAUCET_SWAY = 10_000n * E18;
/** Deploy.s.sol's placeholder level thresholds (1K / 10K / 50K / 250K $SWAY), shown when the chain is unreachable. */
export const STAKING_DEFAULT_THRESHOLDS: readonly bigint[] = [
  1_000n * E18,
  10_000n * E18,
  50_000n * E18,
  250_000n * E18,
];
