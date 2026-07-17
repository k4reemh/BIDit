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
export const DISPUTE_WINDOW_MS = 2 * DAY_MS;

/** Structured dispute a buyer can file within the window. */
export interface DisputeReport {
  /** Reason code, e.g. 'not_arrived' | 'damaged' | 'wrong_item' | 'not_as_described' | 'other'. */
  reason: string;
  /** The buyer's written description of what went wrong. */
  detail: string;
  /** Evidence photo URLs (data URLs or hosted links). */
  photos?: string[];
}
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
      // The seller's ship-clock starts when the BUYER PAYS SHIPPING (set in
      // createAndPayShipment), not at win — otherwise a buyer who hasn't paid
      // shipping yet would be wrongly auto-refunded. A win the buyer never pays
      // shipping for is instead forfeited to the seller when the ship-later hold
      // expires (processOrderTimers). So: no deadline yet.
      noShipDeadline: null,
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
  report?: DisputeReport,
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
    data: {
      status: OrderStatus.DISPUTED,
      disputedAt: clock.now(),
      disputeReason: report?.reason ?? null,
      disputeDetail: report?.detail ?? null,
      disputePhotos: report?.photos ?? [],
    },
  });
}

/**
 * Drive a shipment's linked orders through the escrow state machine as the package
 * physically moves. A Shipment groups FulfillmentItems, each tied to an order.
 *  - 'SHIPPED':        LOCKED -> SHIPPED (seller dropped it off).
 *  - 'DISPUTE_WINDOW': SHIPPED/LOCKED -> DISPUTE_WINDOW (delivered; opens the 2-day
 *                      window, after which processOrderTimers auto-releases).
 * Only orders in an escrow state are touched — direct-payout orders are already
 * RELEASED, so this is a safe no-op in direct mode. Idempotent (guarded by status).
 * Returns the affected order ids.
 */
export async function advanceOrdersForShipment(
  shipmentId: string,
  to: 'SHIPPED' | 'DISPUTE_WINDOW',
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<string[]> {
  const items = await prisma.fulfillmentItem.findMany({ where: { shipmentId }, select: { orderId: true } });
  const orderIds = [...new Set(items.map((i) => i.orderId))];
  const now = clock.now();
  const advanced: string[] = [];
  for (const id of orderIds) {
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) continue;
    if (to === 'SHIPPED' && order.status === OrderStatus.LOCKED) {
      await prisma.order.update({ where: { id }, data: { status: OrderStatus.SHIPPED, shippedAt: now } });
      advanced.push(id);
    } else if (to === 'DISPUTE_WINDOW' && (order.status === OrderStatus.SHIPPED || order.status === OrderStatus.LOCKED)) {
      await prisma.order.update({
        where: { id },
        data: {
          status: OrderStatus.DISPUTE_WINDOW,
          deliveredAt: now,
          disputeWindowEndsAt: new Date(now.getTime() + DISPUTE_WINDOW_MS),
        },
      });
      advanced.push(id);
    }
  }
  return advanced;
}

/**
 * Buyer files a dispute against a delivered shipment: opens a dispute (with the
 * reason/detail/photos) on every order in that shipment still inside its window.
 * Returns how many orders were disputed. Throws if none are open for a dispute.
 */
export async function disputeShipment(
  shipmentId: string,
  buyerId: string,
  report: DisputeReport,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<number> {
  const items = await prisma.fulfillmentItem.findMany({ where: { shipmentId }, select: { orderId: true, buyerId: true } });
  const orderIds = [...new Set(items.filter((i) => i.buyerId === buyerId).map((i) => i.orderId))];
  let n = 0;
  for (const id of orderIds) {
    const order = await prisma.order.findUnique({ where: { id } });
    if (order?.status === OrderStatus.DISPUTE_WINDOW) {
      await openDispute(id, report, clock, prisma);
      n += 1;
    }
  }
  if (n === 0) throw new Error('This delivery isn’t open for a dispute right now.');
  return n;
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

/** Release now (skip the dispute-window wait) every DISPUTE_WINDOW order in a
 *  shipment. Returns the released order ids. Used by the admin test controls. */
export async function releaseOrdersForShipment(
  shipmentId: string,
  escrow: EscrowProvider,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<string[]> {
  const items = await prisma.fulfillmentItem.findMany({ where: { shipmentId }, select: { orderId: true } });
  const orderIds = [...new Set(items.map((i) => i.orderId))];
  const released: string[] = [];
  for (const id of orderIds) {
    const order = await prisma.order.findUnique({ where: { id } });
    if (order?.status === OrderStatus.DISPUTE_WINDOW) {
      await releaseOrder(id, escrow, clock, prisma);
      released.push(id);
    }
  }
  return released;
}

// ---------------------------------------------------------------------------
// Timers (server-driven, like the auction scheduler)
// ---------------------------------------------------------------------------

/** Buyer abandoned a win — never arranged shipping before the ship-later hold
 *  expired. The seller keeps the item AND is paid: release the escrow to them.
 *  LOCKED -> RELEASED. (Direct-mode orders are already RELEASED, so this only ever
 *  applies to escrow.) */
export async function forfeitOrder(
  orderId: string,
  escrow: EscrowProvider,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<Order> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status !== OrderStatus.LOCKED) {
    throw new Error(`Cannot forfeit an order in ${order.status}`);
  }
  await escrow.release(orderId);
  return prisma.order.update({
    where: { id: orderId },
    data: { status: OrderStatus.RELEASED, releasedAt: clock.now() },
  });
}

/**
 * Advance time-based transitions:
 *  - DISPUTE_WINDOW past its deadline with no dispute -> RELEASED (release).
 *  - LOCKED past the no-ship deadline (set when the buyer PAID shipping and the
 *    seller then didn't ship) -> CANCELED -> REFUNDED (item price back to buyer;
 *    shipping is kept).
 *  - LOCKED with no shipping ever paid, past the item's ship-later hold -> the
 *    buyer abandoned it -> RELEASED to the seller (forfeit), item discarded.
 */
export async function processOrderTimers(
  escrow: EscrowProvider,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ released: string[]; refunded: string[]; forfeited: string[] }> {
  const now = clock.now();
  const released: string[] = [];
  const refunded: string[] = [];
  const forfeited: string[] = [];

  const toRelease = await prisma.order.findMany({
    where: { status: OrderStatus.DISPUTE_WINDOW, disputeWindowEndsAt: { lte: now } },
    select: { id: true },
  });
  for (const { id } of toRelease) {
    await releaseOrder(id, escrow, clock, prisma);
    released.push(id);
  }

  // Seller was paid to ship (noShipDeadline set) but didn't in time → refund item.
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

  // Buyer never paid shipping and the ship-later hold has expired → forfeit to
  // seller. (noShipDeadline is null until shipping is paid, which is how we tell
  // "abandoned" from "paid-but-not-shipped" above.)
  const abandoned = await prisma.fulfillmentItem.findMany({
    where: { status: 'READY_TO_SHIP', heldUntil: { lte: now } },
    select: { id: true, orderId: true },
  });
  for (const it of abandoned) {
    const order = await prisma.order.findUnique({ where: { id: it.orderId } });
    if (order?.status !== OrderStatus.LOCKED || order.noShipDeadline !== null) continue;
    await forfeitOrder(it.orderId, escrow, clock, prisma);
    await prisma.fulfillmentItem.update({ where: { id: it.id }, data: { status: 'DISCARDED', discardedAt: now } });
    forfeited.push(it.orderId);
  }

  return { released, refunded, forfeited };
}
