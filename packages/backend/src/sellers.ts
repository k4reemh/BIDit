/**
 * Seller / coin linkage. A Pump.fun coin address is the bridge between a stream
 * and a seller's BIDit auctions: a seller's SellerProfile.pumpCoinAddress links
 * the coin shown in the extension to their room (their userId).
 */
import { AuctionStatus, ListingStatus, usdc } from '@bidit/shared';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { getOrCreateUserAccount } from './ledger.js';
import { createAuction, startAuction } from './auction.js';
import { requireSeller } from './authz.js';
import { systemClock, type Clock } from './clock.js';

export const DEMO_TITLE = 'Charizard — Base Set Holo';
export const DEMO_IMAGE = 'https://images.pokemontcg.io/base1/4_hires.png';

export interface ResolvedRoom {
  room: string;
  sellerHandle: string;
}

/** Map a Pump.fun coin address -> the seller's room, if a seller has linked it.
 *  A coin belongs to exactly one seller (see claimCoin), so this is unambiguous;
 *  the `orderBy` is only a safety net for any legacy rows that predate that rule
 *  — the most recently created profile (the active seller) wins. */
export async function resolveRoomByCoin(
  coinAddress: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<ResolvedRoom | null> {
  const coin = coinAddress.trim();
  if (!coin) return null;
  const profile = await prisma.sellerProfile.findFirst({
    where: { pumpCoinAddress: coin },
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { id: true, handle: true } } },
  });
  if (!profile) return null;
  return { room: profile.user.id, sellerHandle: profile.user.handle };
}

/** Give `coinAddress` exclusively to `sellerId`, releasing it from anyone else who
 *  had claimed it. Without this a coin re-used across accounts (repeat signups, the
 *  demo-seed path) leaves multiple profiles pointing at it and resolveRoomByCoin
 *  can hand a buyer a *stale* seller's room — so they never see the active seller's
 *  auctions. Claiming the coin makes the mapping one-to-one and resolution correct. */
async function claimCoin(sellerId: string, coin: string, prisma: PrismaClient): Promise<void> {
  await prisma.sellerProfile.updateMany({
    where: { pumpCoinAddress: coin, NOT: { userId: sellerId } },
    data: { pumpCoinAddress: null },
  });
}

/** Link a coin to a seller (creating the user/profile if needed). */
export async function linkCoinToSeller(
  coinAddress: string,
  handle: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<ResolvedRoom> {
  const user =
    (await prisma.user.findUnique({ where: { handle } })) ??
    (await prisma.user.create({ data: { handle, role: 'seller' } }));
  await getOrCreateUserAccount(user.id, prisma);
  const coin = coinAddress.trim();
  if (coin) await claimCoin(user.id, coin, prisma);
  await prisma.sellerProfile.upsert({
    where: { userId: user.id },
    update: { pumpCoinAddress: coin, verified: true },
    create: { userId: user.id, pumpCoinAddress: coin, verified: true },
  });
  return { room: user.id, sellerHandle: user.handle };
}

/** Ensure a running auction exists for a seller; returns its id (reuses if live). */
export async function seedRunningAuction(
  sellerId: string,
  opts: { title?: string; imageUrl?: string; startingBid?: string; durationSeconds?: number } = {},
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<string> {
  const running = await prisma.auction.findFirst({
    where: { status: AuctionStatus.RUNNING, listing: { sellerId } },
    select: { id: true },
  });
  if (running) return running.id;

  const startingBid = opts.startingBid ?? '5';
  const listing = await prisma.listing.create({
    data: {
      sellerId,
      title: opts.title ?? DEMO_TITLE,
      photos: opts.imageUrl ? [opts.imageUrl] : [DEMO_IMAGE],
      startingBid: usdc(startingBid),
      status: 'QUEUED',
    },
  });
  const auctionId = await createAuction(
    {
      listingId: listing.id,
      startingBid: usdc(startingBid),
      durationSeconds: opts.durationSeconds ?? 60,
      counterBidSeconds: 10,
    },
    prisma,
  );
  await startAuction(auctionId, clock, prisma);
  return auctionId;
}

/** Seller sets the Pump coin they stream on. Does NOT grant verification. */
export async function setSellerCoin(
  sellerId: string,
  coinAddress: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  const coin = coinAddress.trim();
  if (coin) await claimCoin(sellerId, coin, prisma);
  await prisma.sellerProfile.upsert({
    where: { userId: sellerId },
    update: { pumpCoinAddress: coin || null },
    create: { userId: sellerId, pumpCoinAddress: coin || null },
  });
}

/** The seller's live "Start Auction" control: spin up an auction on a queued item. */
export async function startAuctionFromListing(
  listingId: string,
  opts: { durationSeconds?: number; counterBidSeconds?: number } = {},
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ auctionId: string; room: string }> {
  const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
  await requireSeller(listing.sellerId, prisma);
  if (listing.quantity <= 0) throw new Error('Out of stock — no units left to auction.');
  if (listing.status !== ListingStatus.QUEUED) {
    throw new Error(`Listing is not QUEUED (${listing.status})`);
  }
  const auctionId = await createAuction(
    {
      listingId,
      startingBid: listing.startingBid,
      durationSeconds: opts.durationSeconds,
      counterBidSeconds: opts.counterBidSeconds,
    },
    prisma,
  );
  await startAuction(auctionId, clock, prisma);
  return { auctionId, room: listing.sellerId };
}
