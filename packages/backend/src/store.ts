/**
 * Seller store ("buy now") — Whatnot-style fixed-price sales alongside auctions.
 *
 * A listing with a `buyNowPrice` also appears in the seller's shop and can be
 * bought outright. A purchase claims one unit, charges the buyer from AVAILABLE
 * balance (funds reserved under live bids stay untouchable), pays the seller
 * through the same rails as an auction win, and enters the exact same
 * fulfillment/shipping flow. Buy-now is only allowed while the listing is
 * QUEUED — never while its auction is LIVE — so store sales can't race the
 * auction engine over the last unit.
 */
import { ListingStatus, OrderStatus, splitAmount, formatUsdc } from '@bidit/shared';
import type { Listing, Order } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { getOrCreateUserAccount, settleDirectSale } from './ledger.js';
import { InsufficientFundsError } from './errors.js';
import { createFulfillmentItem, applyWeeklyBundling } from './fulfillment.js';
import { awardOrderPoints } from './points.js';
import { notify } from './notifications.js';
import { systemClock, type Clock } from './clock.js';
import type { EscrowProvider } from './escrow.js';
import { NO_SHIP_TIMEOUT_MS } from './orders.js';

/** Raised when the item can't be bought right now (sold out, mid-auction, no store price…). */
export class ItemUnavailableError extends Error {
  readonly status = 409;
  constructor(message = 'This item is no longer available') {
    super(message);
    this.name = 'ItemUnavailableError';
  }
}

/** A seller's storefront: buy-now listings that are in stock and not mid-auction. */
export function listStoreItems(
  sellerId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<Listing[]> {
  return prisma.listing.findMany({
    where: {
      sellerId,
      buyNowPrice: { not: null },
      status: ListingStatus.QUEUED,
      quantity: { gt: 0 },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], // id tiebreak keeps same-ms rows stable
    take: 500,
  });
}

export interface PurchaseOptions {
  /** true = pay the seller 100% instantly (BIDIT_PAYOUT_MODE=direct); false = escrow (95/5). */
  directPayout: boolean;
  escrow: EscrowProvider;
  clock?: Clock;
}

/**
 * Buy one unit of a store listing outright.
 *
 * Claim-then-charge: one unit is claimed with an atomic guarded decrement (only
 * QUEUED + in-stock listings match, so two buyers can't oversell the last unit
 * and a LIVE auction's unit can't be bought out from under it). If the charge
 * then fails for lack of funds, the claim is rolled back. Money moves through
 * the same ledger ops as auction wins — with `auctionId: null` they enforce the
 * AVAILABLE-balance check.
 */
export async function purchaseListing(
  buyerId: string,
  listingId: string,
  opts: PurchaseOptions,
  prisma: PrismaClient = defaultPrisma,
): Promise<Order> {
  const clock = opts.clock ?? systemClock;
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.buyNowPrice === null) throw new ItemUnavailableError();
  if (listing.sellerId === buyerId) throw new ItemUnavailableError('You can’t buy your own listing');

  // Claim a unit. The WHERE doubles as the availability check — status must be
  // QUEUED (not LIVE mid-auction, not SOLD) and stock must remain.
  const claimed = await prisma.listing.updateMany({
    where: {
      id: listingId,
      status: ListingStatus.QUEUED,
      buyNowPrice: { not: null },
      quantity: { gt: 0 },
    },
    data: { quantity: { decrement: 1 } },
  });
  if (claimed.count !== 1) throw new ItemUnavailableError();

  const amount = listing.buyNowPrice;
  const sellerId = listing.sellerId;
  const buyerAccountId = await getOrCreateUserAccount(buyerId, prisma);
  const sellerAccountId = await getOrCreateUserAccount(sellerId, prisma);
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

  // Charge the buyer. InsufficientFunds is thrown before any ledger legs post,
  // so on that failure we can safely undo the claim and drop the empty order.
  try {
    if (opts.directPayout) {
      await settleDirectSale(
        { buyerAccountId, sellerAccountId, amount, orderId: created.id, auctionId: null },
        prisma,
      );
    } else {
      const ref = await opts.escrow.lock(created.id, amount, buyerAccountId, sellerAccountId);
      await prisma.order.update({
        where: { id: created.id },
        data: {
          status: OrderStatus.LOCKED,
          escrowRef: ref,
          lockedAt: now,
          noShipDeadline: new Date(now.getTime() + NO_SHIP_TIMEOUT_MS),
        },
      });
    }
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      await prisma.order.delete({ where: { id: created.id } }).catch(() => {});
      await prisma.listing.update({
        where: { id: listingId },
        data: { quantity: { increment: 1 } },
      }).catch(() => {});
    }
    throw err;
  }

  if (opts.directPayout) {
    await prisma.order.update({ where: { id: created.id }, data: { status: OrderStatus.RELEASED } });
  }

  // Sold the last unit → retire the listing.
  const after = await prisma.listing.findUnique({ where: { id: listingId }, select: { quantity: true } });
  if (after && after.quantity <= 0) {
    await prisma.listing.update({ where: { id: listingId }, data: { status: ListingStatus.SOLD } });
  }

  // Same physical-fulfillment entry as an auction win (direct mode drives
  // shipping off FulfillmentItems; escrow mode ships at the order level).
  if (opts.directPayout) {
    await createFulfillmentItem(
      {
        orderId: created.id,
        buyerId,
        sellerId,
        listingId,
        title: listing.title,
        photo: listing.photos[0] ?? null,
        weightGrams: listing.weightGrams,
        amount,
      },
      clock,
      prisma,
    );
    await applyWeeklyBundling({ orderId: created.id, buyerId, sellerId }, clock, prisma);
  }

  // BIDit Points: buyer 100×/seller 20× per $1, keyed by orderId (idempotent).
  await awardOrderPoints({ orderId: created.id, buyerId, sellerId, amount }, prisma);

  const price = `$${formatUsdc(amount)}`;
  await notify(
    opts.directPayout
      ? { userId: buyerId, kind: 'won', title: `You bought ${listing.title}`, body: `Paid ${price} from the store. Go to Ready to ship to send it your way.`, href: '/ship' }
      : { userId: buyerId, kind: 'won', title: `You bought ${listing.title}`, body: `Paid ${price} from the store. The seller ships it to you next.`, href: '/purchases' },
    prisma,
  );
  await notify(
    { userId: sellerId, kind: 'sold', title: `Store sale: ${listing.title}`, body: `Bought now for ${price}.`, href: '/seller/orders' },
    prisma,
  );

  return prisma.order.findUniqueOrThrow({ where: { id: created.id } });
}
