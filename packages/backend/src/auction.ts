/**
 * The auction engine — Chunk 2.
 *
 * Server-authoritative live auctions with Whatnot-style anti-snipe extension.
 * The bid pipeline is one atomic transaction guarded by two row locks, taken in
 * a fixed order to avoid deadlocks:
 *
 *   1. Auction row (FOR UPDATE) — serializes all bids for a given auction, so two
 *      bids can never both be accepted as "leading".
 *   2. Bidder Account row (FOR UPDATE) — serializes a single user's concurrent
 *      bids across different auctions, so they can never lead auctions whose
 *      holds sum to more than their settled balance.
 *
 * Closing is driven by the server (closeDueAuctions / AuctionScheduler), never by
 * a client message. The injected Clock is the single source of truth for "now".
 */
import {
  AuctionStatus,
  BidStatus,
  ListingStatus,
  HoldStatus,
  BidRejectReason,
  minNextBid,
  antiSnipeRemaining,
  type IncrementConfig,
} from '@bidit/shared';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { getSettledBalance, getActiveHolds } from './ledger.js';
import { systemClock, type Clock } from './clock.js';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
type AuctionRow = Awaited<ReturnType<PrismaClient['auction']['findUniqueOrThrow']>>;

const TX_OPTS = { timeout: 15_000, maxWait: 15_000 } as const;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface AuctionSnapshot {
  auctionId: string;
  listingId: string;
  status: AuctionStatus;
  startingBid: bigint;
  currentBid: bigint | null;
  currentLeaderUserId: string | null;
  durationSeconds: number;
  counterBidSeconds: number;
  /** Server timestamp of the deadline. The client renders a countdown to this. */
  endsAt: Date | null;
  /** Server's current time, so the client can sync its countdown to the server. */
  serverNow: Date;
  /** Convenience: ms left per the server clock (clamped at 0). */
  remainingMs: number | null;
  /** Smallest amount a new bid may be right now. */
  minNextBid: bigint;
}

export type BidResult =
  | {
      ok: true;
      snapshot: AuctionSnapshot;
      bidId: string;
      /** Who just got outbid (their hold was released), so callers can notify them. */
      previousLeaderUserId: string | null;
      /** True when this bid pushed the deadline forward (anti-snipe), for the UI flash. */
      extended: boolean;
    }
  | { ok: false; reason: BidRejectReason };

export interface CloseResult {
  auctionId: string;
  status: AuctionStatus;
  winnerUserId: string | null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface CreateAuctionParams {
  listingId: string;
  startingBid: bigint;
  durationSeconds?: number;
  counterBidSeconds?: number;
  minIncrementBps?: number;
  minIncrementFloor?: bigint;
}

export async function createAuction(
  params: CreateAuctionParams,
  prisma: PrismaClient = defaultPrisma,
): Promise<string> {
  const auction = await prisma.auction.create({
    data: {
      listingId: params.listingId,
      startingBid: params.startingBid,
      status: AuctionStatus.PENDING,
      ...(params.durationSeconds !== undefined && { durationSeconds: params.durationSeconds }),
      ...(params.counterBidSeconds !== undefined && {
        counterBidSeconds: params.counterBidSeconds,
      }),
      ...(params.minIncrementBps !== undefined && { minIncrementBps: params.minIncrementBps }),
      ...(params.minIncrementFloor !== undefined && {
        minIncrementFloor: params.minIncrementFloor,
      }),
    },
  });
  return auction.id;
}

/** Move PENDING -> RUNNING and set endsAt = now + durationSeconds. */
export async function startAuction(
  auctionId: string,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<AuctionSnapshot> {
  return prisma.$transaction(async (tx) => {
    await lockAuction(tx, auctionId);
    const auction = await tx.auction.findUniqueOrThrow({ where: { id: auctionId } });
    if (auction.status !== AuctionStatus.PENDING) {
      throw new Error(`Auction ${auctionId} is not PENDING (status=${auction.status})`);
    }
    const now = clock.now();
    const endsAt = new Date(now.getTime() + auction.durationSeconds * 1000);
    const updated = await tx.auction.update({
      where: { id: auctionId },
      data: { status: AuctionStatus.RUNNING, endsAt },
    });
    await tx.listing.update({
      where: { id: auction.listingId },
      data: { status: ListingStatus.LIVE },
    });
    return toSnapshot(updated, now);
  }, TX_OPTS);
}

// ---------------------------------------------------------------------------
// The bid pipeline
// ---------------------------------------------------------------------------

export interface PlaceBidParams {
  auctionId: string;
  userId: string;
  amount: bigint;
}

export async function placeBid(
  params: PlaceBidParams,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<BidResult> {
  if (params.amount <= 0n) {
    return { ok: false, reason: BidRejectReason.BID_TOO_LOW };
  }

  return prisma.$transaction(async (tx): Promise<BidResult> => {
    // (1) Lock the auction row — serializes bid processing for this auction.
    await lockAuction(tx, params.auctionId);
    const auction = await tx.auction.findUnique({ where: { id: params.auctionId } });
    if (!auction) return { ok: false, reason: BidRejectReason.AUCTION_NOT_FOUND };

    // (2) Must be running and not past the deadline (re-checked under the lock).
    const now = clock.now();
    if (auction.status !== AuctionStatus.RUNNING || auction.endsAt === null) {
      return { ok: false, reason: BidRejectReason.AUCTION_ENDED };
    }
    if (now.getTime() >= auction.endsAt.getTime()) {
      return { ok: false, reason: BidRejectReason.AUCTION_ENDED };
    }

    // (3) Bid must clear the minimum next bid.
    const cfg: IncrementConfig = {
      floor: auction.minIncrementFloor,
      bps: BigInt(auction.minIncrementBps),
    };
    const required = minNextBid(auction.currentBid, auction.startingBid, cfg);
    if (params.amount < required) return { ok: false, reason: BidRejectReason.BID_TOO_LOW };

    // (4) No bidding against yourself.
    if (auction.currentLeaderUserId === params.userId) {
      return { ok: false, reason: BidRejectReason.ALREADY_LEADING };
    }

    // (5) Balance check — lock the bidder's account, then available >= amount.
    const account = await tx.account.findUnique({ where: { userId: params.userId } });
    if (!account) return { ok: false, reason: BidRejectReason.INSUFFICIENT_BALANCE };
    await lockAccount(tx, account.id);
    const settled = await getSettledBalance(account.id, tx);
    const holds = await getActiveHolds(account.id, tx);
    const available = settled - holds;
    if (available < params.amount) {
      return { ok: false, reason: BidRejectReason.INSUFFICIENT_BALANCE };
    }

    // (6) Accept. Release the previous leader's hold + mark their bid OUTBID.
    const previousLeaderUserId = auction.currentLeaderUserId;
    const previousHold = await tx.hold.findFirst({
      where: { auctionId: auction.id, status: HoldStatus.ACTIVE },
    });
    if (previousHold) {
      await tx.hold.update({
        where: { id: previousHold.id },
        data: { status: HoldStatus.RELEASED, releasedAt: now },
      });
    }
    if (auction.currentLeaderUserId) {
      await tx.bid.updateMany({
        where: {
          auctionId: auction.id,
          userId: auction.currentLeaderUserId,
          status: BidStatus.ACTIVE,
        },
        data: { status: BidStatus.OUTBID },
      });
    }

    // New leader: record the bid, place the hold.
    const bid = await tx.bid.create({
      data: {
        auctionId: auction.id,
        userId: params.userId,
        amount: params.amount,
        status: BidStatus.ACTIVE,
      },
    });
    await tx.hold.create({
      data: {
        accountId: account.id,
        auctionId: auction.id,
        bidId: bid.id,
        amount: params.amount,
        status: HoldStatus.ACTIVE,
      },
    });

    // Anti-snipe: a late bid nudges the deadline (capped at 5s); see antiSnipeRemaining.
    const remainingMs = auction.endsAt.getTime() - now.getTime();
    const newRemaining = antiSnipeRemaining(remainingMs);
    const extended = newRemaining > remainingMs;
    const endsAt = extended ? new Date(now.getTime() + newRemaining) : auction.endsAt;

    const updated = await tx.auction.update({
      where: { id: auction.id },
      data: {
        currentBid: params.amount,
        currentLeaderUserId: params.userId,
        endsAt,
      },
    });

    return {
      ok: true,
      snapshot: toSnapshot(updated, now),
      bidId: bid.id,
      previousLeaderUserId,
      extended,
    };
  }, TX_OPTS);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getAuctionSnapshot(
  auctionId: string,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<AuctionSnapshot | null> {
  const auction = await prisma.auction.findUnique({ where: { id: auctionId } });
  if (!auction) return null;
  return toSnapshot(auction, clock.now());
}

// ---------------------------------------------------------------------------
// Server-driven closing
// ---------------------------------------------------------------------------

/**
 * Transition every RUNNING auction whose deadline has passed. With a leader the
 * auction moves to SETTLING (winner = leader, winning bid WON, listing SOLD, the
 * winner's hold stays ACTIVE to be captured at settlement in Chunk 5). With no
 * bids it moves to CLOSED (listing UNSOLD).
 */
export async function closeDueAuctions(
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<CloseResult[]> {
  const now = clock.now();
  const due = await prisma.auction.findMany({
    where: { status: AuctionStatus.RUNNING, endsAt: { lte: now } },
    select: { id: true },
  });
  const results: CloseResult[] = [];
  for (const { id } of due) {
    const result = await closeOne(id, clock, prisma);
    if (result) results.push(result);
  }
  return results;
}

async function closeOne(
  auctionId: string,
  clock: Clock,
  prisma: PrismaClient,
): Promise<CloseResult | null> {
  return prisma.$transaction(async (tx): Promise<CloseResult | null> => {
    await lockAuction(tx, auctionId);
    const auction = await tx.auction.findUnique({ where: { id: auctionId } });
    if (!auction || auction.status !== AuctionStatus.RUNNING) return null;
    // Re-check under the lock: a late bid may have extended the deadline since
    // the poll selected this auction.
    const now = clock.now();
    if (auction.endsAt === null || auction.endsAt.getTime() > now.getTime()) return null;

    if (auction.currentLeaderUserId) {
      await tx.auction.update({
        where: { id: auctionId },
        data: { status: AuctionStatus.SETTLING },
      });
      await tx.bid.updateMany({
        where: {
          auctionId,
          userId: auction.currentLeaderUserId,
          status: BidStatus.ACTIVE,
        },
        data: { status: BidStatus.WON },
      });
      await tx.listing.update({
        where: { id: auction.listingId },
        data: { status: ListingStatus.SOLD },
      });
      return {
        auctionId,
        status: AuctionStatus.SETTLING,
        winnerUserId: auction.currentLeaderUserId,
      };
    }

    await tx.auction.update({
      where: { id: auctionId },
      data: { status: AuctionStatus.CLOSED },
    });
    // Nobody bid, so no unit was consumed — put the listing back in the queue so
    // the seller can auction it again (this is what makes an unsold item, incl.
    // one with quantity remaining, re-auctionable).
    const listing = await tx.listing.findUniqueOrThrow({ where: { id: auction.listingId }, select: { quantity: true } });
    await tx.listing.update({
      where: { id: auction.listingId },
      data: { status: listing.quantity > 0 ? ListingStatus.QUEUED : ListingStatus.UNSOLD },
    });
    return { auctionId, status: AuctionStatus.CLOSED, winnerUserId: null };
  }, TX_OPTS);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function lockAuction(tx: Tx, auctionId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Auction" WHERE id = ${auctionId} FOR UPDATE`;
}

async function lockAccount(tx: Tx, accountId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${accountId} FOR UPDATE`;
}

function toSnapshot(auction: AuctionRow, now: Date): AuctionSnapshot {
  const cfg: IncrementConfig = {
    floor: auction.minIncrementFloor,
    bps: BigInt(auction.minIncrementBps),
  };
  const remainingMs =
    auction.endsAt === null ? null : Math.max(0, auction.endsAt.getTime() - now.getTime());
  return {
    auctionId: auction.id,
    listingId: auction.listingId,
    status: auction.status,
    startingBid: auction.startingBid,
    currentBid: auction.currentBid,
    currentLeaderUserId: auction.currentLeaderUserId,
    durationSeconds: auction.durationSeconds,
    counterBidSeconds: auction.counterBidSeconds,
    endsAt: auction.endsAt,
    serverNow: now,
    remainingMs,
    minNextBid: minNextBid(auction.currentBid, auction.startingBid, cfg),
  };
}
