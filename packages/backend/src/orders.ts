/**
 * Order lifecycle (Chunk 5) — the delivery-gated escrow state machine.
 *
 *   PENDING_SETTLEMENT -> LOCKED -> SHIPPED -> DELIVERED -> DISPUTE_WINDOW -> RELEASED
 *                           |                                    |
 *                        CANCELED (no-ship timeout)          DISPUTED -> REFUNDED | RELEASED
 *                           v
 *                        REFUNDED
 *
 * EscrowProvider moves the money; this module owns the status transitions and the
 * timers. Funds are simulated in v1.
 */
import { AuctionStatus, OrderStatus, ListingStatus, splitAmount } from '@bidit/shared';
import type { Order } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { getOrCreateUserAccount, settleDirectSale } from './ledger.js';
import { createFulfillmentItem } from './fulfillment.js';
import { systemClock, type Clock } from './clock.js';
import type { EscrowProvider } from './escrow.js';

const DAY_MS = 86_400_000;
export const DISPUTE_WINDOW_MS = 3 * DAY_MS;
export const NO_SHIP_TIMEOUT_MS = 7 * DAY_MS;

export type DisputeOutcome = 'RELEASE' | 'REFUND';

/**
 * Turn a SETTLING auction into a LOCKED order: create the order, then lock the
 * winner's funds into escrow. Idempotent (one order per auction).
 */
export async function settleAuction(
  auctionId: string,
  escrow: EscrowProvider,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<Order | null> {
  const existing = await prisma.order.findUnique({ where: { auctionId } });
  if (existing) return existing;

  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: { listing: { select: { sellerId: true, id: true } } },
  });
  if (
    !auction ||
    auction.status !== AuctionStatus.SETTLING ||
    auction.currentLeaderUserId === null ||
    auction.currentBid === null
  ) {
    return null;
  }

  const amount = auction.currentBid;
  const { platformFee, sellerProceeds } = splitAmount(amount);
  const buyerId = auction.currentLeaderUserId;
  const sellerId = auction.listing.sellerId;
  const buyerAccountId = await getOrCreateUserAccount(buyerId, prisma);
  const sellerAccountId = await getOrCreateUserAccount(sellerId, prisma);

  const created = await prisma.order.create({
    data: {
      auctionId,
      buyerId,
      sellerId,
      amount,
      platformFee,
      sellerProceeds,
      status: OrderStatus.PENDING_SETTLEMENT,
    },
  });

  const ref = await escrow.lock(created.id, amount, buyerAccountId, sellerAccountId);
  const now = clock.now();
  const order = await prisma.order.update({
    where: { id: created.id },
    data: {
      status: OrderStatus.LOCKED,
      escrowRef: ref,
      lockedAt: now,
      noShipDeadline: new Date(now.getTime() + NO_SHIP_TIMEOUT_MS),
    },
  });

  // One unit sold — decrement the listing. While stock remains it flips back to
  // QUEUED so the seller can auction the next unit; at zero it's SOLD.
  const listing = await prisma.listing.update({
    where: { id: auction.listing.id },
    data: { quantity: { decrement: 1 } },
    select: { quantity: true },
  });
  await prisma.listing.update({
    where: { id: auction.listing.id },
    data: { status: listing.quantity > 0 ? ListingStatus.QUEUED : ListingStatus.SOLD },
  });

  return order;
}

/**
 * Direct-payout settlement (no escrow, no fee) for the live-test payout mode.
 * On a sale, the winning bid moves buyer -> seller 100% immediately; the seller's
 * balance is withdrawable at once. Creates a RELEASED order for the record (so it
 * shows in Purchases/Orders), then decrements the listing exactly like the escrow
 * path. There is NO buyer protection here — payment is final on close.
 */
export async function settleAuctionDirect(
  auctionId: string,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<Order | null> {
  const existing = await prisma.order.findUnique({ where: { auctionId } });
  if (existing) return existing;

  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: { listing: { select: { sellerId: true, id: true, title: true, photos: true, weightGrams: true } } },
  });
  if (
    !auction ||
    auction.status !== AuctionStatus.SETTLING ||
    auction.currentLeaderUserId === null ||
    auction.currentBid === null
  ) {
    return null;
  }

  const amount = auction.currentBid;
  const buyerId = auction.currentLeaderUserId;
  const sellerId = auction.listing.sellerId;
  const buyerAccountId = await getOrCreateUserAccount(buyerId, prisma);
  const sellerAccountId = await getOrCreateUserAccount(sellerId, prisma);
  const now = clock.now();

  const created = await prisma.order.create({
    data: {
      auctionId,
      buyerId,
      sellerId,
      amount,
      platformFee: 0n,
      sellerProceeds: amount, // 100% to the seller — no fee
      status: OrderStatus.RELEASED,
      lockedAt: now,
      releasedAt: now,
    },
  });

  // Move the money (idempotent). If this throws, the order stays but no funds
  // moved — safe to retry.
  await settleDirectSale({ buyerAccountId, sellerAccountId, amount, orderId: created.id, auctionId }, prisma);

  // Same stock accounting as the escrow path.
  const listing = await prisma.listing.update({
    where: { id: auction.listing.id },
    data: { quantity: { decrement: 1 } },
    select: { quantity: true },
  });
  await prisma.listing.update({
    where: { id: auction.listing.id },
    data: { status: listing.quantity > 0 ? ListingStatus.QUEUED : ListingStatus.SOLD },
  });

  // Physical fulfillment: the won card enters the buyer's "Ready to ship" list.
  await createFulfillmentItem(
    {
      orderId: created.id,
      buyerId,
      sellerId,
      listingId: auction.listing.id,
      title: auction.listing.title,
      photo: auction.listing.photos[0] ?? null,
      weightGrams: auction.listing.weightGrams,
      amount,
    },
    clock,
    prisma,
  );

  return created;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

async function transition(
  prisma: PrismaClient,
  orderId: string,
  from: OrderStatus[],
  data: Parameters<PrismaClient['order']['update']>[0]['data'],
): Promise<Order> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (!from.includes(order.status as OrderStatus)) {
    throw new Error(`Invalid order transition from ${order.status}`);
  }
  return prisma.order.update({ where: { id: orderId }, data });
}

/** Seller submits tracking. LOCKED -> SHIPPED. */
export function markShipped(
  orderId: string,
  trackingNumber: string,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<Order> {
  return transition(prisma, orderId, [OrderStatus.LOCKED], {
    status: OrderStatus.SHIPPED,
    trackingNumber,
    shippedAt: clock.now(),
  });
}

/** Carrier confirms delivery, opening the dispute window. SHIPPED -> DISPUTE_WINDOW. */
export function markDelivered(
  orderId: string,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<Order> {
  const now = clock.now();
  return transition(prisma, orderId, [OrderStatus.SHIPPED], {
    status: OrderStatus.DISPUTE_WINDOW,
    deliveredAt: now,
    disputeWindowEndsAt: new Date(now.getTime() + DISPUTE_WINDOW_MS),
  });
}

/** Buyer disputes inside the window. DISPUTE_WINDOW -> DISPUTED. */
export async function openDispute(
  orderId: string,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<Order> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status !== OrderStatus.DISPUTE_WINDOW) {
    throw new Error(`Cannot dispute an order in ${order.status}`);
  }
  if (order.disputeWindowEndsAt && clock.now().getTime() > order.disputeWindowEndsAt.getTime()) {
    throw new Error('Dispute window has closed');
  }
  return prisma.order.update({
    where: { id: orderId },
    data: { status: OrderStatus.DISPUTED, disputedAt: clock.now() },
  });
}

/** Admin resolves a dispute, moving money accordingly. DISPUTED -> RELEASED | REFUNDED. */
export async function resolveDispute(
  orderId: string,
  outcome: DisputeOutcome,
  escrow: EscrowProvider,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<Order> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status !== OrderStatus.DISPUTED) {
    throw new Error(`Order is not disputed (${order.status})`);
  }
  const now = clock.now();
  if (outcome === 'RELEASE') {
    await escrow.release(orderId);
    return prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.RELEASED, releasedAt: now },
    });
  }
  await escrow.refund(orderId);
  return prisma.order.update({
    where: { id: orderId },
    data: { status: OrderStatus.REFUNDED, refundedAt: now },
  });
}

/** Release escrow once the dispute window passes (timer) or by admin. */
export async function releaseOrder(
  orderId: string,
  escrow: EscrowProvider,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<Order> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status !== OrderStatus.DISPUTE_WINDOW) {
    throw new Error(`Cannot release an order in ${order.status}`);
  }
  await escrow.release(orderId);
  return prisma.order.update({
    where: { id: orderId },
    data: { status: OrderStatus.RELEASED, releasedAt: clock.now() },
  });
}

// ---------------------------------------------------------------------------
// Timers (server-driven, like the auction scheduler)
// ---------------------------------------------------------------------------

/**
 * Advance time-based transitions:
 *  - DISPUTE_WINDOW past its deadline with no dispute -> RELEASED (release).
 *  - LOCKED past the no-ship deadline -> CANCELED -> REFUNDED (refund).
 */
export async function processOrderTimers(
  escrow: EscrowProvider,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ released: string[]; refunded: string[] }> {
  const now = clock.now();
  const released: string[] = [];
  const refunded: string[] = [];

  const toRelease = await prisma.order.findMany({
    where: { status: OrderStatus.DISPUTE_WINDOW, disputeWindowEndsAt: { lte: now } },
    select: { id: true },
  });
  for (const { id } of toRelease) {
    await releaseOrder(id, escrow, clock, prisma);
    released.push(id);
  }

  const unshipped = await prisma.order.findMany({
    where: { status: OrderStatus.LOCKED, noShipDeadline: { lte: now } },
    select: { id: true },
  });
  for (const { id } of unshipped) {
    await prisma.order.update({ where: { id }, data: { status: OrderStatus.CANCELED, canceledAt: now } });
    await escrow.refund(id);
    await prisma.order.update({ where: { id }, data: { status: OrderStatus.REFUNDED, refundedAt: now } });
    refunded.push(id);
  }

  return { released, refunded };
}
