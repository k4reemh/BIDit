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
import { quoteShipping, quoteShippingBreakdown, multiItemSurcharge, privacyPremium, type ShipLocation } from './shipping.js';
import { encryptPii, decryptPii } from './pii.js';
import { notify } from './notifications.js';
import { maybeVerifySeller } from './seller-verify.js';

const DAY_MS = 86_400_000;
export const SHIP_LATER_HOLD_MS = 14 * DAY_MS; // seller holds a "ship later" win up to 2 weeks
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

/**
 * Weekly bundling: if the buyer opted in AND the seller offers it, the just-won
 * item joins a weekly Shipment instead of sitting in Ready-to-Ship.
 *  - First win of the week: open a WEEKLY_BUNDLE shipment, charge shipping ONCE
 *    (decision), attach the item, open a pass (7-day week).
 *  - Later wins that week: attach free to the open pass's shipment.
 * Best-effort — any precondition miss (no address, insufficient funds) silently
 * falls back to Standard (the item just stays Ready-to-Ship). Runs after the item
 * is created, inside the sale settlement.
 */
export async function applyWeeklyBundling(
  params: { orderId: string; buyerId: string; sellerId: string },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  const [buyer, sellerProfile, item] = await Promise.all([
    prisma.user.findUnique({ where: { id: params.buyerId } }),
    prisma.sellerProfile.findUnique({ where: { userId: params.sellerId } }),
    prisma.fulfillmentItem.findUnique({ where: { orderId: params.orderId } }),
  ]);
  // "Ship to my address" (bundleShipping) is the buyer's choice to auto-ship each
  // win immediately. If the SELLER also offers weekly bundling, wins that week ride
  // one paid shipment for free; otherwise each win just ships and pays on its own.
  if (!buyer?.bundleShipping) return;
  if (!item || item.status !== 'READY_TO_SHIP') return;
  const offersBundling = !!sellerProfile?.weeklyBundling;

  const now = clock.now();
  if (offersBundling) {
    const open = await prisma.weeklyShippingPass.findFirst({
      where: { buyerId: params.buyerId, sellerId: params.sellerId, closedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (open) {
      // Ride the existing week free.
      await prisma.fulfillmentItem.update({
        where: { id: item.id },
        data: { status: 'IN_SHIPMENT', shipmentId: open.shipmentId },
      });
      return;
    }
  }

  // Auto-ship this win — needs an address to ship to and funds for shipping.
  const dest = decryptPii<ShipLocation & Record<string, unknown>>(buyer.shippingAddress);
  if (!dest || !dest.line1 || !dest.country) return; // no address → fall back to Ready-to-ship
  const origin: ShipLocation = {
    country: sellerProfile?.originCountry,
    region: sellerProfile?.originRegion,
    city: sellerProfile?.originCity,
    postal: sellerProfile?.originPostal,
  };
  const fee = quoteShipping(origin, dest, item.weightGrams ?? DEFAULT_WEIGHT_G);

  const shipment = await prisma.shipment.create({
    data: {
      buyerId: params.buyerId,
      sellerId: params.sellerId,
      mode: 'WEEKLY_BUNDLE',
      status: 'PENDING_PAYMENT',
      shippingFee: fee,
      shipTo: encryptPii(dest) as Prisma.InputJsonValue,
    },
  });
  const buyerAccountId = await getOrCreateUserAccount(params.buyerId, prisma);
  try {
    await settleShipping({ buyerAccountId, amount: fee, shipmentId: shipment.id }, prisma);
  } catch {
    // Can't afford shipping right now — undo and fall back to Ready-to-ship (buy
    // now, ship later): the buyer keeps the win, the item just waits to be shipped.
    await prisma.shipment.delete({ where: { id: shipment.id } }).catch(() => {});
    return;
  }
  await prisma.shipment.update({ where: { id: shipment.id }, data: { status: 'PAID', paidAt: now } });
  await prisma.fulfillmentItem.update({
    where: { id: item.id },
    data: { status: 'IN_SHIPMENT', shipmentId: shipment.id },
  });
  if (offersBundling) {
    // Open the week so the buyer's later wins from this seller ride free.
    await prisma.weeklyShippingPass.create({
      data: {
        buyerId: params.buyerId,
        sellerId: params.sellerId,
        shipmentId: shipment.id,
        weekStart: now,
        expiresAt: new Date(now.getTime() + SHIP_LATER_HOLD_MS),
      },
    });
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
      take: 200,
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
    where: { sellerId, status: { in: ['PAID', 'LABEL_PENDING', 'LABEL_CREATED', 'SHIPPED'] } },
    orderBy: { createdAt: 'asc' },
    take: 60,
  });
}

/** The items inside a shipment (for rendering a package's contents). */
export function shipmentItems(shipmentId: string, prisma: PrismaClient = defaultPrisma) {
  return prisma.fulfillmentItem.findMany({ where: { shipmentId }, orderBy: { createdAt: 'asc' } });
}

/** Items a seller is physically holding while the buyer decides to ship (ship-later). */
export function getSellerHeldItems(sellerId: string, prisma: PrismaClient = defaultPrisma) {
  return prisma.fulfillmentItem.findMany({
    where: { sellerId, status: 'READY_TO_SHIP' },
    orderBy: { createdAt: 'asc' },
    take: 60,
  });
}

/** Operator queue: packages a seller has confirmed that need a label generated
 *  (LABEL_PENDING). The operator makes the label, then calls createShipmentLabel. */
export function listLabelQueue(prisma: PrismaClient = defaultPrisma) {
  return prisma.shipment.findMany({
    where: { status: 'LABEL_PENDING' },
    orderBy: { confirmedAt: 'asc' },
    take: 100,
  });
}

/** Operator view: Private shipments awaiting the hub→buyer reship leg. Includes the
 *  buyer's real address (privateLeg2), which is intentionally never exposed to sellers. */
export function listPrivateShipments(prisma: PrismaClient = defaultPrisma) {
  return prisma.shipment.findMany({
    where: { mode: 'PRIVATE', status: { in: ['PAID', 'SHIPPED'] } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
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
  const dest = decryptPii<ShipLocation & Record<string, unknown>>(buyer.shippingAddress);
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
  // +3% per additional item in the shipment (matches the estimate shown to the buyer).
  const shippingFee = multiItemSurcharge(quoteShipping(origin, dest, weight), items.length);
  const privacyFee = isPrivate ? privacyPremium() : 0n;

  const shipment = await prisma.shipment.create({
    data: {
      buyerId: params.buyerId,
      sellerId,
      mode: params.mode ?? 'STANDARD',
      status: 'PENDING_PAYMENT',
      shippingFee,
      privacyFee,
      shipTo: encryptPii(isPrivate ? hubAddress() : dest) as Prisma.InputJsonValue,
      privateLeg2: isPrivate ? (encryptPii(dest) as Prisma.InputJsonValue) : undefined,
    },
  });

  const buyerAccountId = await getOrCreateUserAccount(params.buyerId, prisma);

  // Charge the buyer: the whole fee (base shipping + any privacy premium) goes to
  // the FEE pool — the platform buys the label. Throws InsufficientFundsError
  // (mapped to a friendly 400 by the caller) if short.
  await settleShipping(
    { buyerAccountId, amount: shippingFee + privacyFee, shipmentId: shipment.id },
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

/**
 * Read-only shipping estimate for a set of ready-to-ship items — same origin,
 * destination and weight the real charge would use, so the buyer sees the fee
 * before committing. Charges nothing and creates nothing.
 */
export async function estimateShipment(
  params: { buyerId: string; itemIds: string[]; private?: boolean },
  prisma: PrismaClient = defaultPrisma,
): Promise<{
  shippingFee: bigint;
  carrierRetail: bigint;
  discountPct: number;
  privacyFee: bigint;
  total: bigint;
  hasAddress: boolean;
}> {
  const ids = [...new Set(params.itemIds)].filter(Boolean);
  if (ids.length === 0) throw new ShippingError('Select at least one item to estimate.');

  const items = await prisma.fulfillmentItem.findMany({ where: { id: { in: ids } } });
  if (items.length === 0) throw new ShippingError('Those items were not found.');
  for (const it of items) {
    if (it.buyerId !== params.buyerId) throw new ShippingError('Those items aren’t yours.');
  }
  const sellerId = items[0]!.sellerId;
  if (items.some((it) => it.sellerId !== sellerId)) {
    throw new ShippingError('A shipment can only contain items from one seller.');
  }

  const [buyer, seller] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: params.buyerId } }),
    prisma.sellerProfile.findUnique({ where: { userId: sellerId } }),
  ]);
  const dest = decryptPii<ShipLocation & Record<string, unknown>>(buyer.shippingAddress);
  const hasAddress = !!(dest && dest.line1 && dest.country);
  const origin: ShipLocation = {
    country: seller?.originCountry,
    region: seller?.originRegion,
    city: seller?.originCity,
    postal: seller?.originPostal,
  };

  const weight = items.reduce((g, it) => g + (it.weightGrams ?? DEFAULT_WEIGHT_G), 0);
  const b = quoteShippingBreakdown(origin, dest ?? {}, weight);
  // +3% per additional item in the shipment (multi-item handling).
  const shippingFee = multiItemSurcharge(b.final, items.length);
  const carrierRetail = multiItemSurcharge(b.carrierRetail, items.length);
  const privacyFee = params.private === true ? privacyPremium() : 0n;
  return {
    shippingFee,
    carrierRetail,
    discountPct: b.discountPct,
    privacyFee,
    total: shippingFee + privacyFee,
    hasAddress,
  };
}

/**
 * Read-only shipping estimate for a single listing (not yet won) — for the bid
 * panel, so a buyer sees what shipping will cost before bidding. Uses the seller's
 * ship-from, the listing weight and the buyer's saved address.
 */
export async function estimateListingShipping(
  buyerId: string,
  listingId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ shippingFee: bigint; carrierRetail: bigint; discountPct: number; privacyFee: bigint; hasAddress: boolean }> {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { sellerId: true, weightGrams: true } });
  if (!listing) throw new ShippingError('Listing not found.');
  const [buyer, seller] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: buyerId } }),
    prisma.sellerProfile.findUnique({ where: { userId: listing.sellerId } }),
  ]);
  const dest = decryptPii<ShipLocation & Record<string, unknown>>(buyer.shippingAddress);
  const hasAddress = !!(dest && dest.line1 && dest.country);
  const origin: ShipLocation = {
    country: seller?.originCountry,
    region: seller?.originRegion,
    city: seller?.originCity,
    postal: seller?.originPostal,
  };
  const b = quoteShippingBreakdown(origin, dest ?? {}, listing.weightGrams ?? DEFAULT_WEIGHT_G);
  return {
    shippingFee: b.final,
    carrierRetail: b.carrierRetail,
    discountPct: b.discountPct,
    privacyFee: privacyPremium(),
    hasAddress,
  };
}

// ---------------------------------------------------------------------------
// Seller / buyer transitions
// ---------------------------------------------------------------------------

/**
 * Seller confirms the package they'll send for a PAID shipment (dimensions in cm +
 * estimated weight in grams); BIDit then generates the label. PAID -> LABEL_PENDING.
 * Multiple items already grouped in this shipment ship together in one package.
 */
export async function confirmShipmentForLabel(
  params: {
    shipmentId: string;
    sellerId: string;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    weightGrams: number;
  },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  const s = await prisma.shipment.findUniqueOrThrow({ where: { id: params.shipmentId } });
  if (s.sellerId !== params.sellerId) throw new ShippingError('Not your shipment.');
  if (s.status !== 'PAID') throw new ShippingError('This package isn’t awaiting confirmation.');
  const dims = [params.lengthCm, params.widthCm, params.heightCm, params.weightGrams];
  if (dims.some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new ShippingError('Enter the package length, width, height, and weight.');
  }
  return prisma.shipment.update({
    where: { id: s.id },
    data: {
      status: 'LABEL_PENDING',
      lengthCm: Math.round(params.lengthCm),
      widthCm: Math.round(params.widthCm),
      heightCm: Math.round(params.heightCm),
      packageWeightG: Math.round(params.weightGrams),
      confirmedAt: clock.now(),
    },
  });
}

/**
 * Seller drops the package off. LABEL_CREATED -> SHIPPED. The tracking number is
 * already on the BIDit-generated label, so there's nothing for the seller to enter.
 */
export async function markShipmentShipped(
  params: { shipmentId: string; sellerId: string },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  const s = await prisma.shipment.findUniqueOrThrow({ where: { id: params.shipmentId } });
  if (s.sellerId !== params.sellerId) throw new ShippingError('Not your shipment.');
  if (s.status !== 'LABEL_CREATED') {
    throw new ShippingError('Your shipping label isn’t ready to ship yet.');
  }
  const now = clock.now();
  await prisma.fulfillmentItem.updateMany({ where: { shipmentId: s.id }, data: { status: 'SHIPPED' } });
  // Shipping a weekly bundle closes the week — the buyer's next win starts a fresh
  // pass (and a fresh shipping charge).
  if (s.mode === 'WEEKLY_BUNDLE') {
    await prisma.weeklyShippingPass.updateMany({
      where: { shipmentId: s.id, closedAt: null },
      data: { closedAt: now },
    });
  }
  const updated = await prisma.shipment.update({
    where: { id: s.id },
    data: { status: 'SHIPPED', shippedAt: now },
  });
  const track = updated.trackingNumber ? `Tracking: ${updated.carrier ? `${updated.carrier} · ` : ''}${updated.trackingNumber}` : 'Your package is on the way.';
  await notify({ userId: s.buyerId, kind: 'shipped', title: 'Your order shipped', body: track, href: '/ship' }, prisma);
  // Fulfilling orders is what earns the Verified badge.
  await maybeVerifySeller(s.sellerId, prisma);
  return updated;
}

/**
 * Operator attaches the generated shipping label + tracking to a confirmed
 * package. LABEL_PENDING -> LABEL_CREATED, and the seller is emailed that it's
 * ready to print. (The polished operator queue that calls this is step 5.)
 */
export async function createShipmentLabel(
  params: { shipmentId: string; labelUrl: string; trackingNumber: string; carrier?: string },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  const s = await prisma.shipment.findUniqueOrThrow({ where: { id: params.shipmentId } });
  if (s.status !== 'LABEL_PENDING') throw new ShippingError('This package isn’t awaiting a label.');
  const labelUrl = params.labelUrl.trim();
  const trackingNumber = params.trackingNumber.trim();
  if (!labelUrl || !trackingNumber) throw new ShippingError('Provide the label file and tracking number.');
  const updated = await prisma.shipment.update({
    where: { id: s.id },
    data: {
      status: 'LABEL_CREATED',
      labelUrl,
      trackingNumber,
      carrier: params.carrier?.trim() || null,
      labelCreatedAt: clock.now(),
    },
  });
  await notify(
    {
      userId: s.sellerId,
      kind: 'label_ready',
      title: 'Your shipping label is ready',
      body: 'Print it, tape it to the package, and drop it at the carrier — then mark it shipped.',
      href: '/seller/shipments',
    },
    prisma,
  );
  return updated;
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
