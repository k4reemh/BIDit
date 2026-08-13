/**
 * The BIDit Marketplace: Grailed-style timed auctions, decoupled from
 * livestreams. Sellers list an item with photos, a starting bid, a duration
 * (hours to days), and their own flat shipping price per region; buyers bid with
 * funds reserved for bid + shipping to THEIR region, and the win charges both.
 *
 * It rides the existing auction engine end to end: placeBid holds funds, the
 * AuctionScheduler closes due auctions, settleAuction escrows the bid, and
 * prepayMarketShipping (fulfillment.ts) turns the shipping part of the win into
 * an already-PAID shipment.
 */
import { AuctionStatus, ListingStatus, BidStatus } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { requireSeller } from './authz.js';
import { createAuction, startAuction, placeBid, type BidResult } from './auction.js';
import { decryptPii } from './pii.js';
import { notify } from './notifications.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

export class MarketError extends Error {}

// ---------------------------------------------------------------------------
// Regions: the fixed set a seller prices. A buyer's region comes from their
// shipping-address country; a region the seller didn't price = doesn't ship there.
// ---------------------------------------------------------------------------

export const MARKET_REGIONS = ['US', 'CA', 'UK', 'EU', 'ASIA', 'OTHER'] as const;
export type MarketRegion = (typeof MARKET_REGIONS)[number];

const EU_COUNTRIES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','CH','NO','IS','LI','MC','AD','SM',
]);
const ASIA_COUNTRIES = new Set([
  'JP','KR','CN','HK','TW','SG','MY','TH','VN','PH','ID','IN','AE','SA','QA','KW','BH','OM','IL','TR',
]);

export function regionForCountry(countryRaw: string | null | undefined): MarketRegion {
  const c = (countryRaw ?? '').trim().toUpperCase();
  if (c === 'US' || c === 'USA' || c === 'UNITED STATES') return 'US';
  if (c === 'CA' || c === 'CANADA') return 'CA';
  if (c === 'GB' || c === 'UK' || c === 'UNITED KINGDOM') return 'UK';
  if (EU_COUNTRIES.has(c)) return 'EU';
  if (ASIA_COUNTRIES.has(c)) return 'ASIA';
  return 'OTHER';
}

/** Parse a Listing.shipPrices JSON into a region -> micros map (lenient: bad
 *  entries dropped, so a hand-edited row can't crash the grid). */
export function parseShipPrices(raw: unknown): Partial<Record<MarketRegion, bigint>> {
  const out: Partial<Record<MarketRegion, bigint>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const region of MARKET_REGIONS) {
    const v = (raw as Record<string, unknown>)[region];
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    try {
      const micros = BigInt(v);
      if (micros >= 0n && micros <= MAX_SHIP_MICROS) out[region] = micros;
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Create a marketplace listing (listing + running auction in one step)
// ---------------------------------------------------------------------------

const MAX_TITLE = 90;
const MAX_DESC = 2000;
const MAX_PHOTOS = 5;
const MAX_PHOTO_LEN = 700_000;
const MIN_DURATION_H = 1;
const MAX_DURATION_H = 7 * 24;
const MIN_START_MICROS = 1_000_000n; // $1
const MAX_START_MICROS = 100_000_000_000n; // $100k
const MAX_SHIP_MICROS = 500_000_000n; // $500 shipping cap per region
/** Marketplace anti-snipe: a bid in the last 2 minutes extends to 2 minutes. */
export const MARKET_ANTI_SNIPE_MS = 2 * 60 * 1000;

export interface CreateMarketListingInput {
  title: string;
  description?: string;
  category?: string;
  photos: string[];
  startingBid: bigint;
  durationHours: number;
  /** region -> micros. At least one region required. */
  shipPrices: Partial<Record<MarketRegion, bigint>>;
}

export async function createMarketListing(
  sellerId: string,
  input: CreateMarketListingInput,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ listingId: string; auctionId: string; endsAt: Date }> {
  await requireSeller(sellerId, prisma);

  const title = (input.title ?? '').trim();
  if (title.length < 3) throw new MarketError('Give the listing a title (at least 3 characters).');
  const photos = (input.photos ?? []).filter((p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_PHOTO_LEN);
  if (photos.length === 0) throw new MarketError('Add at least one photo.');
  if (input.startingBid < MIN_START_MICROS || input.startingBid > MAX_START_MICROS) {
    throw new MarketError('Starting bid must be between $1 and $100,000.');
  }
  const hours = Math.floor(input.durationHours);
  if (!Number.isFinite(hours) || hours < MIN_DURATION_H || hours > MAX_DURATION_H) {
    throw new MarketError('Auction length must be between 1 hour and 7 days.');
  }
  const ship: Partial<Record<MarketRegion, bigint>> = {};
  for (const region of MARKET_REGIONS) {
    const v = input.shipPrices?.[region];
    if (v === undefined || v === null) continue;
    if (v < 0n || v > MAX_SHIP_MICROS) throw new MarketError('Shipping prices must be between $0 and $500.');
    ship[region] = v;
  }
  if (Object.keys(ship).length === 0) throw new MarketError('Set a shipping price for at least one region.');

  const listing = await prisma.listing.create({
    data: {
      sellerId,
      title: title.slice(0, MAX_TITLE),
      description: input.description ? String(input.description).slice(0, MAX_DESC) : null,
      photos: photos.slice(0, MAX_PHOTOS),
      startingBid: input.startingBid,
      category: input.category ? String(input.category).slice(0, 40) : null,
      status: ListingStatus.QUEUED,
      marketplace: true,
      shipPrices: Object.fromEntries(Object.entries(ship).map(([k, v]) => [k, v!.toString()])),
    },
  });
  const auctionId = await createAuction(
    {
      listingId: listing.id,
      startingBid: input.startingBid,
      durationSeconds: hours * 3600,
      counterBidSeconds: Math.floor(MARKET_ANTI_SNIPE_MS / 1000),
    },
    prisma,
  );
  const snapshot = await startAuction(auctionId, clock, prisma);
  return { listingId: listing.id, auctionId, endsAt: snapshot.endsAt! };
}

// ---------------------------------------------------------------------------
// Browse + detail
// ---------------------------------------------------------------------------

export type MarketSort = 'ending' | 'newest' | 'price_asc' | 'price_desc';
const PAGE_SIZE = 24;

export interface MarketCard {
  auctionId: string;
  listingId: string;
  title: string;
  photo: string | null;
  category: string | null;
  currentBid: string | null; // micros as string (JSON-safe)
  startingBid: string;
  bidCount: number;
  endsAt: number; // epoch ms
  sellerHandle: string;
  sellerAvatar: string | null;
  sellerVerified: boolean;
  shipPrices: Record<string, string>;
  /** NFT auction: digital delivery, no shipping. nftCount > 1 = batch. */
  nft: boolean;
  nftCount: number;
}

export async function listMarket(
  opts: { category?: string; sort?: MarketSort; q?: string; page?: number },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ items: MarketCard[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(0, Math.floor(opts.page ?? 0));
  const where = {
    status: AuctionStatus.RUNNING,
    endsAt: { gt: clock.now() },
    listing: {
      marketplace: true,
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.q ? { title: { contains: opts.q.slice(0, 80), mode: 'insensitive' as const } } : {}),
    },
  };
  const orderBy =
    opts.sort === 'newest' ? [{ createdAt: 'desc' as const }]
    : opts.sort === 'price_asc' ? [{ currentBid: { sort: 'asc' as const, nulls: 'first' as const } }, { startingBid: 'asc' as const }]
    : opts.sort === 'price_desc' ? [{ currentBid: { sort: 'desc' as const, nulls: 'last' as const } }, { startingBid: 'desc' as const }]
    : [{ endsAt: 'asc' as const }];

  const [total, rows] = await Promise.all([
    prisma.auction.count({ where }),
    prisma.auction.findMany({
      where,
      orderBy,
      skip: page * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        listing: {
          include: {
            seller: { select: { handle: true, avatarUrl: true, sellerProfile: { select: { verified: true } } } },
            _count: { select: { nftAssets: true } },
          },
        },
        _count: { select: { bids: true } },
      },
    }),
  ]);

  return {
    items: rows.map((a) => ({
      auctionId: a.id,
      listingId: a.listingId,
      title: a.listing.title,
      photo: a.listing.photos[0] ?? null,
      category: a.listing.category,
      currentBid: a.currentBid?.toString() ?? null,
      startingBid: a.startingBid.toString(),
      bidCount: a._count.bids,
      endsAt: a.endsAt!.getTime(),
      sellerHandle: a.listing.seller.handle,
      sellerAvatar: a.listing.seller.avatarUrl,
      sellerVerified: a.listing.seller.sellerProfile?.verified ?? false,
      shipPrices: (a.listing.shipPrices ?? {}) as Record<string, string>,
      nft: a.listing.nft,
      nftCount: a.listing._count.nftAssets,
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
  };
}

export async function getMarketItem(
  auctionId: string,
  viewerUserId: string | null,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  const a = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: {
      listing: {
        include: {
          seller: { select: { id: true, handle: true, avatarUrl: true, sellerProfile: { select: { verified: true } } } },
          nftAssets: { select: { name: true, image: true, collection: true } },
        },
      },
      bids: { orderBy: { createdAt: 'desc' }, take: 12, include: { user: { select: { handle: true } } } },
    },
  });
  if (!a || !a.listing.marketplace) return null;
  const now = clock.now();

  // The viewer's own lane: their region + the seller's price for it (null when
  // the seller doesn't ship there or the viewer has no address yet).
  let viewer: { region: MarketRegion; shippingC: string | null; hasAddress: boolean; leading: boolean } | null = null;
  if (viewerUserId) {
    const u = await prisma.user.findUnique({ where: { id: viewerUserId }, select: { shippingAddress: true } });
    const dest = decryptPii<{ country?: string }>(u?.shippingAddress ?? null);
    const hasAddress = !!dest?.country;
    const region = regionForCountry(dest?.country);
    const prices = parseShipPrices(a.listing.shipPrices);
    viewer = {
      region,
      shippingC: hasAddress ? (prices[region] !== undefined ? prices[region]!.toString() : null) : null,
      hasAddress,
      leading: a.currentLeaderUserId === viewerUserId,
    };
  }

  return {
    auctionId: a.id,
    listingId: a.listingId,
    status: a.status,
    title: a.listing.title,
    description: a.listing.description,
    category: a.listing.category,
    photos: a.listing.photos,
    startingBid: a.startingBid.toString(),
    currentBid: a.currentBid?.toString() ?? null,
    minIncrementBps: a.minIncrementBps,
    minIncrementFloor: a.minIncrementFloor.toString(),
    endsAt: a.endsAt?.getTime() ?? null,
    serverNow: now.getTime(),
    seller: {
      id: a.listing.seller.id,
      handle: a.listing.seller.handle,
      avatarUrl: a.listing.seller.avatarUrl,
      verified: a.listing.seller.sellerProfile?.verified ?? false,
    },
    shipPrices: (a.listing.shipPrices ?? {}) as Record<string, string>,
    nft: a.listing.nft,
    nftAssets: a.listing.nftAssets.map((n) => ({ name: n.name, image: n.image, collection: n.collection })),
    bids: a.bids.map((b) => ({
      handle: b.user.handle,
      amount: b.amount.toString(),
      at: b.createdAt.getTime(),
      status: b.status,
    })),
    viewer,
  };
}

/** A seller's own marketplace listings (running + recently ended). */
export async function listMyMarket(sellerId: string, prisma: PrismaClient = defaultPrisma) {
  const rows = await prisma.auction.findMany({
    where: { listing: { marketplace: true, sellerId } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { listing: { select: { title: true, photos: true, category: true } }, _count: { select: { bids: true } } },
  });
  return rows.map((a) => ({
    auctionId: a.id,
    listingId: a.listingId,
    title: a.listing.title,
    photo: a.listing.photos[0] ?? null,
    status: a.status,
    currentBid: a.currentBid?.toString() ?? null,
    startingBid: a.startingBid.toString(),
    bidCount: a._count.bids,
    endsAt: a.endsAt?.getTime() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Bidding
// ---------------------------------------------------------------------------

export async function placeMarketBid(
  userId: string,
  auctionId: string,
  amount: bigint,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<BidResult & { shippingC?: string }> {
  const a = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: { listing: { select: { marketplace: true, nft: true, sellerId: true, shipPrices: true, title: true } } },
  });
  if (!a || !a.listing.marketplace) throw new MarketError('That listing was not found.');
  if (a.listing.sellerId === userId) throw new MarketError('You can’t bid on your own listing.');

  // NFT auctions deliver digitally to the winner's BIDit account: no shipping,
  // no address needed. Physical listings reserve shipping to the bidder's
  // region, so an address is a precondition of bidding there.
  let shippingC = 0n;
  if (!a.listing.nft) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { shippingAddress: true } });
    const dest = decryptPii<{ country?: string }>(u?.shippingAddress ?? null);
    if (!dest?.country) throw new MarketError('Add your shipping address before bidding (Account → Payments & Shipping).');
    const region = regionForCountry(dest.country);
    const prices = parseShipPrices(a.listing.shipPrices);
    const price = prices[region];
    if (price === undefined) throw new MarketError('This seller doesn’t ship to your region.');
    shippingC = price;
  }

  const result = await placeBid(
    { auctionId, userId, amount, shippingC, antiSnipeFloorMs: MARKET_ANTI_SNIPE_MS },
    clock,
    prisma,
  );

  if (result.ok && result.previousLeaderUserId && result.previousLeaderUserId !== userId) {
    await notify(
      {
        userId: result.previousLeaderUserId,
        kind: 'outbid',
        title: `You were outbid on ${a.listing.title}`,
        body: 'Your funds are released. Jump back in before it ends.',
        href: `/marketplace/${auctionId}`,
        email: false,
      },
      prisma,
    ).catch(() => {});
  }
  return shippingC !== undefined && result.ok ? { ...result, shippingC: shippingC.toString() } : result;
}
