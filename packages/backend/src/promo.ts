/**
 * Launch growth promo — "Start selling on BIDit, earn a $100 USDC bonus."
 *
 * A seller who *joins during the first 3 days of launch* and then fulfils $100 of
 * orders earns a $100 USDC match. The match is paid **manually, off-platform**
 * (nothing here moves treasury funds) — this module only tracks eligibility and
 * progress so you know who to pay.
 *
 * Enrollment window is driven by BIDIT_PROMO_START (set at launch). Unset ⇒ the
 * promo is inactive everywhere (banners hidden, nobody enrolled).
 */
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { formatUsdc, usdc } from '@bidit/shared';

const DAY_MS = 86_400_000;
export const PROMO_WINDOW_MS = 3 * DAY_MS; // enroll within the first 3 days
export const PROMO_BONUS_USD = 100; // the $100 match
export const PROMO_THRESHOLD = usdc('100'); // fulfil $100 (micro-units)

/** Promo start (ms since epoch) from BIDIT_PROMO_START — an ISO-8601 date or a
 *  raw ms timestamp. Returns null (promo inactive) if unset or unparseable. */
export function promoStartMs(): number | null {
  const raw = process.env.BIDIT_PROMO_START?.trim();
  if (!raw) return null;
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export interface PromoState {
  active: boolean; // enrollment window open right now
  bonusUsd: number;
  thresholdUsd: number;
  startMs: number | null;
  enrollEndsMs: number | null;
}

export function promoState(now = Date.now()): PromoState {
  const startMs = promoStartMs();
  const enrollEndsMs = startMs === null ? null : startMs + PROMO_WINDOW_MS;
  const active = startMs !== null && now >= startMs && now < enrollEndsMs!;
  return { active, bonusUsd: PROMO_BONUS_USD, thresholdUsd: PROMO_BONUS_USD, startMs, enrollEndsMs };
}

/** True if a seller who joined at `joinedMs` falls inside the enrollment window. */
export function isEnrolled(joinedMs: number, startMs = promoStartMs()): boolean {
  return startMs !== null && joinedMs >= startMs && joinedMs < startMs + PROMO_WINDOW_MS;
}

/** Fulfilled sale value (micro-units) for a seller — items shipped or delivered.
 *  Mirrors the "fulfilled" metric used for verification, but sums value. */
async function fulfilledValue(sellerId: string, prisma: PrismaClient): Promise<bigint> {
  const rows = await prisma.fulfillmentItem.findMany({
    where: { sellerId, status: { in: ['SHIPPED', 'DELIVERED'] } },
    select: { amount: true },
  });
  return rows.reduce((sum, r) => sum + r.amount, 0n);
}

export interface SellerPromoStatus {
  /** the promo exists (a start date is configured) */
  promoActive: boolean;
  /** this seller joined inside the enrollment window */
  enrolled: boolean;
  fulfilledUsd: string; // "45.00"
  thresholdUsd: number; // 100
  bonusUsd: number; // 100
  earned: boolean; // enrolled && fulfilled >= $100
  paid: boolean; // bonus already sent
}

export async function sellerPromoStatus(
  sellerId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<SellerPromoStatus> {
  const startMs = promoStartMs();
  const profile = await prisma.sellerProfile.findUnique({ where: { userId: sellerId } });
  const enrolled = !!profile && isEnrolled(profile.createdAt.getTime(), startMs);
  const value = enrolled ? await fulfilledValue(sellerId, prisma) : 0n;
  return {
    promoActive: startMs !== null,
    enrolled,
    fulfilledUsd: formatUsdc(value),
    thresholdUsd: PROMO_BONUS_USD,
    bonusUsd: PROMO_BONUS_USD,
    earned: enrolled && value >= PROMO_THRESHOLD,
    paid: !!profile?.promoBonusPaidAt,
  };
}

export interface PromoSellerRow {
  userId: string;
  handle: string;
  email: string | null;
  joinedAt: number;
  fulfilledUsd: string;
  earned: boolean;
  paidAt: number | null;
  payoutWalletAddress: string | null;
}

/** Admin: every enrolled seller + progress, for the manual payout list. */
export async function listPromoSellers(prisma: PrismaClient = defaultPrisma) {
  const startMs = promoStartMs();
  if (startMs === null) return { configured: false, startMs: null, enrollEndsMs: null, bonusUsd: PROMO_BONUS_USD, active: false, sellers: [] as PromoSellerRow[] };
  const profiles = await prisma.sellerProfile.findMany({
    where: { createdAt: { gte: new Date(startMs), lt: new Date(startMs + PROMO_WINDOW_MS) } },
    include: { user: { select: { handle: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const sellers: PromoSellerRow[] = await Promise.all(
    profiles.map(async (pf) => {
      const value = await fulfilledValue(pf.userId, prisma);
      return {
        userId: pf.userId,
        handle: pf.user.handle,
        email: pf.user.email,
        joinedAt: pf.createdAt.getTime(),
        fulfilledUsd: formatUsdc(value),
        earned: value >= PROMO_THRESHOLD,
        paidAt: pf.promoBonusPaidAt?.getTime() ?? null,
        payoutWalletAddress: pf.payoutWalletAddress ?? null,
      };
    }),
  );
  return { configured: true, startMs, enrollEndsMs: startMs + PROMO_WINDOW_MS, bonusUsd: PROMO_BONUS_USD, active: promoState().active, sellers };
}

/** Admin: record that a seller's $100 bonus was paid out (manually). Idempotent. */
export async function markPromoPaid(sellerId: string, prisma: PrismaClient = defaultPrisma): Promise<void> {
  await prisma.sellerProfile.update({
    where: { userId: sellerId },
    data: { promoBonusPaidAt: new Date() },
  });
}
