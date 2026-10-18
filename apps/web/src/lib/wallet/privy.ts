/**
 * Privy embedded wallet adapter (ConfigDTO.wallets.embedded === 'privy').
 *
 * TODO: wire up @privy-io/react-auth once the Privy app id/keys exist (EMBEDDED_WALLET_API_KEY).
 * Create the embedded wallet at X sign-in, then implement SwayWallet with Privy's EIP-1193 provider
 * wrapped in a viem wallet client (same calls as ./burner.ts). Not installed yet: keys aren't available.
 */
import type { ConfigDTO } from '@sway/shared';
import type { SwayWallet } from './types';

export async function privyWallet(_userId: string, _config: ConfigDTO): Promise<SwayWallet> {
  throw new Error('Privy embedded wallets are not configured yet. Use your own wallet for now.');
}
