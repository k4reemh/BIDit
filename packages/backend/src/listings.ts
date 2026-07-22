/** Listing creation + the seller's pre-show queue (Whatnot-style). */
import { ListingStatus, normalizeWheelEntries, type Micros, type WheelEntry } from '@bidit/shared';
import { Prisma, type Listing } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { requireSeller } from './authz.js';

// Bounds on seller-controlled listing input — a listing is broadcast to every
// viewer, so uncapped strings/arrays are a realtime-DoS + storage risk.
const MAX_TITLE_LEN = 140;
const MAX_DESC_LEN = 2000;
const MAX_CATEGORY_LEN = 40;
const MAX_PHOTOS = 12;
const MAX_PHOTO_LEN = 700_000; // ~500 KB, enough for a data-URL thumbnail
const MAX_QUANTITY = 100_000;

/** A user-facing listing rejection (bad price / input). 400 via the top handler. */
class ListingError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ListingError';
  }
}

/** Trim, strip control chars (keeping tab + newline), and cap the length. */
function clampText(s: string, max: number): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
}

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
  // Reject bad money up front. A negative buyNowPrice used to slip through creation,
  // then blow up in settlement (InvalidAmountError) AFTER stock was decremented,
  // orphaning a PENDING order (mirrors the guard in setListingStorePrice).
  if (input.startingBid < 0n) throw new ListingError('Starting bid can’t be negative.');
  if (input.buyNowPrice != null && input.buyNowPrice <= 0n) throw new ListingError('Buy-now price must be greater than 0.');
  const quantity = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(input.quantity ?? 1)));
  return prisma.listing.create({
    data: {
      sellerId,
      title: clampText(input.title, MAX_TITLE_LEN),
      description: input.description ? clampText(input.description, MAX_DESC_LEN) : null,
      photos: (input.photos ?? []).filter((p) => typeof p === 'string' && p.length <= MAX_PHOTO_LEN).slice(0, MAX_PHOTOS),
      startingBid: input.startingBid,
      buyNowPrice: input.buyNowPrice ?? null,
      quantity,
      weightGrams: input.weightGrams ?? null,
      category: input.category ? clampText(input.category, MAX_CATEGORY_LEN) : null,
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
