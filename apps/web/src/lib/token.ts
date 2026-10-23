/**
 * How the site names the Sway token. The ticker stays off the site until launch: set NEXT_PUBLIC_SWAY_TICKER
 * (e.g. SWAY) and rebuild the web to show it.
 */
const TICKER = (process.env.NEXT_PUBLIC_SWAY_TICKER ?? '').trim().replace(/^\$/, '').toUpperCase();

export const TOKEN = TICKER
  ? { name: `$${TICKER}`, the: `$${TICKER}`, The: `$${TICKER}`, unit: `$${TICKER}` }
  : { name: 'Sway token', the: 'the Sway token', The: 'The Sway token', unit: 'tokens' };
