/** Build-time switches (inlined by Next). */
export const MOCK = process.env.NEXT_PUBLIC_API_MOCK === '1';
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000/ws';
/** Fallback ETH/USD until /api/config answers (prototype ETH_USD). */
export const DEFAULT_ETH_USD = 3420;
