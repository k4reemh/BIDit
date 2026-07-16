/** Listing creation + the seller's pre-show queue (Whatnot-style). */
import { ListingStatus, normalizeWheelEntries, type Micros, type WheelEntry } from '@bidit/shared';
import { Prisma, type Listing } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { requireSeller } from './authz.js';

export interface CreateListingInput {
  title: string;
  description?: string;
  photos?: string[];
  startingBid: Micros;
  /** Optional store "buy now" price — puts the item in the seller's shop. */
  buyNowPrice?: Micros;
  quantity?: number;
  weightGrams?: number;
  category?: string;
}

/** Create a QUEUED listing. Only verified sellers may list. */
export async function createListing(
  sellerId: string,
  input: CreateListingInput,
  prisma: PrismaClient = defaultPrisma,
): Promise<Listing> {
  await requireSeller(sellerId, prisma);
  const quantity = Math.max(1, Math.floor(input.quantity ?? 1));
  return prisma.listing.create({
    data: {
      sellerId,
      title: input.title,
      description: input.description ?? null,
      photos: input.photos ?? [],
      startingBid: input.startingBid,
      buyNowPrice: input.buyNowPrice ?? null,
      quantity,
      weightGrams: input.weightGrams ?? null,
      category: input.category ?? null,
      status: ListingStatus.QUEUED,
    },
  });
}

/** A seller's listings, queue first. */
export function listSellerListings(
  sellerId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<Listing[]> {
  return prisma.listing.findMany({ where: { sellerId }, orderBy: { createdAt: 'asc' }, take: 500 });
}

/**
 * Attach (or clear) a wheel-spin prize pool on one of the seller's listings.
 * Verified-seller + ownership gated, and only allowed while the listing is still
 * QUEUED — the wheel must be set up BEFORE the auction runs, never mid-flight.
 * Passing an empty list clears the wheel (back to a normal auction).
 */
export async function setListingWheel(
  sellerId: string,
  listingId: string,
  rawEntries: unknown,
  prisma: PrismaClient = defaultPrisma,
): Promise<WheelEntry[]> {
  await requireSeller(sellerId, prisma);
  const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
  if (listing.sellerId !== sellerId) throw new Error('not your listing');
  if (listing.status !== ListingStatus.QUEUED) {
    throw new Error(`wheel can only be set while the listing is QUEUED (${listing.status})`);
  }
  const entries = normalizeWheelEntries(rawEntries);
  await prisma.listing.update({
    where: { id: listingId },
    data: {
      wheel: entries.length ? (entries as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    },
  });
  return entries;
}

/**
 * Set (or clear, with null) the store "buy now" price on one of the seller's
 * listings. Ownership gated; allowed any time before the listing is SOLD — the
 * store only ever *shows* QUEUED listings, so pricing a LIVE one just takes
 * effect after its auction closes.
 */
export async function setListingStorePrice(
  sellerId: string,
  listingId: string,
  buyNowPrice: Micros | null,
  prisma: PrismaClient = defaultPrisma,
): Promise<Listing> {
  await requireSeller(sellerId, prisma);
  const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
  if (listing.sellerId !== sellerId) throw new Error('not your listing');
  if (buyNowPrice !== null && buyNowPrice <= 0n) throw new Error('store price must be positive');
  return prisma.listing.update({
    where: { id: listingId },
    data: { buyNowPrice },
  });
}
