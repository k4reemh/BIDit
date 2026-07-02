/** Admin tools: verify sellers, audit the ledger. (Dispute resolution + manual
 *  release/refund live in orders.ts; the admin API calls those.) */
import { Role, formatUsdc } from '@bidit/shared';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { requireAdmin } from './authz.js';
import { getSettledBalance, getSystemTotal, getBuybackPending } from './ledger.js';

/** Verify a seller (admin-gated). Promotes them to the `seller` role too. */
export async function verifySeller(
  adminId: string,
  sellerUserId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  await requireAdmin(adminId, prisma);
  await prisma.sellerProfile.upsert({
    where: { userId: sellerUserId },
    update: { verified: true },
    create: { userId: sellerUserId, verified: true },
  });
  await prisma.user.update({ where: { id: sellerUserId }, data: { role: Role.seller } });
}

export interface SellerRow {
  userId: string;
  handle: string;
  verified: boolean;
  pumpCoinAddress: string | null;
}

export async function listSellers(
  adminId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<SellerRow[]> {
  await requireAdmin(adminId, prisma);
  const profiles = await prisma.sellerProfile.findMany({
    include: { user: { select: { handle: true } } },
  });
  return profiles.map((p) => ({
    userId: p.userId,
    handle: p.user.handle,
    verified: p.verified,
    pumpCoinAddress: p.pumpCoinAddress,
  }));
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
