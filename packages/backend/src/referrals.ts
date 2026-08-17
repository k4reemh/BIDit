/**
 * Referral codes, stats, and the leaderboard. The money side (what qualifies a
 * referral and the point payouts) lives in points.ts next to the grants; this
 * module owns the shareable identity around it.
 *
 * A code is vanity (the user's handle at generation time), immutable once
 * created so shared links never break, and DB-unique. `referredById` is set
 * exactly once at signup and never rewritten: your referrer is whoever's link
 * actually brought you in.
 */
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';

export class ReferralError extends Error {}

const CODE_MAX = 20;

function sanitize(handle: string): string {
  return handle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, CODE_MAX);
}

function randomSuffix(n = 3): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** The user's share code, created on first request (handle-based, unique). */
export async function getOrCreateReferralCode(userId: string, prisma: PrismaClient = defaultPrisma): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { handle: true, referralCode: true } });
  if (!user) throw new ReferralError('User not found.');
  if (user.referralCode) return user.referralCode;

  const base = sanitize(user.handle) || `bidit${randomSuffix(4)}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base.slice(0, CODE_MAX - 3)}${randomSuffix()}`;
    try {
      const updated = await prisma.user.update({ where: { id: userId }, data: { referralCode: candidate } });
      return updated.referralCode!;
    } catch (err) {
      // P2002 = someone owns this code (or a parallel request set ours): re-read.
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
        const again = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
        if (again?.referralCode) return again.referralCode;
        continue;
      }
      throw err;
    }
  }
  throw new ReferralError('Could not create a referral code. Try again.');
}

/**
 * Attach a referrer at signup from a ?ref= code. Best-effort and strictly
 * first-writer-wins: never overwrites an existing referrer, never self-refers,
 * and silently no-ops on an unknown code (a mistyped link must not break signup).
 */
export async function applyReferralAtSignup(
  newUserId: string,
  codeRaw: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const code = (codeRaw ?? '').trim().toLowerCase();
  if (!code) return false;
  const referrer = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } });
  if (!referrer || referrer.id === newUserId) return false;
  const set = await prisma.user.updateMany({
    where: { id: newUserId, referredById: null },
    data: { referredById: referrer.id },
  });
  return set.count === 1;
}

export interface ReferralInfo {
  code: string;
  /** Everyone who signed up through the link. */
  referred: number;
  /** Those who have made their qualifying first deposit/purchase. */
  qualified: number;
  /** Points earned from referrals (the per-referral grants). */
  pointsEarned: string;
}

export async function getReferralInfo(userId: string, prisma: PrismaClient = defaultPrisma): Promise<ReferralInfo> {
  const code = await getOrCreateReferralCode(userId, prisma);
  const [referred, qualified, earned] = await Promise.all([
    prisma.user.count({ where: { referredById: userId } }),
    prisma.user.count({ where: { referredById: userId, referralQualifiedAt: { not: null } } }),
    prisma.pointsEvent.aggregate({ _sum: { points: true }, where: { userId, kind: { in: ['referral', 'mission:refer_friend'] } } }),
  ]);
  return { code, referred, qualified, pointsEarned: (earned._sum.points ?? 0n).toString() };
}

export interface ReferralLeaderRow {
  handle: string;
  avatarUrl: string | null;
  userId: string;
  qualified: number;
}

/** Top referrers by qualified referrals (the launch-week race board). */
export async function referralLeaders(limit = 25, prisma: PrismaClient = defaultPrisma): Promise<ReferralLeaderRow[]> {
  const groups = await prisma.user.groupBy({
    by: ['referredById'],
    where: { referredById: { not: null }, referralQualifiedAt: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { referredById: 'desc' } },
    take: limit,
  });
  const ids = groups.map((g) => g.referredById!).filter(Boolean);
  if (ids.length === 0) return [];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, handle: true, avatarUrl: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  return groups
    .map((g) => {
      const u = byId.get(g.referredById!);
      return u ? { userId: u.id, handle: u.handle, avatarUrl: u.avatarUrl, qualified: g._count._all } : null;
    })
    .filter((r): r is ReferralLeaderRow => r !== null);
}
