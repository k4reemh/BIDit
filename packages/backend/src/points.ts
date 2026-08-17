/**
 * BIDit Points: activity rewards redeemed against future community airdrops
 * (5% of $BID supply is locked at launch for them).
 *
 * Two ways to earn:
 *  - Automatic accrual on every sale: buyers earn 100 pts per $1 spent, sellers
 *    20 pts per $1 sold. Awarded at settlement, keyed by orderId so a retried
 *    settle can never double-pay.
 *  - One-time missions (deposit, first bid, first win, …): completion is DERIVED
 *    from what the user has actually done, then the user presses CLAIM, which
 *    writes the grant. Claims are idempotent via the same unique key.
 *
 * User.points is a denormalized mirror of PointsEvent sums so the leaderboard
 * is a single indexed read.
 */
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { notify } from './notifications.js';

const USDC = 1_000_000n; // one dollar in micro-units

export const BUY_POINTS_PER_USD = 100n;
export const SELL_POINTS_PER_USD = 20n;

/** 100 pts per $1 spent (floor). */
export function pointsForSpend(amountMicros: bigint): bigint {
  return (amountMicros * BUY_POINTS_PER_USD) / USDC;
}

/** 20 pts per $1 sold (floor). */
export function pointsForSale(amountMicros: bigint): bigint {
  return (amountMicros * SELL_POINTS_PER_USD) / USDC;
}

/** A user-facing points failure (unknown mission, not completed yet, …). */
export class PointsError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PointsError';
  }
}

// ---------------------------------------------------------------------------
// Grants (idempotent writes)
// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002';
}

/** Write one grant + bump the mirror. No-op if this (user, kind, ref) already paid. */
async function grant(
  userId: string,
  kind: string,
  ref: string,
  points: bigint,
  prisma: PrismaClient,
): Promise<boolean> {
  if (points <= 0n) return false;
  try {
    await prisma.$transaction([
      prisma.pointsEvent.create({ data: { userId, kind, ref, points } }),
      prisma.user.update({ where: { id: userId }, data: { points: { increment: points } } }),
    ]);
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false; // already granted
    throw err;
  }
}

/** Automatic accrual on a settled sale: buyer 100×, seller 20×. Idempotent per order. */
export async function awardOrderPoints(
  params: { orderId: string; buyerId: string; sellerId: string; amount: bigint },
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  await grant(params.buyerId, 'buy', params.orderId, pointsForSpend(params.amount), prisma);
  await grant(params.sellerId, 'sell', params.orderId, pointsForSale(params.amount), prisma);
  // A purchase is a qualifying action for the referral program: the buyer has
  // real money on the line, so their referrer's reward unlocks here.
  await qualifyReferral(params.buyerId, prisma).catch((e) =>
    console.error('[referral] qualify on order failed', (e as Error)?.message ?? e),
  );
}

// ---------------------------------------------------------------------------
// Referrals: invite a friend, both sides earn once the friend does something real
// ---------------------------------------------------------------------------

export const REFERRER_POINTS = 2_500n;
export const REFEREE_POINTS = 1_000n;
/** A deposit must be at least this ($10) to qualify a referral. The qualifying
 *  action must cost real money, or throwaway signups could farm points. */
export const MIN_REFERRAL_DEPOSIT = 10_000_000n;

/**
 * Pay out the referral for `userId`'s first qualifying action (first deposit of
 * $10+, or any purchase). Exactly once per referred user: the CAS on
 * `referralQualifiedAt IS NULL` decides the winner under races, and the point
 * grants are additionally idempotent by (user, kind, ref). Safe to call from
 * any money path; a user with no referrer is a cheap no-op.
 */
export async function qualifyReferral(userId: string, prisma: PrismaClient = defaultPrisma): Promise<boolean> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { referredById: true, referralQualifiedAt: true, handle: true },
  });
  if (!u?.referredById || u.referralQualifiedAt) return false;
  const claimed = await prisma.user.updateMany({
    where: { id: userId, referralQualifiedAt: null, referredById: { not: null } },
    data: { referralQualifiedAt: new Date() },
  });
  if (claimed.count !== 1) return false;

  await grant(u.referredById, 'referral', userId, REFERRER_POINTS, prisma);
  await grant(userId, 'referred', userId, REFEREE_POINTS, prisma);
  await notify(
    {
      userId: u.referredById,
      kind: 'referral',
      title: `Referral landed: @${u.handle} is in`,
      body: `They made their first move on BIDit. +${REFERRER_POINTS.toLocaleString('en-US')} points to you. Keep sharing your link.`,
      href: '/points',
    },
    prisma,
  );
  await notify(
    {
      userId,
      kind: 'referral',
      title: `Referral bonus: +${REFEREE_POINTS.toLocaleString('en-US')} points`,
      body: 'Welcome bonus for joining through a friend. Points convert into future $BID rewards.',
      href: '/points',
      email: false,
    },
    prisma,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

export interface MissionDef {
  id: string;
  title: string;
  desc: string;
  points: bigint;
  /** Not yet earnable (e.g. referrals until referral links ship). */
  comingSoon?: boolean;
}

export const MISSIONS: readonly MissionDef[] = [
  { id: 'deposit', title: 'Fund your wallet', desc: 'Deposit USDC into your BIDit wallet.', points: 1_000n },
  { id: 'first_bid', title: 'Place your first bid', desc: 'Jump into any live auction and bid.', points: 1_000n },
  { id: 'first_win', title: 'Win your first auction', desc: 'Outbid the room and take an item home.', points: 3_000n },
  { id: 'giveaway_win', title: 'Win a live giveaway', desc: 'Get drawn as the winner of a stream giveaway.', points: 1_000n },
  { id: 'refer_friend', title: 'Refer a friend', desc: 'They sign up with your link and make their first deposit or purchase.', points: 5_000n },
  { id: 'first_sale', title: 'Make your first sale', desc: 'Sell and fulfill your first item on BIDit.', points: 3_000n },
  { id: 'sell_10', title: 'Fulfill 10 orders', desc: 'Sell and fulfill 10 items on BIDit.', points: 3_000n },
  { id: 'verified_seller', title: 'Become a Verified Seller', desc: 'Fulfill 10 orders to earn the Verified badge.', points: 10_000n },
] as const;

const missionKind = (id: string) => `mission:${id}`;

export type MissionStatus = 'locked' | 'claimable' | 'claimed';

/** Has the user actually done the thing? (Derived, never stored.) */
async function missionCompleted(userId: string, missionId: string, prisma: PrismaClient): Promise<boolean> {
  switch (missionId) {
    case 'deposit': {
      const acct = await prisma.account.findUnique({ where: { userId }, select: { id: true } });
      if (!acct) return false;
      return (await prisma.ledgerEntry.count({ where: { accountId: acct.id, type: 'DEPOSIT' } })) > 0;
    }
    case 'first_bid':
      return (await prisma.bid.count({ where: { userId } })) > 0;
    case 'first_win':
      return (await prisma.order.count({ where: { buyerId: userId } })) > 0;
    case 'giveaway_win':
      return (await prisma.giveaway.count({ where: { winnerUserId: userId } })) > 0;
    case 'refer_friend':
      return (await prisma.user.count({ where: { referredById: userId, referralQualifiedAt: { not: null } } })) > 0;
    case 'first_sale':
      return (await fulfilledCount(userId, prisma)) >= 1;
    case 'sell_10':
      return (await fulfilledCount(userId, prisma)) >= 10;
    case 'verified_seller': {
      const profile = await prisma.sellerProfile.findUnique({ where: { userId }, select: { verified: true } });
      if (profile?.verified) return true;
      const fulfilled = await prisma.fulfillmentItem.aggregate({
        where: { sellerId: userId, status: { in: ['SHIPPED', 'DELIVERED'] } },
        _sum: { amount: true },
      });
      return (fulfilled._sum.amount ?? 0n) >= 500n * USDC;
    }
    default:
      return false;
  }
}

function fulfilledCount(sellerId: string, prisma: PrismaClient): Promise<number> {
  return prisma.fulfillmentItem.count({ where: { sellerId, status: { in: ['SHIPPED', 'DELIVERED'] } } });
}

export interface MissionState {
  id: string;
  title: string;
  desc: string;
  points: bigint;
  status: MissionStatus;
  comingSoon: boolean;
}

export interface PointsSummary {
  points: bigint;
  missions: MissionState[];
}

/** The points page payload: balance + every mission with its live status. */
export async function getPointsSummary(userId: string, prisma: PrismaClient = defaultPrisma): Promise<PointsSummary> {
  const [user, events] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { points: true } }),
    prisma.pointsEvent.findMany({
      where: { userId, kind: { startsWith: 'mission:' } },
      select: { kind: true },
    }),
  ]);
  const claimed = new Set(events.map((e) => e.kind));

  const missions = await Promise.all(
    MISSIONS.map(async (m): Promise<MissionState> => {
      let status: MissionStatus = 'locked';
      if (claimed.has(missionKind(m.id))) status = 'claimed';
      else if (!m.comingSoon && (await missionCompleted(userId, m.id, prisma))) status = 'claimable';
      return { id: m.id, title: m.title, desc: m.desc, points: m.points, status, comingSoon: m.comingSoon ?? false };
    }),
  );

  return { points: user.points, missions };
}

/** Claim a completed mission. Throws PointsError unless it's genuinely claimable. */
export async function claimMission(
  userId: string,
  missionId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ points: bigint; total: bigint }> {
  const def = MISSIONS.find((m) => m.id === missionId);
  if (!def) throw new PointsError('Unknown mission.');
  if (def.comingSoon) throw new PointsError('This mission isn’t live yet. Coming soon.');
  if (!(await missionCompleted(userId, missionId, prisma))) {
    throw new PointsError('Complete the mission first, then claim it.');
  }
  const granted = await grant(userId, missionKind(missionId), '', def.points, prisma);
  if (!granted) throw new PointsError('Already claimed.');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { points: true } });
  return { points: def.points, total: user.points };
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardRow {
  rank: number;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  points: bigint;
}

/** Top point earners, ranked. Public: shows only public profile fields. */
export async function getLeaderboard(limit = 25, prisma: PrismaClient = defaultPrisma): Promise<LeaderboardRow[]> {
  const users = await prisma.user.findMany({
    where: { points: { gt: 0n } },
    orderBy: [{ points: 'desc' }, { createdAt: 'asc' }],
    take: Math.min(Math.max(1, limit), 100),
    select: { handle: true, displayName: true, avatarUrl: true, points: true },
  });
  return users.map((u, i) => ({ rank: i + 1, ...u }));
}
