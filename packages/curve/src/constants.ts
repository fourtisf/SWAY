/**
 * Curve and fee parameters. These are the values in the prototype's `CURVE` object and in
 * contracts/src/SwayKeys.sol. Changing one here without changing the contract breaks the
 * differential test in contracts/test/CurveVectors.t.sol.
 */

/** Price coefficient K = 0.0000175 ETH, in wei. */
export const K_WEI = 17_500_000_000_000n;
/** Curve offset O = 2 keys. */
export const OFFSET_KEYS = 2;
/** 1 key = 100 units; the minimum trade is 1 unit (0.01 key). */
export const UNITS_PER_KEY = 100n;
/** O expressed in units. */
export const OFFSET_UNITS = 200n;
/** 3 * UNITS_PER_KEY^3, the divisor of the cumulative-cost function in units. */
export const CUBE_DIV = 3_000_000n;
/** UNITS_PER_KEY^2, the divisor of the price function in units. */
export const SQUARE_DIV = 10_000n;
/** The creator's first key, minted at market open and never sellable. */
export const LOCKED_UNITS = 100n;
export const MIN_TRADE_UNITS = 1n;

export const BPS = 10_000n;
export const CREATOR_FEE_BPS = 600n;
export const PROTOCOL_FEE_BPS = 200n;
export const HOLDER_FEE_BPS = 100n;
export const REFERRAL_FEE_BPS = 100n;

/** Protocol-fee cut by staking level 0..4: 0%, −10%, −25%, −50%, −75%. */
export const LEVEL_CUT_BPS = [0n, 1_000n, 2_500n, 5_000n, 7_500n] as const;

/** Anti-snipe: max 10 keys per wallet for the first 5 minutes after a market's first trade. */
export const SNIPE_MAX_UNITS = 1_000n;
export const SNIPE_WINDOW_SECONDS = 300;

/** Fixed-point precision of the holder-reward accumulator (reward per unit). */
export const ACC_PRECISION = 10n ** 18n;

export const WEI_PER_ETH = 10n ** 18n;

/** Float view of the same parameters, exactly as the prototype's `CURVE` object. */
export const CURVE = {
  K: 0.0000175,
  O: 2,
  MIN: 0.01,
  CREATOR: 0.06,
  PROTOCOL: 0.02,
  HOLDERS: 0.01,
  REF: 0.01,
  SNIPE_MAX: 10,
} as const;

export const FEE_TOTAL = CURVE.CREATOR + CURVE.PROTOCOL + CURVE.HOLDERS + CURVE.REF;

/** Staking level cut as a fraction (prototype's `S.levelCut`). */
export const LEVEL_CUT = [0, 0.1, 0.25, 0.5, 0.75] as const;
