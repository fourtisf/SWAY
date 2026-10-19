/**
 * Conservative bot/farm heuristics (brief §12: flagged accounts keep their points but lose reward
 * eligibility: Genesis, verified invites). Only flags, never unflags; admins review and can clear a flag
 * in /admin. Uses only the public X metrics Sway stores. Dev/demo accounts (x id ≥ 9e18) are skipped.
 */
import type { Clients } from '../clients';

const DAY_MS = 86400e3;

export interface BotCandidate {
  xId: string;
  followers: number;
  verified: boolean;
  official: boolean;
  xCreatedAt: Date | null;
  scoreInputs: unknown;
}

/** Returns the heuristic that matches, or null. */
export function botHeuristic(u: BotCandidate, now = new Date()): string | null {
  if (u.official || u.verified) return null;
  if (/^\d+$/.test(u.xId) && BigInt(u.xId) >= 9_000_000_000_000_000_000n) return null;
  const ageDays = u.xCreatedAt ? (now.getTime() - u.xCreatedAt.getTime()) / DAY_MS : null;
  const inputs = (u.scoreInputs ?? {}) as { er?: number; ppw?: number };
  // Brand-new account with almost no audience: the classic farm profile.
  if (ageDays !== null && ageDays < 14 && u.followers < 20) return 'new_account_no_audience';
  // Never posts and nobody engages: an empty shell created to farm points.
  if (u.followers < 10 && (inputs.ppw ?? 0) === 0 && (inputs.er ?? 0) === 0) return 'inactive_empty_account';
  return null;
}

export async function flagBots(c: Clients, now = new Date()): Promise<number> {
  const members = await c.prisma.user.findMany({
    // An admin's "not a bot" sticks: the heuristic never re-flags an account they cleared.
    where: { joinedAt: { not: null }, botFlag: false, deletedAt: null, OR: [{ botReason: null }, { botReason: { not: 'admin_cleared' } }] },
    select: { id: true, xId: true, followers: true, verified: true, official: true, xCreatedAt: true, scoreInputs: true },
  });
  let flagged = 0;
  for (const m of members) {
    const reason = botHeuristic(m, now);
    if (!reason) continue;
    await c.prisma.user.update({ where: { id: m.id }, data: { botFlag: true, botReason: reason, botFlaggedAt: now } });
    flagged++;
  }
  if (flagged) console.log(`[bots] flagged ${flagged} account(s) for review`);
  return flagged;
}
