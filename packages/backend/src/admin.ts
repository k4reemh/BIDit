/** Admin tools: verify sellers, audit the ledger. (Dispute resolution + manual
 *  release/refund live in orders.ts; the admin API calls those.) */
import { Role, formatUsdc } from '@bidit/shared';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { requireAdmin } from './authz.js';
import { getSettledBalance, getSystemTotal, getBuybackPending } from './ledger.js';
import { sellerFulfilledCount, VERIFY_THRESHOLD } from './seller-verify.js';

/** Verify a seller (admin-gated). Grants the badge + records who/when. */
export async function verifySeller(
  adminId: string,
  sellerUserId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  await requireAdmin(adminId, prisma);
  await prisma.sellerProfile.upsert({
    where: { userId: sellerUserId },
    update: { verified: true, verifiedAt: new Date(), verifiedBy: adminId },
    create: { userId: sellerUserId, verified: true, verifiedAt: new Date(), verifiedBy: adminId },
  });
  const user = await prisma.user.findUnique({ where: { id: sellerUserId } });
  if (user?.role === Role.buyer) {
    await prisma.user.update({ where: { id: sellerUserId }, data: { role: Role.seller } });
  }
}

export interface SellerRow {
  userId: string;
  handle: string;
  displayName: string | null;
  email: string | null;
  verified: boolean;
  verifiedBy: string | null;
  hiddenFromLive: boolean;
  appliedAt: number | null;
  onboarded: boolean;
  fulfilledCount: number;
  threshold: number;
  pitch: string | null;
  website: string | null;
  socials: Record<string, string> | null;
  pumpCoinAddress: string | null;
  origin: { country: string | null; region: string | null; city: string | null; postal: string | null };
}

/** Every seller/applicant with the info an admin needs to vet + verify them. */
export async function listSellers(
  adminId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<SellerRow[]> {
  await requireAdmin(adminId, prisma);
  const profiles = await prisma.sellerProfile.findMany({
    include: { user: { select: { handle: true, displayName: true, email: true } } },
    orderBy: [{ verified: 'asc' }, { appliedAt: 'desc' }],
    take: 500,
  });
  return Promise.all(
    profiles.map(async (p) => ({
      userId: p.userId,
      handle: p.user.handle,
      displayName: p.user.displayName,
      email: p.user.email,
      verified: p.verified,
      verifiedBy: p.verifiedBy,
      hiddenFromLive: p.hiddenFromLive,
      appliedAt: p.appliedAt ? p.appliedAt.getTime() : null,
      onboarded: p.onboardedSeller,
      fulfilledCount: await sellerFulfilledCount(p.userId, prisma),
      threshold: VERIFY_THRESHOLD,
      pitch: p.pitch,
      website: p.website,
      socials: (p.socials as Record<string, string> | null) ?? null,
      pumpCoinAddress: p.pumpCoinAddress,
      origin: { country: p.originCountry, region: p.originRegion, city: p.originCity, postal: p.originPostal },
    })),
  );
}

/** Show or hide a seller's stream everywhere it is discovered (home grid,
 *  browse). Nothing is unlinked or deleted, so it is safe on live sellers and
 *  fully reversible: built for retiring test streams. */
export async function setSellerVisibility(
  adminId: string,
  sellerId: string,
  hidden: boolean,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  await requireAdmin(adminId, prisma);
  await prisma.sellerProfile.update({ where: { userId: sellerId }, data: { hiddenFromLive: hidden } });
}

export interface LedgerAudit {
  accounts: Array<{ id: string; kind: string; handle: string | null; balance: string }>;
  systemTotal: string;
  buybackPending: string;
}

/** Full ledger audit view: every account's balance + the conservation check. */
export async function ledgerAudit(
  adminId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<LedgerAudit> {
  await requireAdmin(adminId, prisma);
  const accounts = await prisma.account.findMany({
    include: { user: { select: { handle: true } } },
    orderBy: { kind: 'asc' },
  });
  const rows = [];
  for (const a of accounts) {
    rows.push({
      id: a.id,
      kind: a.kind,
      handle: a.user?.handle ?? null,
      balance: formatUsdc(await getSettledBalance(a.id, prisma)),
    });
  }
  return {
    accounts: rows,
    systemTotal: formatUsdc(await getSystemTotal(prisma)),
    buybackPending: formatUsdc(await getBuybackPending(prisma)),
  };
}

export interface StatsPoint {
  /** Bucket start, ms since epoch (UTC hour/day boundary). */
  t: number;
  n: number;
}

export interface AdminStats {
  users: {
    total: number;
    lastHour: number;
    lastDay: number;
    last7d: number;
    sellers: number;
    verifiedSellers: number;
    /** Signups per hour for the trailing 24 hours (oldest first, zero-filled). */
    hourly: StatsPoint[];
    /** Signups per day for the trailing 14 days (oldest first, zero-filled). */
    daily: StatsPoint[];
  };
  money: {
    /** Order volume (all orders except refunded/canceled), human USDC. */
    gmvUsd: string;
    orders: number;
    /** Realized platform fees: released orders only. */
    feesUsd: string;
    releasedOrders: number;
    refundedUsd: string;
    refundedOrders: number;
    /** Executed $BID buybacks. */
    buybackUsd: string;
    buybacks: number;
    /** Real money in/out, from the ledger's credit/debit legs. */
    depositedUsd: string;
    withdrawnUsd: string;
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Zero-fill a bucketed count series so quiet periods show as 0, not gaps. */
function fillSeries(
  raw: Array<{ bucket: Date; n: bigint }>,
  stepMs: number,
  buckets: number,
  now: number,
): StatsPoint[] {
  const startOfCurrent = Math.floor(now / stepMs) * stepMs;
  const byBucket = new Map(raw.map((r) => [r.bucket.getTime(), Number(r.n)]));
  const out: StatsPoint[] = [];
  for (let i = buckets - 1; i >= 0; i -= 1) {
    const t = startOfCurrent - i * stepMs;
    out.push({ t, n: byBucket.get(t) ?? 0 });
  }
  return out;
}

/** Launch dashboard numbers: signups, volume, fees, buybacks, money in/out. */
export async function adminStats(
  adminId: string,
  prisma: PrismaClient = defaultPrisma,
  now = Date.now(),
): Promise<AdminStats> {
  await requireAdmin(adminId, prisma);

  const [total, lastHour, lastDay, last7d, sellers, verifiedSellers] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: new Date(now - HOUR_MS) } } }),
    prisma.user.count({ where: { createdAt: { gte: new Date(now - DAY_MS) } } }),
    prisma.user.count({ where: { createdAt: { gte: new Date(now - 7 * DAY_MS) } } }),
    prisma.sellerProfile.count(),
    prisma.sellerProfile.count({ where: { verified: true } }),
  ]);

  // Bucketed signup counts (UTC). Empty buckets are filled with zeros so the
  // chart shows a quiet hour as quiet instead of skipping it.
  const [hourlyRaw, dailyRaw] = await Promise.all([
    prisma.$queryRaw<Array<{ bucket: Date; n: bigint }>>`
      SELECT date_trunc('hour', "createdAt") AS bucket, count(*)::bigint AS n
      FROM "User" WHERE "createdAt" >= ${new Date(now - 24 * HOUR_MS)}
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<Array<{ bucket: Date; n: bigint }>>`
      SELECT date_trunc('day', "createdAt") AS bucket, count(*)::bigint AS n
      FROM "User" WHERE "createdAt" >= ${new Date(now - 14 * DAY_MS)}
      GROUP BY 1 ORDER BY 1`,
  ]);

  const [gmv, released, refunded, buyback] = await Promise.all([
    prisma.order.aggregate({
      _sum: { amount: true },
      _count: true,
      where: { status: { notIn: ['REFUNDED', 'CANCELED'] } },
    }),
    prisma.order.aggregate({ _sum: { platformFee: true }, _count: true, where: { status: 'RELEASED' } }),
    prisma.order.aggregate({ _sum: { amount: true }, _count: true, where: { status: 'REFUNDED' } }),
    prisma.buyback.aggregate({ _sum: { amount: true }, _count: true, where: { status: 'EXECUTED' } }),
  ]);

  // Double-entry: each deposit/withdrawal writes a credit and a matching debit
  // (they sum to zero across accounts), so total real money moved is the sum of
  // one side only. Deposits: the positive (user-credit) legs. Withdrawals: the
  // negative (user-debit) legs, reported as a positive "money out" number.
  const [deposited, withdrawn] = await Promise.all([
    prisma.ledgerEntry.aggregate({ _sum: { amount: true }, where: { type: 'DEPOSIT', amount: { gt: 0n } } }),
    prisma.ledgerEntry.aggregate({ _sum: { amount: true }, where: { type: 'WITHDRAWAL', amount: { lt: 0n } } }),
  ]);

  return {
    users: {
      total,
      lastHour,
      lastDay,
      last7d,
      sellers,
      verifiedSellers,
      hourly: fillSeries(hourlyRaw, HOUR_MS, 24, now),
      daily: fillSeries(dailyRaw, DAY_MS, 14, now),
    },
    money: {
      gmvUsd: formatUsdc(gmv._sum.amount ?? 0n),
      orders: gmv._count,
      feesUsd: formatUsdc(released._sum.platformFee ?? 0n),
      releasedOrders: released._count,
      refundedUsd: formatUsdc(refunded._sum.amount ?? 0n),
      refundedOrders: refunded._count,
      buybackUsd: formatUsdc(buyback._sum.amount ?? 0n),
      buybacks: buyback._count,
      depositedUsd: formatUsdc(deposited._sum.amount ?? 0n),
      withdrawnUsd: formatUsdc(-(withdrawn._sum.amount ?? 0n)),
    },
  };
}
