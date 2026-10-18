/**
 * Coinbase CDP embedded wallet adapter (ConfigDTO.wallets.embedded === 'cdp').
 *
 * TODO: wire up the CDP embedded-wallet SDK once project keys exist (EMBEDDED_WALLET_API_KEY). It should
 * return a SwayWallet backed by the CDP account's EIP-1193 provider + viem (same calls as ./burner.ts).
 */
import type { ConfigDTO } from '@sway/shared';
import type { SwayWallet } from './types';

export async function cdpWallet(_userId: string, _config: ConfigDTO): Promise<SwayWallet> {
  throw new Error('Coinbase embedded wallets are not configured yet. Use your own wallet for now.');
}
