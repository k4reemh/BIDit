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
import { AuctionStatus, OrderStatus, ListingStatus, splitAmount, formatUsdc } from '@bidit/shared';
import type { Order } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { getOrCreateUserAccount, settleDirectSale } from './ledger.js';
import { createFulfillmentItem, applyWeeklyBundling } from './fulfillment.js';
import { awardOrderPoints } from './points.js';
import { notify } from './notifications.js';
import { systemClock, type Clock } from './clock.js';
import type { EscrowProvider } from './escrow.js';

const DAY_MS = 86_400_000;
export const DISPUTE_WINDOW_MS = 3 * DAY_MS;
export const NO_SHIP_TIMEOUT_MS = 7 * DAY_MS;

export type DisputeOutcome = 'RELEASE' | 'REFUND';

/**
 * Post-sale physical fulfillment, shared by the direct and escrow settle paths:
 * create the buyer's "Ready to ship" item, fold it into any active weekly bundle,
 * and notify both sides. Direct vs escrow differ only in how the *money* moves —
 * the item ships the same way — so this lives in one place. Idempotent per order.
 */
async function postSaleFulfillment(
  params: {
    orderId: string;
    buyerId: string;
    sellerId: string;
    listing: { id: string; title: string; photos: string[]; weightGrams: number | null };
    amount: bigint;
  },
  clock: Clock,
  prisma: PrismaClient,
): Promise<void> {
  await createFulfillmentItem(
    {
      orderId: params.orderId,
      buyerId: params.buyerId,
      sellerId: params.sellerId,
      listingId: params.listing.id,
      title: params.listing.title,
      photo: params.listing.photos[0] ?? null,
      weightGrams: params.listing.weightGrams,
      amount: params.amount,
    },
    clock,
    prisma,
  );
  // If both sides opted into weekly bundling, fold this win into the week's shipment
  // (shipping charged once, on the first win of the week).
  await applyWeeklyBundling(
    { orderId: params.orderId, buyerId: params.buyerId, sellerId: params.sellerId },
    clock,
    prisma,
  );
  const price = `$${formatUsdc(params.amount)}`;
  await notify(
    { userId: params.buyerId, kind: 'won', title: `You won ${params.listing.title}`, body: `Winning bid ${price}. Go to Ready to ship to send it your way.`, href: '/ship' },
    prisma,
  );
  await notify(
    { userId: params.sellerId, kind: 'sold', title: `You sold ${params.listing.title}`, body: `Winning bid ${price}. You'll get a shipment to fulfill once the buyer pays shipping.`, href: '/seller/shipments' },
    prisma,
  );
}

/**
 * Turn a SETTLING auction into a LOCKED order: create the order, lock the winner's
 * funds into escrow, and drop the won card into the shipping pipeline (same as
 * direct mode — escrow only changes when the money releases). Idempotent (one
 * order per auction).
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

  // BIDit Points: buyer 100×/seller 20× per $1, keyed by orderId (idempotent).
  await awardOrderPoints({ orderId: created.id, buyerId, sellerId, amount }, prisma);

  // Drop the won card into the shipping pipeline (Ready to ship + seller queue).
  // The order's escrow release is gated on delivery separately (Shippo, later).
  await postSaleFulfillment(
    { orderId: created.id, buyerId, sellerId, listing: auction.listing, amount },
    clock,
    prisma,
  );

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

  // BIDit Points: buyer 100×/seller 20× per $1, keyed by orderId (idempotent).
  await awardOrderPoints({ orderId: created.id, buyerId, sellerId, amount }, prisma);

  // Physical fulfillment (shared with the escrow path).
  await postSaleFulfillment(
    { orderId: created.id, buyerId, sellerId, listing: auction.listing, amount },
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
