/**
 * Seller verification. A seller is UNVERIFIED when they apply and earns the
 * Verified badge (plus priority dispute support) once they fulfill
 * VERIFY_THRESHOLD orders — or an admin verifies them manually.
 */
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { notify } from './notifications.js';

export const VERIFY_THRESHOLD = 10;

/** Orders a seller has fulfilled — items that have shipped (or been delivered).
 *  This is the metric that earns the badge. */
export function sellerFulfilledCount(sellerId: string, prisma: PrismaClient = defaultPrisma): Promise<number> {
  return prisma.fulfillmentItem.count({ where: { sellerId, status: { in: ['SHIPPED', 'DELIVERED'] } } });
}

/** Auto-verify a seller once they've fulfilled VERIFY_THRESHOLD orders. Idempotent
 *  (no-op if already verified). Called after each shipment ships. */
export async function maybeVerifySeller(sellerId: string, prisma: PrismaClient = defaultPrisma): Promise<void> {
  const profile = await prisma.sellerProfile.findUnique({ where: { userId: sellerId } });
  if (!profile || profile.verified) return;
  if ((await sellerFulfilledCount(sellerId, prisma)) < VERIFY_THRESHOLD) return;
  await prisma.sellerProfile.update({
    where: { userId: sellerId },
    data: { verified: true, verifiedAt: new Date(), verifiedBy: 'auto' },
  });
  await notify(
    {
      userId: sellerId,
      kind: 'verified',
      title: 'You’re now a Verified Seller ✔',
      body: `You’ve fulfilled ${VERIFY_THRESHOLD} orders — you’ve earned the Verified badge and priority dispute support.`,
      href: '/seller',
    },
    prisma,
  );
}
