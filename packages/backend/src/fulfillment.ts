/**
 * Fulfillment — the physical side of a sale, separate from the money (which is
 * instant in direct-payout mode). Each won card becomes a FulfillmentItem
 * (READY_TO_SHIP); items from one seller to one buyer are grouped into a
 * Shipment carrying a single shipping fee. The four shipping modes (standard /
 * weekly bundle / ship-later / private) are policies over this; slice 1 is
 * Standard + the shared plumbing every mode reuses.
 */
import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { systemClock, type Clock } from './clock.js';
import { getOrCreateUserAccount, settleShipping } from './ledger.js';
import { quoteShipping, privacyPremium, type ShipLocation } from './shipping.js';

const DAY_MS = 86_400_000;
export const SHIP_LATER_HOLD_MS = 7 * DAY_MS;
/** Fallback weight for a sleeved card + mailer when the seller didn't estimate. */
const DEFAULT_WEIGHT_G = 60;

export type ShipMode = 'STANDARD' | 'WEEKLY_BUNDLE' | 'SHIP_LATER' | 'PRIVATE';

/** A user-facing shipping failure (bad selection, no address, insufficient funds). */
export class ShippingError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ShippingError';
  }
}

/** The operator's hub address for Private Secure Shipping (seller ships here; we
 *  reship to the buyer). Configured via BIDIT_HUB_ADDRESS (JSON); a clear
 *  placeholder otherwise so it's obvious it must be set before going private. */
function hubAddress(): Prisma.InputJsonValue {
  try {
    const raw = process.env.BIDIT_HUB_ADDRESS;
    if (raw) return JSON.parse(raw);
  } catch {
    /* fall through to placeholder */
  }
  return { name: 'BIDit Fulfillment', line1: 'Set BIDIT_HUB_ADDRESS', city: '', region: '', postal: '', country: 'US' };
}

// ---------------------------------------------------------------------------
// Creation (called on each direct-payout sale)
// ---------------------------------------------------------------------------

export interface FulfillmentSnapshot {
  orderId: string;
  buyerId: string;
  sellerId: string;
  listingId: string;
  title: string;
  photo?: string | null;
  weightGrams?: number | null;
  amount: bigint;
}

/** Create the Ready-to-Ship item for a won order. Idempotent per order. */
export async function createFulfillmentItem(
  snap: FulfillmentSnapshot,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  const heldUntil = new Date(clock.now().getTime() + SHIP_LATER_HOLD_MS);
  try {
    await prisma.fulfillmentItem.create({
      data: {
        orderId: snap.orderId,
        buyerId: snap.buyerId,
        sellerId: snap.sellerId,
        listingId: snap.listingId,
        title: snap.title,
        photo: snap.photo ?? null,
        weightGrams: snap.weightGrams ?? null,
        amount: snap.amount,
        status: 'READY_TO_SHIP',
        heldUntil,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return; // already created for this order
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getBuyerFulfillment(buyerId: string, prisma: PrismaClient = defaultPrisma) {
  const [items, shipments] = await Promise.all([
    prisma.fulfillmentItem.findMany({
      where: { buyerId, status: 'READY_TO_SHIP' },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.shipment.findMany({
      where: { buyerId, status: { in: ['PENDING_PAYMENT', 'PAID', 'SHIPPED'] } },
      orderBy: { createdAt: 'desc' },
      take: 40,
    }),
  ]);
  return { items, shipments };
}

export function getSellerShipments(sellerId: string, prisma: PrismaClient = defaultPrisma) {
  return prisma.shipment.findMany({
    where: { sellerId, status: { in: ['PAID', 'SHIPPED'] } },
    orderBy: { createdAt: 'asc' },
    take: 60,
  });
}

/** The items inside a shipment (for rendering a package's contents). */
export function shipmentItems(shipmentId: string, prisma: PrismaClient = defaultPrisma) {
  return prisma.fulfillmentItem.findMany({ where: { shipmentId }, orderBy: { createdAt: 'asc' } });
}

// ---------------------------------------------------------------------------
// Create + pay a shipment (buyer groups items and pays one shipping fee)
// ---------------------------------------------------------------------------

export async function createAndPayShipment(
  params: { buyerId: string; itemIds: string[]; mode?: ShipMode; private?: boolean },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  const ids = [...new Set(params.itemIds)].filter(Boolean);
  if (ids.length === 0) throw new ShippingError('Select at least one item to ship.');

  const items = await prisma.fulfillmentItem.findMany({ where: { id: { in: ids } } });
  if (items.length !== ids.length) throw new ShippingError('Some items were not found.');
  for (const it of items) {
    if (it.buyerId !== params.buyerId) throw new ShippingError('Those items aren’t yours.');
    if (it.status !== 'READY_TO_SHIP') throw new ShippingError('An item is no longer ready to ship.');
  }
  const sellerId = items[0]!.sellerId;
  if (items.some((it) => it.sellerId !== sellerId)) {
    throw new ShippingError('A shipment can only contain items from one seller.');
  }

  const buyer = await prisma.user.findUniqueOrThrow({ where: { id: params.buyerId } });
  const dest = (buyer.shippingAddress ?? null) as (ShipLocation & Record<string, unknown>) | null;
  if (!dest || !dest.line1 || !dest.country) {
    throw new ShippingError('Add your shipping address before shipping items.');
  }

  const seller = await prisma.sellerProfile.findUnique({ where: { userId: sellerId } });
  const origin: ShipLocation = {
    country: seller?.originCountry,
    region: seller?.originRegion,
    city: seller?.originCity,
    postal: seller?.originPostal,
  };

  const isPrivate = params.mode === 'PRIVATE' || params.private === true;
  const weight = items.reduce((g, it) => g + (it.weightGrams ?? DEFAULT_WEIGHT_G), 0);
  const shippingFee = quoteShipping(origin, dest, weight);
  const privacyFee = isPrivate ? privacyPremium() : 0n;

  const shipment = await prisma.shipment.create({
    data: {
      buyerId: params.buyerId,
      sellerId,
      mode: params.mode ?? 'STANDARD',
      status: 'PENDING_PAYMENT',
      shippingFee,
      privacyFee,
      shipTo: (isPrivate ? hubAddress() : (dest as Prisma.InputJsonValue)),
      privateLeg2: isPrivate ? (dest as Prisma.InputJsonValue) : undefined,
    },
  });

  const [buyerAccountId, sellerAccountId] = await Promise.all([
    getOrCreateUserAccount(params.buyerId, prisma),
    getOrCreateUserAccount(sellerId, prisma),
  ]);

  // Charge the buyer: shipping -> seller, privacy premium -> platform. Throws
  // InsufficientFundsError (mapped to a friendly 400 by the caller) if short.
  await settleShipping(
    { buyerAccountId, sellerAccountId, sellerAmount: shippingFee, platformAmount: privacyFee, shipmentId: shipment.id },
    prisma,
  );

  const now = clock.now();
  await prisma.shipment.update({ where: { id: shipment.id }, data: { status: 'PAID', paidAt: now } });
  await prisma.fulfillmentItem.updateMany({
    where: { id: { in: ids } },
    data: { status: 'IN_SHIPMENT', shipmentId: shipment.id },
  });

  return prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
}

// ---------------------------------------------------------------------------
// Seller / buyer transitions
// ---------------------------------------------------------------------------

/** Seller submits tracking. PAID -> SHIPPED. */
export async function markShipmentShipped(
  params: { shipmentId: string; sellerId: string; trackingNumber?: string; carrier?: string },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  const s = await prisma.shipment.findUniqueOrThrow({ where: { id: params.shipmentId } });
  if (s.sellerId !== params.sellerId) throw new ShippingError('Not your shipment.');
  if (s.status !== 'PAID') throw new ShippingError(`Can’t ship a shipment that is ${s.status}.`);
  const now = clock.now();
  await prisma.fulfillmentItem.updateMany({ where: { shipmentId: s.id }, data: { status: 'SHIPPED' } });
  return prisma.shipment.update({
    where: { id: s.id },
    data: {
      status: 'SHIPPED',
      trackingNumber: params.trackingNumber?.trim() || null,
      carrier: params.carrier?.trim() || null,
      shippedAt: now,
    },
  });
}

/** Mark a shipment delivered (buyer confirm or seller/ops). SHIPPED -> DELIVERED. */
export async function markShipmentDelivered(
  shipmentId: string,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  const s = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
  if (s.status !== 'SHIPPED') throw new ShippingError(`Can’t mark ${s.status} as delivered.`);
  const now = clock.now();
  await prisma.fulfillmentItem.updateMany({ where: { shipmentId: s.id }, data: { status: 'DELIVERED' } });
  return prisma.shipment.update({ where: { id: s.id }, data: { status: 'DELIVERED', deliveredAt: now } });
}

/**
 * Buyer discards a Ready-to-Ship item they don't want to bother shipping. Per the
 * locked decision this is a FORFEIT — the item is already paid (direct payout), so
 * no money moves; the seller keeps it. READY_TO_SHIP -> DISCARDED.
 */
export async function discardItem(
  itemId: string,
  buyerId: string,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  const it = await prisma.fulfillmentItem.findUniqueOrThrow({ where: { id: itemId } });
  if (it.buyerId !== buyerId) throw new ShippingError('Not your item.');
  if (it.status !== 'READY_TO_SHIP') throw new ShippingError('Only ready-to-ship items can be discarded.');
  return prisma.fulfillmentItem.update({
    where: { id: itemId },
    data: { status: 'DISCARDED', discardedAt: clock.now() },
  });
}

/** Auto-discard items whose 7-day seller hold expired with no buyer action. */
export async function processFulfillmentTimers(
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ discarded: string[] }> {
  const now = clock.now();
  const expired = await prisma.fulfillmentItem.findMany({
    where: { status: 'READY_TO_SHIP', heldUntil: { lte: now } },
    select: { id: true },
  });
  const ids = expired.map((e) => e.id);
  if (ids.length > 0) {
    await prisma.fulfillmentItem.updateMany({
      where: { id: { in: ids } },
      data: { status: 'DISCARDED', discardedAt: now },
    });
  }
  return { discarded: ids };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002';
}
