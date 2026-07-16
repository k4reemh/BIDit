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
