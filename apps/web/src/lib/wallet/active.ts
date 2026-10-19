/**
 * The active wallet: the one every SwayWallet call goes through (trades, tips, claims, deposits). The choice is
 * kept per member in this browser's localStorage; when it isn't usable here we fall back to the first usable
 * wallet (account first).
 */
import { create } from 'zustand';

const key = (userId: string) => `sway.activeWallet.${userId}`;

function read(userId: string): string | null {
  try {
    return localStorage.getItem(key(userId));
  } catch {
    return null;
  }
}

export const useActiveChoice = create<{ byUser: Record<string, string | null> }>(() => ({ byUser: {} }));

/** The stored choice for a member (lowercase address or null). */
export function activeChoice(userId: string): string | null {
  const s = useActiveChoice.getState().byUser;
  if (userId in s) return s[userId] ?? null;
  const v = read(userId);
  useActiveChoice.setState({ byUser: { ...s, [userId]: v } });
  return v;
}

export function setActiveChoice(userId: string, address: string | null): void {
  const v = address ? address.toLowerCase() : null;
  try {
    if (v) localStorage.setItem(key(userId), v);
    else localStorage.removeItem(key(userId));
  } catch {
    /* storage blocked: the choice lasts for this tab */
  }
  useActiveChoice.setState((s) => ({ byUser: { ...s.byUser, [userId]: v } }));
}

/**
 * Picks the active wallet: the stored choice if usable here, else the first usable wallet, else the stored
 * choice (so the UI can say it needs connecting), else the first wallet.
 */
export function resolveActive<T extends { address: string; usable: boolean }>(wallets: T[], preferred: string | null): T | null {
  if (!wallets.length) return null;
  const pick = preferred ? wallets.find((w) => w.address.toLowerCase() === preferred.toLowerCase()) : undefined;
  if (pick?.usable) return pick;
  return wallets.find((w) => w.usable) ?? pick ?? wallets[0]!;
}
