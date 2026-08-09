/**
 * The seller's complete sales history: every order (auction wins + buy-now)
 * AND every drawn giveaway, merged into one filterable, paginated list.
 *
 * Exists because the old /seller/orders DTO silently truncated at 50 rows with
 * no way to page further: after one busy stream a seller literally could not
 * see who won what. Giveaways never appeared at all (a Giveaway row has a
 * winner but no Order), so free prizes were invisible at fulfillment time.
 *
 * Both sources are fetched bounded (SOURCE_CAP each), merged in memory, then
 * sliced: at launch scale that's simpler and safer than dual-cursor pagination,
 * and the caps keep a pathological account from ballooning the response.
 */
import { formatUsdc } from '@bidit/shared';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';

const SOURCE_CAP = 1000; // per source; merged list is sliced after sorting
const MAX_TAKE = 100;
export const DEFAULT_TAKE = 50;

export interface SaleRow {
  id: string;
  kind: 'auction' | 'store' | 'giveaway';
  /** OrderStatus for orders; 'GIVEAWAY' for drawn giveaways. */
  status: string;
  amount: string;
  sellerProceeds: string;
  platformFee: string;
  /** The winner/buyer handle: who this goes to. */
  buyer: string;
  title: string;
  image: string | null;
  trackingNumber: string | null;
  createdAt: number;
}

export interface SalesQuery {
  /** Buyer/winner handle filter (contains, case-insensitive). */
  q?: string;
  /** Inclusive day-range bounds, ms since epoch. */
  fromMs?: number;
  toMs?: number;
  kind?: 'auction' | 'store' | 'giveaway' | 'all';
  skip?: number;
  take?: number;
}

export interface SalesPage {
  rows: SaleRow[];
  /** Total rows matching the FILTERS (not just this page), for "X of Y". */
  total: number;
}

export async function listSellerSales(
  sellerId: string,
  query: SalesQuery = {},
  prisma: PrismaClient = defaultPrisma,
): Promise<SalesPage> {
  const q = query.q?.trim().toLowerCase() ?? '';
  const kind = query.kind ?? 'all';
  const skip = Math.max(0, Math.floor(query.skip ?? 0));
  const take = Math.min(MAX_TAKE, Math.max(1, Math.floor(query.take ?? DEFAULT_TAKE)));
  const from = query.fromMs !== undefined ? new Date(query.fromMs) : undefined;
  const to = query.toMs !== undefined ? new Date(query.toMs) : undefined;
  const dateRange = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;

  const rows: SaleRow[] = [];

  if (kind !== 'giveaway') {
    const orders = await prisma.order.findMany({
      where: {
        sellerId,
        ...(kind === 'auction' ? { auctionId: { not: null } } : {}),
        ...(kind === 'store' ? { auctionId: null } : {}),
        ...(dateRange ? { createdAt: dateRange } : {}),
        ...(q ? { buyer: { handle: { contains: q, mode: 'insensitive' } } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: SOURCE_CAP,
      include: {
        buyer: { select: { handle: true } },
        auction: { select: { listing: { select: { title: true, photos: true } } } },
        listing: { select: { title: true, photos: true } },
      },
    });
    for (const o of orders) {
      const listing = o.auction?.listing ?? o.listing;
      rows.push({
        id: o.id,
        kind: o.auctionId ? 'auction' : 'store',
        status: o.status,
        amount: formatUsdc(o.amount),
        sellerProceeds: formatUsdc(o.sellerProceeds),
        platformFee: formatUsdc(o.platformFee),
        buyer: o.buyer.handle,
        title: listing?.title ?? 'Item',
        image: listing?.photos[0] ?? null,
        trackingNumber: o.trackingNumber,
        createdAt: o.createdAt.getTime(),
      });
    }
  }

  if (kind === 'giveaway' || kind === 'all') {
    const giveaways = await prisma.giveaway.findMany({
      where: {
        sellerId,
        winnerUserId: { not: null },
        ...(dateRange ? { drawnAt: dateRange } : {}),
      },
      orderBy: { drawnAt: 'desc' },
      take: SOURCE_CAP,
    });
    // winnerUserId has no schema relation, so resolve handles in one batch.
    const winnerIds = [...new Set(giveaways.map((g) => g.winnerUserId!))];
    const winners = await prisma.user.findMany({ where: { id: { in: winnerIds } }, select: { id: true, handle: true } });
    const handleById = new Map(winners.map((w) => [w.id, w.handle]));
    for (const g of giveaways) {
      const handle = handleById.get(g.winnerUserId!) ?? 'unknown';
      if (q && !handle.toLowerCase().includes(q)) continue;
      rows.push({
        id: `gw_${g.id}`,
        kind: 'giveaway',
        status: 'GIVEAWAY',
        amount: '0',
        sellerProceeds: '0',
        platformFee: '0',
        buyer: handle,
        title: g.prize,
        image: g.image ?? null,
        trackingNumber: null,
        createdAt: (g.drawnAt ?? g.createdAt).getTime(),
      });
    }
  }

  rows.sort((a, b) => b.createdAt - a.createdAt);
  return { rows: rows.slice(skip, skip + take), total: rows.length };
}
