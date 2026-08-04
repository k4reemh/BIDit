/** Listing creation + the seller's pre-show queue (Whatnot-style). */
import {
  ListingStatus,
  normalizeWheelEntries,
  resolveParcel,
  ParcelError,
  type Micros,
  type ParcelDims,
  type WheelEntry,
} from '@bidit/shared';
import { Prisma, type Listing } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { requireSeller } from './authz.js';

// Bounds on seller-controlled listing input: a listing is broadcast to every
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
  /** Optional store "buy now" price: puts the item in the seller's shop. */
  buyNowPrice?: Micros;
  quantity?: number;
  weightGrams?: number;
  /** Preset id from PARCEL_PRESETS, or 'custom' with `parcel` supplied. */
  parcelPreset?: string;
  parcel?: Partial<ParcelDims>;
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
  // resolveParcel is the only thing that turns a client-supplied preset id into
  // dimensions, so a caller cannot name a small mailer and attach large numbers.
  // Custom dimensions outside 1cm..3m throw, which the handler maps to a 400.
  //
  // Left null when the seller said nothing. Writing a default mailer here would
  // look identical to "the seller chose a mailer", which buries the category
  // fallback: a sealed box listed without touching the picker would quote as a
  // polymailer forever. Null means "not stated", and the estimator infers it.
  let parcel: { presetId: string; dims: ParcelDims } | null = null;
  if (input.parcelPreset) {
    try {
      parcel = resolveParcel(input.parcelPreset, input.parcel);
    } catch (err) {
      throw err instanceof ParcelError ? new ListingError(err.message) : err;
    }
  }
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
      parcelPreset: parcel?.presetId ?? null,
      parcelLengthMm: parcel?.dims.lengthMm ?? null,
      parcelWidthMm: parcel?.dims.widthMm ?? null,
      parcelHeightMm: parcel?.dims.heightMm ?? null,
      category: input.category ? clampText(input.category, MAX_CATEGORY_LEN) : null,
      status: ListingStatus.QUEUED,
    },
  });
}

export interface UpdateListingInput {
  title?: string;
  /** Replaces the photo; empty string clears it. */
  imageUrl?: string;
  startingBid?: Micros;
  quantity?: number;
  /** null clears the weight back to "not stated". */
  weightGrams?: number | null;
  parcelPreset?: string;
  parcel?: Partial<ParcelDims>;
}

/**
 * Edit a listing that has not sold yet. Ownership-gated, and refused while an
 * auction is LIVE: the price and quantity on the block are what bidders are
 * bidding on, and changing them mid-flight would reprice an auction under the
 * people already in it. Won items are untouched either way, since fulfillment
 * snapshots everything it needs at win time.
 */
export async function updateListing(
  sellerId: string,
  listingId: string,
  patch: UpdateListingInput,
  prisma: PrismaClient = defaultPrisma,
): Promise<Listing> {
  await requireSeller(sellerId, prisma);
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.sellerId !== sellerId) throw new ListingError('That listing isn’t yours.');
  if (listing.status === ListingStatus.LIVE) throw new ListingError('This listing is in a live auction. Edit it after the auction ends.');
  if (listing.status === ListingStatus.SOLD) throw new ListingError('This listing has sold out and can’t be edited.');

  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    const title = clampText(patch.title, MAX_TITLE_LEN);
    if (!title) throw new ListingError('Title can’t be empty.');
    data.title = title;
  }
  if (patch.imageUrl !== undefined) {
    data.photos = patch.imageUrl && patch.imageUrl.length <= MAX_PHOTO_LEN ? [patch.imageUrl] : [];
  }
  if (patch.startingBid !== undefined) {
    if (patch.startingBid < 0n) throw new ListingError('Starting bid can’t be negative.');
    data.startingBid = patch.startingBid;
  }
  if (patch.quantity !== undefined) {
    // Wheel quantity is the prize pool, managed by the wheel builder; editing it
    // here would mint or destroy sellable spins without touching the prizes.
    if (listing.wheel) throw new ListingError('A randomizer’s quantity comes from its prizes.');
    data.quantity = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(patch.quantity)));
  }
  if (patch.weightGrams !== undefined) {
    data.weightGrams = patch.weightGrams === null ? null : Math.max(1, Math.round(patch.weightGrams));
  }
  if (patch.parcelPreset !== undefined) {
    let parcel: { presetId: string; dims: ParcelDims };
    try {
      parcel = resolveParcel(patch.parcelPreset, patch.parcel);
    } catch (err) {
      throw err instanceof ParcelError ? new ListingError(err.message) : err;
    }
    data.parcelPreset = parcel.presetId;
    data.parcelLengthMm = parcel.dims.lengthMm;
    data.parcelWidthMm = parcel.dims.widthMm;
    data.parcelHeightMm = parcel.dims.heightMm;
  }
  if (Object.keys(data).length === 0) return listing;
  return prisma.listing.update({ where: { id: listingId }, data });
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
 * QUEUED: the wheel must be set up BEFORE the auction runs, never mid-flight.
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
  // Writing the wheel REWRITES quantity from the pool total, which makes this the
  // one absolute stock write after creation. Re-POSTing the original pool on a
  // part-sold listing therefore restocked it out of thin air. Once a unit has
  // sold, the pool is fixed: consumeWheelPrize is the only thing allowed to
  // change it from then on.
  const sold = await prisma.order.count({ where: { listingId } });
  if (sold > 0) {
    throw new Error('this randomizer has already sold: its prize pool can no longer be edited');
  }
  const entries = normalizeWheelEntries(rawEntries);
  // A prize's weight is how many copies are in the pool, so the pool's total is
  // how many times this wheel can be auctioned. Setting the listing's quantity
  // to that total is what lets a wheel run again after each spin: settlement
  // returns a listing to QUEUED while stock remains (see orders.ts), and
  // consumeWheelPrize keeps the two in step as prizes are won.
  const stock = entries.reduce((n, e) => n + (e.weight && e.weight > 0 ? e.weight : 1), 0);
  await prisma.listing.update({
    where: { id: listingId },
    data: {
      wheel: entries.length ? (entries as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      ...(entries.length ? { quantity: Math.min(stock, MAX_QUANTITY) } : {}),
    },
  });
  return entries;
}

/**
 * Set (or clear, with null) the store "buy now" price on one of the seller's
 * listings. Ownership gated; allowed any time before the listing is SOLD: the
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
  // A randomizer is a roll, not an item: there is no prize until the wheel is
  // spun on auction close, so a fixed-price sale has nothing to hand over. It
  // also double-counted stock (see purchaseListing).
  if (buyNowPrice !== null && listing.wheel !== null) {
    throw new Error('a randomizer cannot be sold at a fixed price: it is won by bidding');
  }
  return prisma.listing.update({
    where: { id: listingId },
    data: { buyNowPrice },
  });
}
