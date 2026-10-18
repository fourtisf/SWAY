/**
 * Member upsert, shared by X sign-in and dev sign-in. Stores only what brief §12 allows: X id, handle, name,
 * avatar URL, bio, public metrics used for scoring, score and reach value. A placeholder User behind a fan
 * market is upgraded in place. New members get the next memberNo inside one transaction.
 */
import type { PrismaClient, User } from '@sway/db';
import { score, type ScoreInputs } from '@sway/scoring';
import { hash, normalizeHandle } from '@sway/shared';

export interface MemberProfile {
  xId: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  bio: string;
  followers: number;
  verified: boolean;
  xCreatedAt: Date | null;
}

export interface MemberScore {
  inputs: ScoreInputs;
  score: number;
  value: number;
}

/** pg advisory lock id that serializes memberNo assignment. */
const MEMBER_NO_LOCK = 4_663_001;

export async function upsertMember(
  prisma: PrismaClient,
  profile: MemberProfile,
  scored: MemberScore | null,
  opts: { ref?: string | null; now?: Date } = {},
): Promise<{ user: User; isNew: boolean }> {
  const now = opts.now ?? new Date();
  const handle = normalizeHandle(profile.handle);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MEMBER_NO_LOCK})`;
    const existing = await tx.user.findUnique({ where: { xId: profile.xId } });

    // Handles move between X accounts; the stale holder of this handle gets a suffixed one.
    const clash = await tx.user.findUnique({ where: { handle } });
    if (clash && clash.xId !== profile.xId) {
      await tx.user.update({ where: { id: clash.id }, data: { handle: `${handle}_${clash.id.slice(-5)}`.slice(0, 40) } });
    }

    const isNew = !existing?.joinedAt;
    let memberNo = existing?.memberNo ?? null;
    if (isNew && memberNo === null) {
      const max = await tx.user.aggregate({ _max: { memberNo: true } });
      memberNo = (max._max.memberNo ?? 0) + 1;
    }
    const data = {
      handle,
      name: profile.name.slice(0, 80) || handle,
      avatarUrl: profile.avatarUrl,
      bio: profile.bio.slice(0, 500),
      followers: Math.max(0, Math.round(profile.followers)),
      verified: profile.verified,
      xCreatedAt: profile.xCreatedAt,
      ...(scored
        ? { score: scored.score, reachValue: scored.value, scoreInputs: scored.inputs as unknown as object, scoredAt: now }
        : {}),
      ...(isNew ? { joinedAt: now, memberNo } : {}),
    };
    const user = existing
      ? await tx.user.update({ where: { id: existing.id }, data })
      : await tx.user.create({ data: { xId: profile.xId, ...data } });

    if (isNew && opts.ref) {
      const inviter = await tx.user.findUnique({ where: { handle: normalizeHandle(opts.ref) } });
      if (inviter && inviter.id !== user.id && inviter.joinedAt) {
        await tx.referral.createMany({ data: [{ inviterId: inviter.id, inviteeId: user.id }], skipDuplicates: true });
      }
    }
    return { user, isNew };
  });
}

/* ------------------------------------------------------------------ dev sign-in (prototype makeUser) */

/** The prototype's rng() (mulberry32), ported exactly. */
export function rng(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic uint64 X id for a dev handle: 9e18 + hash(handle), as a decimal string. */
export const devXId = (handle: string): string => (9_000_000_000_000_000_000n + BigInt(hash(handle))).toString();

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

/** The prototype's makeUser(handle, followers): same followers, inputs and score for the same handle. */
export function makeDevProfile(rawHandle: string, followersIn?: number, now = new Date()): { profile: MemberProfile; scored: MemberScore } {
  const handle = normalizeHandle(rawHandle) || 'you';
  const r = rng(hash(handle + 'u'));
  const followers = followersIn || Math.round(Math.pow(10, 2.6 + r() * 3.2));
  const inputs: ScoreInputs = { followers, er: 0.008 + r() * 0.04, ppw: 3 + r() * 18, age: 1 + r() * 9, verified: r() > 0.35 };
  const sm = score(inputs);
  return {
    profile: {
      xId: devXId(handle),
      handle,
      name: handle[0]!.toUpperCase() + handle.slice(1),
      avatarUrl: null,
      bio: '',
      followers,
      verified: inputs.verified,
      xCreatedAt: new Date(now.getTime() - inputs.age * YEAR_MS),
    },
    scored: { inputs, score: sm.score, value: sm.value },
  };
}
