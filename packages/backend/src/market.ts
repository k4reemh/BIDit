/**
 * The BIDit Marketplace: Grailed-style listings, decoupled from livestreams.
 * A seller lists an item with photos and their own flat shipping price per
 * region, then picks how it sells:
 *
 *  - Auction: a starting bid + duration. Buyers bid with funds reserved for
 *    bid + shipping to THEIR region; the win charges both. Rides the existing
 *    auction engine end to end (placeBid holds funds, the AuctionScheduler
 *    closes, settleAuction escrows, prepayMarketShipping pays the label).
 *  - Fixed price: a buy-now price, no auction. buyMarketItem claims the unit
 *    atomically, charges price + shipping in one purchase through the same
 *    escrow rails, and hands the seller an already-PAID shipment.
 */
import { AuctionStatus, ListingStatus, BidStatus } from '@prisma/client';
import { OrderStatus, splitAmount, formatUsdc } from '@bidit/shared';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { requireSeller } from './authz.js';
import { createAuction, startAuction, placeBid, type BidResult } from './auction.js';
import { getOrCreateUserAccount, getAvailableBalance, settleDirectSale } from './ledger.js';
import type { EscrowProvider } from './escrow.js';
import { createFulfillmentItem, prepayMarketShipping } from './fulfillment.js';
import { awardOrderPoints } from './points.js';
import { creditNftWin } from './nft.js';
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

export type MarketSaleMode = 'auction' | 'fixed';

export interface CreateMarketListingInput {
  title: string;
  description?: string;
  category?: string;
  photos: string[];
  /** 'auction' (default) runs a timed auction; 'fixed' lists at a set price. */
  saleMode?: MarketSaleMode;
  /** Auction mode. */
  startingBid?: bigint;
  durationHours?: number;
  /** Fixed mode: the buy-now price. */
  price?: bigint;
  /** region -> micros. At least one region required. */
  shipPrices: Partial<Record<MarketRegion, bigint>>;
}

export async function createMarketListing(
  sellerId: string,
  input: CreateMarketListingInput,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ listingId: string; auctionId: string | null; endsAt: Date | null; saleMode: MarketSaleMode }> {
  await requireSeller(sellerId, prisma);
  const saleMode: MarketSaleMode = input.saleMode === 'fixed' ? 'fixed' : 'auction';

  const title = (input.title ?? '').trim();
  if (title.length < 3) throw new MarketError('Give the listing a title (at least 3 characters).');
  const photos = (input.photos ?? []).filter((p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_PHOTO_LEN);
  if (photos.length === 0) throw new MarketError('Add at least one photo.');
  const ship: Partial<Record<MarketRegion, bigint>> = {};
  for (const region of MARKET_REGIONS) {
    const v = input.shipPrices?.[region];
    if (v === undefined || v === null) continue;
    if (v < 0n || v > MAX_SHIP_MICROS) throw new MarketError('Shipping prices must be between $0 and $500.');
    ship[region] = v;
  }
  if (Object.keys(ship).length === 0) throw new MarketError('Set a shipping price for at least one region.');

  if (saleMode === 'fixed') {
    const price = input.price ?? 0n;
    if (price < MIN_START_MICROS || price > MAX_START_MICROS) {
      throw new MarketError('Price must be between $1 and $100,000.');
    }
    const listing = await prisma.listing.create({
      data: {
        sellerId,
        title: title.slice(0, MAX_TITLE),
        description: input.description ? String(input.description).slice(0, MAX_DESC) : null,
        photos: photos.slice(0, MAX_PHOTOS),
        startingBid: price,
        buyNowPrice: price,
        category: input.category ? String(input.category).slice(0, 40) : null,
        status: ListingStatus.QUEUED,
        marketplace: true,
        shipPrices: Object.fromEntries(Object.entries(ship).map(([k, v]) => [k, v!.toString()])),
      },
    });
    return { listingId: listing.id, auctionId: null, endsAt: null, saleMode };
  }

  const startingBid = input.startingBid ?? 0n;
  if (startingBid < MIN_START_MICROS || startingBid > MAX_START_MICROS) {
    throw new MarketError('Starting bid must be between $1 and $100,000.');
  }
  const hours = Math.floor(input.durationHours ?? 0);
  if (!Number.isFinite(hours) || hours < MIN_DURATION_H || hours > MAX_DURATION_H) {
    throw new MarketError('Auction length must be between 1 hour and 7 days.');
  }

  const listing = await prisma.listing.create({
    data: {
      sellerId,
      title: title.slice(0, MAX_TITLE),
      description: input.description ? String(input.description).slice(0, MAX_DESC) : null,
      photos: photos.slice(0, MAX_PHOTOS),
      startingBid,
      category: input.category ? String(input.category).slice(0, 40) : null,
      status: ListingStatus.QUEUED,
      marketplace: true,
      shipPrices: Object.fromEntries(Object.entries(ship).map(([k, v]) => [k, v!.toString()])),
    },
  });
  const auctionId = await createAuction(
    {
      listingId: listing.id,
      startingBid,
      durationSeconds: hours * 3600,
      counterBidSeconds: Math.floor(MARKET_ANTI_SNIPE_MS / 1000),
    },
    prisma,
  );
  const snapshot = await startAuction(auctionId, clock, prisma);
  return { listingId: listing.id, auctionId, endsAt: snapshot.endsAt!, saleMode };
}

// ---------------------------------------------------------------------------
// Browse + detail
// ---------------------------------------------------------------------------

export type MarketSort = 'ending' | 'newest' | 'price_asc' | 'price_desc';
const PAGE_SIZE = 24;

export interface MarketCard {
  /** Route key: the auction id for auctions, the listing id for fixed-price. */
  id: string;
  saleMode: MarketSaleMode;
  auctionId: string | null;
  listingId: string;
  title: string;
  photo: string | null;
  category: string | null;
  currentBid: string | null; // micros as string (JSON-safe)
  startingBid: string;
  /** Fixed-price: the buy-now price in micros. */
  buyNow: string | null;
  bidCount: number;
  endsAt: number | null; // epoch ms; null for fixed-price
  sellerHandle: string;
  sellerAvatar: string | null;
  sellerVerified: boolean;
  shipPrices: Record<string, string>;
  /** NFT auction: digital delivery, no shipping. nftCount > 1 = batch. */
  nft: boolean;
  nftCount: number;
}

const SELLER_SELECT = { select: { handle: true, avatarUrl: true, sellerProfile: { select: { verified: true } } } } as const;

export async function listMarket(
  opts: { category?: string; sort?: MarketSort; q?: string; page?: number; mode?: MarketSaleMode },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ items: MarketCard[]; total: number; page: number; pageSize: number }> {
  // The feed is a merge of two sources (running auctions + active buy-now
  // listings), so pagination fetches each source's top window and merges in
  // memory. The page clamp bounds that window; 200 pages × 24 covers far more
  // inventory than exists.
  const page = Math.min(200, Math.max(0, Math.floor(opts.page ?? 0)));
  const window = (page + 1) * PAGE_SIZE;
  const sort: MarketSort = opts.sort ?? 'ending';
  const listingFilter = {
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.q ? { title: { contains: opts.q.slice(0, 80), mode: 'insensitive' as const } } : {}),
  };

  const auctionWhere = {
    status: AuctionStatus.RUNNING,
    endsAt: { gt: clock.now() },
    listing: { marketplace: true, ...listingFilter },
  };
  const fixedWhere = {
    marketplace: true,
    buyNowPrice: { not: null },
    status: ListingStatus.QUEUED,
    quantity: { gt: 0 },
    ...listingFilter,
  };
  const auctionOrderBy =
    sort === 'newest' ? [{ createdAt: 'desc' as const }]
    : sort === 'price_asc' ? [{ currentBid: { sort: 'asc' as const, nulls: 'first' as const } }, { startingBid: 'asc' as const }]
    : sort === 'price_desc' ? [{ currentBid: { sort: 'desc' as const, nulls: 'last' as const } }, { startingBid: 'desc' as const }]
    : [{ endsAt: 'asc' as const }];
  const fixedOrderBy =
    sort === 'price_asc' ? [{ buyNowPrice: 'asc' as const }, { createdAt: 'desc' as const }]
    : sort === 'price_desc' ? [{ buyNowPrice: 'desc' as const }, { createdAt: 'desc' as const }]
    : [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

  const wantAuctions = opts.mode !== 'fixed';
  const wantFixed = opts.mode !== 'auction';
  const [auctionTotal, fixedTotal, auctionRows, fixedRows] = await Promise.all([
    wantAuctions ? prisma.auction.count({ where: auctionWhere }) : 0,
    wantFixed ? prisma.listing.count({ where: fixedWhere }) : 0,
    wantAuctions
      ? prisma.auction.findMany({
          where: auctionWhere,
          orderBy: auctionOrderBy,
          take: window,
          include: {
            listing: { include: { seller: SELLER_SELECT, _count: { select: { nftAssets: true } } } },
            _count: { select: { bids: true } },
          },
        })
      : [],
    wantFixed
      ? prisma.listing.findMany({
          where: fixedWhere,
          orderBy: fixedOrderBy,
          take: window,
          include: { seller: SELLER_SELECT, _count: { select: { nftAssets: true } } },
        })
      : [],
  ]);

  type Entry = { card: MarketCard; created: number; ends: number | null; price: bigint };
  const entries: Entry[] = [
    ...auctionRows.map((a): Entry => ({
      created: a.listing.createdAt.getTime(),
      ends: a.endsAt!.getTime(),
      price: a.currentBid ?? a.startingBid,
      card: {
        id: a.id,
        saleMode: 'auction',
        auctionId: a.id,
        listingId: a.listingId,
        title: a.listing.title,
        photo: a.listing.photos[0] ?? null,
        category: a.listing.category,
        currentBid: a.currentBid?.toString() ?? null,
        startingBid: a.startingBid.toString(),
        buyNow: null,
        bidCount: a._count.bids,
        endsAt: a.endsAt!.getTime(),
        sellerHandle: a.listing.seller.handle,
        sellerAvatar: a.listing.seller.avatarUrl,
        sellerVerified: a.listing.seller.sellerProfile?.verified ?? false,
        shipPrices: (a.listing.shipPrices ?? {}) as Record<string, string>,
        nft: a.listing.nft,
        nftCount: a.listing._count.nftAssets,
      },
    })),
    ...fixedRows.map((l): Entry => ({
      created: l.createdAt.getTime(),
      ends: null,
      price: l.buyNowPrice!,
      card: {
        id: l.id,
        saleMode: 'fixed',
        auctionId: null,
        listingId: l.id,
        title: l.title,
        photo: l.photos[0] ?? null,
        category: l.category,
        currentBid: null,
        startingBid: l.buyNowPrice!.toString(),
        buyNow: l.buyNowPrice!.toString(),
        bidCount: 0,
        endsAt: null,
        sellerHandle: l.seller.handle,
        sellerAvatar: l.seller.avatarUrl,
        sellerVerified: l.seller.sellerProfile?.verified ?? false,
        shipPrices: (l.shipPrices ?? {}) as Record<string, string>,
        nft: l.nft,
        nftCount: l._count.nftAssets,
      },
    })),
  ];

  entries.sort((a, b) => {
    if (sort === 'newest') return b.created - a.created;
    if (sort === 'price_asc') return a.price < b.price ? -1 : a.price > b.price ? 1 : b.created - a.created;
    if (sort === 'price_desc') return a.price > b.price ? -1 : a.price < b.price ? 1 : b.created - a.created;
    // 'ending': live countdowns first (soonest up top), buy-now after, newest first.
    if (a.ends !== null && b.ends !== null) return a.ends - b.ends;
    if (a.ends !== null) return -1;
    if (b.ends !== null) return 1;
    return b.created - a.created;
  });

  return {
    items: entries.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).map((e) => e.card),
    total: auctionTotal + fixedTotal,
    page,
    pageSize: PAGE_SIZE,
  };
}

/** The viewer's own lane: their region + the seller's price for it (null when
 *  the seller doesn't ship there or the viewer has no address yet). */
async function viewerLane(
  viewerUserId: string,
  shipPricesRaw: unknown,
  prisma: PrismaClient,
): Promise<{ region: MarketRegion; shippingC: string | null; hasAddress: boolean }> {
  const u = await prisma.user.findUnique({ where: { id: viewerUserId }, select: { shippingAddress: true } });
  const dest = decryptPii<{ country?: string }>(u?.shippingAddress ?? null);
  const hasAddress = !!dest?.country;
  const region = regionForCountry(dest?.country);
  const prices = parseShipPrices(shipPricesRaw);
  return {
    region,
    shippingC: hasAddress ? (prices[region] !== undefined ? prices[region]!.toString() : null) : null,
    hasAddress,
  };
}

export async function getMarketItem(
  id: string,
  viewerUserId: string | null,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  const a = await prisma.auction.findUnique({
    where: { id },
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
  if (!a) return getMarketFixedItem(id, viewerUserId, clock, prisma);
  if (!a.listing.marketplace) return null;
  const now = clock.now();

  let viewer: { region: MarketRegion; shippingC: string | null; hasAddress: boolean; leading: boolean } | null = null;
  if (viewerUserId) {
    const lane = await viewerLane(viewerUserId, a.listing.shipPrices, prisma);
    viewer = { ...lane, leading: a.currentLeaderUserId === viewerUserId };
  }

  return {
    id: a.id,
    saleMode: 'auction' as MarketSaleMode,
    auctionId: a.id,
    listingId: a.listingId,
    status: a.status as string,
    available: a.status === AuctionStatus.RUNNING,
    buyNow: null as string | null,
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

/** Fixed-price marketplace item detail (the id is a listing id, no auction). */
async function getMarketFixedItem(
  listingId: string,
  viewerUserId: string | null,
  clock: Clock,
  prisma: PrismaClient,
) {
  const l = await prisma.listing.findUnique({
    where: { id: listingId },
    include: {
      seller: { select: { id: true, handle: true, avatarUrl: true, sellerProfile: { select: { verified: true } } } },
      nftAssets: { select: { name: true, image: true, collection: true } },
    },
  });
  if (!l || !l.marketplace || l.buyNowPrice === null) return null;

  let viewer: { region: MarketRegion; shippingC: string | null; hasAddress: boolean; leading: boolean } | null = null;
  if (viewerUserId) {
    const lane = await viewerLane(viewerUserId, l.shipPrices, prisma);
    viewer = { ...lane, leading: false };
  }

  return {
    id: l.id,
    saleMode: 'fixed' as MarketSaleMode,
    auctionId: null,
    listingId: l.id,
    status: l.status as string,
    available: l.status === ListingStatus.QUEUED && l.quantity > 0,
    buyNow: l.buyNowPrice.toString() as string | null,
    title: l.title,
    description: l.description,
    category: l.category,
    photos: l.photos,
    startingBid: l.buyNowPrice.toString(),
    currentBid: null as string | null,
    minIncrementBps: 0,
    minIncrementFloor: '0',
    endsAt: null as number | null,
    serverNow: clock.now().getTime(),
    seller: {
      id: l.seller.id,
      handle: l.seller.handle,
      avatarUrl: l.seller.avatarUrl,
      verified: l.seller.sellerProfile?.verified ?? false,
    },
    shipPrices: (l.shipPrices ?? {}) as Record<string, string>,
    nft: l.nft,
    nftAssets: l.nftAssets.map((n) => ({ name: n.name, image: n.image, collection: n.collection })),
    bids: [] as { handle: string; amount: string; at: number; status: string }[],
    viewer,
  };
}

/** A seller's own marketplace listings: auctions and buy-now, newest first. */
export async function listMyMarket(sellerId: string, prisma: PrismaClient = defaultPrisma) {
  const [auctions, fixed] = await Promise.all([
    prisma.auction.findMany({
      where: { listing: { marketplace: true, sellerId } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { listing: { select: { title: true, photos: true, category: true } }, _count: { select: { bids: true } } },
    }),
    prisma.listing.findMany({
      where: { marketplace: true, sellerId, buyNowPrice: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, title: true, photos: true, status: true, buyNowPrice: true, quantity: true, createdAt: true },
    }),
  ]);
  const rows = [
    ...auctions.map((a) => ({
      id: a.id,
      saleMode: 'auction' as MarketSaleMode,
      auctionId: a.id,
      listingId: a.listingId,
      title: a.listing.title,
      photo: a.listing.photos[0] ?? null,
      status: a.status as string,
      currentBid: a.currentBid?.toString() ?? null,
      startingBid: a.startingBid.toString(),
      buyNow: null as string | null,
      bidCount: a._count.bids,
      endsAt: a.endsAt?.getTime() ?? null,
      createdAt: a.createdAt.getTime(),
    })),
    ...fixed.map((l) => ({
      id: l.id,
      saleMode: 'fixed' as MarketSaleMode,
      auctionId: null as string | null,
      listingId: l.id,
      title: l.title,
      photo: l.photos[0] ?? null,
      status: l.status as string,
      currentBid: null as string | null,
      startingBid: l.buyNowPrice!.toString(),
      buyNow: l.buyNowPrice!.toString(),
      bidCount: 0,
      endsAt: null as number | null,
      createdAt: l.createdAt.getTime(),
    })),
  ];
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return rows.slice(0, 50);
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

// ---------------------------------------------------------------------------
// Buy now (fixed-price purchase)
// ---------------------------------------------------------------------------

export interface MarketBuyOptions {
  /** true = pay the seller 100% instantly (BIDIT_PAYOUT_MODE=direct); false = escrow (95/5). */
  directPayout: boolean;
  escrow?: EscrowProvider;
}

/**
 * Buy a fixed-price marketplace listing outright: one purchase charges the
 * price AND the seller's flat shipping for the buyer's region.
 *
 * Claim-then-charge, mirroring the store flow: the unit is claimed with an
 * atomic guarded decrement (two buyers can't get the last unit, a delisted or
 * sold row can't be bought), the price moves through the same escrow rails as
 * an auction win, and any charge failure rolls the claim back. Shipping is then
 * prepaid exactly like a marketplace auction win: the seller gets an
 * already-PAID shipment, the buyer never sees Ready-to-ship. NFT listings
 * deliver to the buyer's BIDit account instantly and pay the seller at once.
 */
export async function buyMarketItem(
  buyerId: string,
  listingId: string,
  opts: MarketBuyOptions,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ orderId: string; amount: string; shippingC: string; nft: boolean }> {
  const l = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!l || !l.marketplace || l.buyNowPrice === null || l.wheel !== null) {
    throw new MarketError('That listing was not found.');
  }
  if (l.sellerId === buyerId) throw new MarketError('You can’t buy your own listing.');
  if (l.status !== ListingStatus.QUEUED || l.quantity <= 0) {
    throw new MarketError('This item is no longer available.');
  }

  // Physical items ship at the seller's flat price for the buyer's region, paid
  // together with the item. NFTs deliver to the buyer's BIDit account instead.
  let shippingC = 0n;
  if (!l.nft) {
    const u = await prisma.user.findUnique({ where: { id: buyerId }, select: { shippingAddress: true } });
    const dest = decryptPii<{ country?: string }>(u?.shippingAddress ?? null);
    if (!dest?.country) throw new MarketError('Add your shipping address before buying (Account → Payments & Shipping).');
    const region = regionForCountry(dest.country);
    const lane = parseShipPrices(l.shipPrices)[region];
    if (lane === undefined) throw new MarketError('This seller doesn’t ship to your region.');
    shippingC = lane;
  }

  const amount = l.buyNowPrice;
  const buyerAccountId = await getOrCreateUserAccount(buyerId, prisma);

  // Item + shipping are one purchase: require the whole total up front so the
  // charge can't succeed on the item and then bounce on the shipping.
  const available = await getAvailableBalance(buyerAccountId, prisma);
  if (available < amount + shippingC) {
    throw new MarketError(
      `You need $${formatUsdc(amount + shippingC)} available: $${formatUsdc(amount)} + $${formatUsdc(shippingC)} shipping.`,
    );
  }

  const sale = await settleMarketSale({ listingId, buyerId, amount, shippingC, via: 'buy' }, opts, clock, prisma);
  return { orderId: sale.orderId, amount: amount.toString(), shippingC: shippingC.toString(), nft: sale.nft };
}

export interface SettleMarketSaleParams {
  listingId: string;
  buyerId: string;
  /** The price actually charged: the buy-now price, or the accepted offer. */
  amount: bigint;
  shippingC: bigint;
  via: 'buy' | 'offer';
}

/**
 * The shared sale pipeline for buy-now purchases and accepted offers: claim the
 * unit atomically, move the money through the same escrow/direct rails as an
 * auction win (with full rollback on any charge failure), retire the listing,
 * award points, deliver (instant NFT credit or fulfillment + prepaid shipment),
 * and notify both sides. Callers are responsible for validation and any funds
 * pre-checks; the claim + charge here are the source of truth under races.
 */
export async function settleMarketSale(
  params: SettleMarketSaleParams,
  opts: MarketBuyOptions,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ orderId: string; nft: boolean }> {
  const { listingId, buyerId, amount, shippingC, via } = params;
  const l = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!l) throw new MarketError('That listing was not found.');
  const sellerId = l.sellerId;
  const buyerAccountId = await getOrCreateUserAccount(buyerId, prisma);
  const sellerAccountId = await getOrCreateUserAccount(sellerId, prisma);

  // Claim the unit. The WHERE doubles as the availability check, so a race with
  // another buyer or with a delist resolves to exactly one winner.
  const claimed = await prisma.listing.updateMany({
    where: { id: listingId, status: ListingStatus.QUEUED, marketplace: true, buyNowPrice: { not: null }, quantity: { gt: 0 } },
    data: { quantity: { decrement: 1 } },
  });
  if (claimed.count !== 1) throw new MarketError('This item is no longer available.');

  const now = clock.now();
  const { platformFee, sellerProceeds } = opts.directPayout
    ? { platformFee: 0n, sellerProceeds: amount }
    : splitAmount(amount);

  const created = await prisma.order.create({
    data: {
      auctionId: null,
      listingId,
      buyerId,
      sellerId,
      amount,
      platformFee,
      sellerProceeds,
      status: OrderStatus.PENDING_SETTLEMENT,
      ...(opts.directPayout ? { lockedAt: now, releasedAt: now } : {}),
    },
  });

  // Charge the buyer. Nothing moves on a throw, so any failure can undo the
  // claim and drop the empty order (mirrors purchaseListing).
  try {
    if (opts.directPayout) {
      await settleDirectSale({ buyerAccountId, sellerAccountId, amount, orderId: created.id, auctionId: null }, prisma);
      await prisma.order.update({ where: { id: created.id }, data: { status: OrderStatus.RELEASED } });
    } else {
      if (!opts.escrow) throw new MarketError('Purchases are unavailable right now.');
      const ref = await opts.escrow.lock(created.id, amount, buyerAccountId, sellerAccountId);
      await prisma.order.update({
        where: { id: created.id },
        data: {
          status: OrderStatus.LOCKED,
          escrowRef: ref,
          lockedAt: now,
          // Shipping is prepaid below, which starts the seller's ship clock; no
          // buyer-side deadline is needed here (same reasoning as store buys).
          noShipDeadline: null,
        },
      });
    }
  } catch (err) {
    await prisma.order.delete({ where: { id: created.id } }).catch(() => {});
    await prisma.listing.update({ where: { id: listingId }, data: { quantity: { increment: 1 } } }).catch(() => {});
    throw err;
  }

  // Last unit gone: retire the listing.
  const after = await prisma.listing.findUnique({ where: { id: listingId }, select: { quantity: true } });
  if (after && after.quantity <= 0) {
    await prisma.listing.update({ where: { id: listingId }, data: { status: ListingStatus.SOLD } });
  }

  // BIDit Points: buyer 100×/seller 20× per $1, keyed by orderId (idempotent).
  await awardOrderPoints({ orderId: created.id, buyerId, sellerId, amount }, prisma);

  const price = `$${formatUsdc(amount)}`;

  if (l.nft) {
    // Digital delivery is instant and provable, so the seller is paid at once
    // (mirrors the NFT auction settle). creditNftWin notifies the buyer.
    await creditNftWin({ listingId, buyerId, sellerId, title: l.title, bought: true }, prisma);
    if (!opts.directPayout && opts.escrow) {
      const won = await prisma.order.updateMany({
        where: { id: created.id, status: OrderStatus.LOCKED },
        data: { status: OrderStatus.RELEASED, releasedAt: clock.now() },
      });
      if (won.count === 1) await opts.escrow.release(created.id);
    }
    await notify(
      {
        userId: sellerId,
        kind: 'sold',
        title: `Marketplace sale: ${l.title}`,
        body: `Sold for ${price}${via === 'offer' ? ' (accepted offer)' : ''}. Funds are in your balance.`,
        href: '/seller/orders',
      },
      prisma,
    );
    return { orderId: created.id, nft: true };
  }

  // Physical: the same fulfillment entry as any sale, then the prepaid shipment.
  await createFulfillmentItem(
    {
      orderId: created.id,
      buyerId,
      sellerId,
      listingId,
      title: l.title,
      photo: l.photos[0] ?? null,
      weightGrams: l.weightGrams,
      parcelPreset: l.parcelPreset,
      parcelLengthMm: l.parcelLengthMm,
      parcelWidthMm: l.parcelWidthMm,
      parcelHeightMm: l.parcelHeightMm,
      amount,
    },
    clock,
    prisma,
  );
  await prepayMarketShipping({ orderId: created.id, buyerId, sellerId, shippingC }, clock, prisma);

  await notify(
    {
      userId: buyerId,
      kind: 'won',
      title: via === 'offer' ? `Offer accepted: ${l.title} is yours` : `You bought ${l.title}`,
      body: `Paid ${price}${shippingC > 0n ? ` plus $${formatUsdc(shippingC)} shipping` : ''}. The seller ships it to your address.`,
      href: '/purchases',
    },
    prisma,
  );
  await notify(
    {
      userId: sellerId,
      kind: 'sold',
      title: `Marketplace sale: ${l.title}`,
      body: `Sold for ${price}${via === 'offer' ? ' (accepted offer)' : ''}. Shipping is paid; print the label and send it.`,
      href: '/seller/orders',
    },
    prisma,
  );

  return { orderId: created.id, nft: false };
}

/** Take down an unsold buy-now listing. Guarded so it can't race a purchase:
 *  once a buyer's claim lands, the quantity check fails and the delist errors. */
export async function delistMarketListing(
  sellerId: string,
  listingId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  const claimed = await prisma.listing.updateMany({
    where: {
      id: listingId,
      sellerId,
      marketplace: true,
      buyNowPrice: { not: null },
      status: ListingStatus.QUEUED,
      quantity: { gt: 0 },
    },
    data: { status: ListingStatus.CANCELED },
  });
  if (claimed.count !== 1) throw new MarketError('Only an active buy-now listing can be taken down.');
  // Free any custody NFTs the listing was holding.
  await prisma.nftAsset.updateMany({ where: { listingId }, data: { listingId: null } });
}
