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

/** A user-facing seller/coin conflict (e.g. a coin already linked elsewhere). 409
 *  so it's distinct from a plain auth failure; the top-level handler reads `status`. */
export class SellerError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'SellerError';
  }
}

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

/** Force-give `coinAddress` to `sellerId`, releasing it from anyone else who had it.
 *  This is a TRUSTED move — it can silently steal a coin from another seller, so it
 *  is only reachable from paths that have already established authority: the admin
 *  seed (`linkCoinToSeller`) and the admin reassign endpoint (`reassignCoin`). The
 *  self-serve seller path (`setSellerCoin`) must NOT use it — see that function. */
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

/** Seller sets the Pump coin they stream on. Does NOT grant verification.
 *  FIRST-CLAIM-WINS: a coin already linked to another seller CANNOT be taken over
 *  here — only an admin can move it (`reassignCoin`). Without this, any logged-in
 *  caller could point a victim's coin at their own room and reroute the victim's
 *  buyers' USDC (a coin resolves to exactly one seller via `resolveRoomByCoin`).
 *  Clearing your own coin (empty string) and re-affirming your own are always fine. */
export async function setSellerCoin(
  sellerId: string,
  coinAddress: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  const coin = coinAddress.trim();
  if (coin) {
    const owner = await prisma.sellerProfile.findFirst({
      where: { pumpCoinAddress: coin, NOT: { userId: sellerId } },
      select: { userId: true },
    });
    if (owner) {
      throw new SellerError('That coin is already linked to another seller. If it’s yours, contact support to move it.');
    }
  }
  await prisma.sellerProfile.upsert({
    where: { userId: sellerId },
    update: { pumpCoinAddress: coin || null },
    create: { userId: sellerId, pumpCoinAddress: coin || null },
  });
}

/** Admin-only: force-move `coinAddress` to `sellerId`, releasing it from any other
 *  seller. This is the ONLY way a claimed coin changes hands (legit ownership
 *  transfers / dispute resolution). The target must already be a seller. */
export async function reassignCoin(
  sellerId: string,
  coinAddress: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  const coin = coinAddress.trim();
  if (!coin) throw new SellerError('Provide the coin address to reassign.');
  await requireSeller(sellerId, prisma);
  await claimCoin(sellerId, coin, prisma);
  await prisma.sellerProfile.upsert({
    where: { userId: sellerId },
    update: { pumpCoinAddress: coin },
    create: { userId: sellerId, pumpCoinAddress: coin },
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
