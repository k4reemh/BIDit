/**
 * Fulfillment: the physical side of a sale, separate from the money (which is
 * instant in direct-payout mode). Each won card becomes a FulfillmentItem
 * (READY_TO_SHIP); items from one seller to one buyer are grouped into a
 * Shipment carrying a single shipping fee. The four shipping modes (standard /
 * weekly bundle / ship-later / private) are policies over this; slice 1 is
 * Standard + the shared plumbing every mode reuses.
 */
import { Prisma } from '@prisma/client';
import { OrderStatus } from '@bidit/shared';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { systemClock, type Clock } from './clock.js';
import { getOrCreateUserAccount, settleShipping } from './ledger.js';
import { quoteShipping, quoteShippingBreakdown, privacyPremium, type Dimensions, type ShipLocation } from './shipping.js';
import { combineParcels, defaultParcel, type ParcelDims } from '@bidit/shared';
import { estimateShipping } from './ship-estimate.js';
import {
  rateShipment,
  issueQuote,
  consumeQuote,
  shipMarkupMicros,
  QuoteStaleError,
  type FullAddress,
} from './ship-charge.js';
import { encryptPii, decryptPii } from './pii.js';
import { notify } from './notifications.js';
import { maybeVerifySeller } from './seller-verify.js';

const DAY_MS = 86_400_000;
export const SHIP_LATER_HOLD_MS = 14 * DAY_MS; // seller holds a "ship later" win up to 2 weeks
/** Once the buyer pays shipping, the seller has this many BUSINESS days to ship a
 *  won item before the escrow is refunded (see processOrderTimers). */
export const NO_SHIP_BUSINESS_DAYS = 7;
/** Fallback weight for a sleeved card + mailer when the seller didn't estimate. */
const DEFAULT_WEIGHT_G = 60;

/** What a row (listing or won item) says it ships in. Rows saved before parcel
 *  presets existed have nulls, and fall back to the default medium polymailer. */
interface HasParcel {
  parcelLengthMm: number | null;
  parcelWidthMm: number | null;
  parcelHeightMm: number | null;
}

function parcelOf(row: HasParcel): ParcelDims {
  const { parcelLengthMm: l, parcelWidthMm: w, parcelHeightMm: h } = row;
  return l && w && h ? { lengthMm: l, widthMm: w, heightMm: h } : defaultParcel();
}

/** Carrier rates are quoted in centimetres. */
function toDimensions(p: ParcelDims): Dimensions {
  return { lengthCm: p.lengthMm / 10, widthCm: p.widthMm / 10, heightCm: p.heightMm / 10 };
}

/**
 * The package a set of won items actually ships in, and its total weight.
 *
 * This replaces the old flat "+3% per extra item" handling charge, which bore no
 * relation to what a carrier bills: two slabs in one mailer post for the same
 * price as one, while ten of them need a box and a different rate entirely.
 */
function parcelForItems(items: (HasParcel & { weightGrams: number | null })[]): {
  dims: Dimensions;
  weightGrams: number;
} {
  const combined = combineParcels(items.map(parcelOf));
  return {
    dims: toDimensions(combined.dims),
    weightGrams: items.reduce((g, it) => g + (it.weightGrams ?? DEFAULT_WEIGHT_G), 0),
  };
}

/** Add N business days (skipping Sat/Sun) to a date. Holidays are ignored: fine
 *  for the beta's no-ship deadline. */
export function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(from.getTime());
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return d;
}

/** Start the seller's ship-by clock on any LOCKED (escrow) order behind these
 *  items: the buyer just paid shipping, so the seller has NO_SHIP_BUSINESS_DAYS
 *  to ship before the escrow is refunded. No-op for direct-mode orders (RELEASED). */
async function startSellerShipClock(itemIds: string[], clock: Clock, prisma: PrismaClient): Promise<void> {
  const items = await prisma.fulfillmentItem.findMany({ where: { id: { in: itemIds } }, select: { orderId: true } });
  const orderIds = [...new Set(items.map((i) => i.orderId))];
  if (orderIds.length === 0) return;
  await prisma.order.updateMany({
    where: { id: { in: orderIds }, status: 'LOCKED', noShipDeadline: null },
    data: { noShipDeadline: addBusinessDays(clock.now(), NO_SHIP_BUSINESS_DAYS) },
  });
}

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
  parcelPreset?: string | null;
  parcelLengthMm?: number | null;
  parcelWidthMm?: number | null;
  parcelHeightMm?: number | null;
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
        parcelPreset: snap.parcelPreset ?? null,
        parcelLengthMm: snap.parcelLengthMm ?? null,
        parcelWidthMm: snap.parcelWidthMm ?? null,
        parcelHeightMm: snap.parcelHeightMm ?? null,
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
 * Best-effort, any precondition miss (no address, insufficient funds) silently
 * falls back to Standard (the item just stays Ready-to-Ship). Runs after the item
 * is created, inside the sale settlement.
 */
/** "Ship to my address" is off for launch: shipping is paid only from Ready to
 *  ship, where the buyer sees the price and confirms it. Set
 *  BIDIT_SHIP_ON_WIN=1 to turn the auto-charge path back on.
 *
 *  Gating it here rather than only hiding the option in the UI: buyers who
 *  already chose that mode still carry bundleShipping, and would otherwise keep
 *  getting charged on win by a flow that no longer has a way to show them the
 *  price first. */
export function shipOnWinEnabled(): boolean {
  return process.env.BIDIT_SHIP_ON_WIN === '1';
}

export async function applyWeeklyBundling(
  params: { orderId: string; buyerId: string; sellerId: string },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  if (!shipOnWinEnabled()) return;
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

  // Auto-ship this win: needs an address to ship to and funds for shipping.
  const dest = decryptPii<ShipLocation & Record<string, unknown>>(buyer.shippingAddress);
  if (!dest || !dest.line1 || !dest.country) return; // no address → fall back to Ready-to-ship
  const origin: ShipLocation = {
    country: sellerProfile?.originCountry,
    region: sellerProfile?.originRegion,
    city: sellerProfile?.originCity,
    postal: sellerProfile?.originPostal,
  };
  const one = parcelForItems([item]);
  const fee = quoteShipping(origin, dest, one.weightGrams, one.dims);

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
    // Can't afford shipping right now: undo and fall back to Ready-to-ship (buy
    // now, ship later): the buyer keeps the win, the item just waits to be shipped.
    await prisma.shipment.delete({ where: { id: shipment.id } }).catch(() => {});
    return;
  }
  await prisma.shipment.update({ where: { id: shipment.id }, data: { status: 'PAID', paidAt: now } });
  await prisma.fulfillmentItem.update({
    where: { id: item.id },
    data: { status: 'IN_SHIPMENT', shipmentId: shipment.id },
  });
  await startSellerShipClock([item.id], clock, prisma);
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
      where: { buyerId, status: { in: ['PENDING_PAYMENT', 'PAID', 'LABEL_PENDING', 'LABEL_CREATED', 'SHIPPED', 'DELIVERED'] } },
      orderBy: { createdAt: 'desc' },
      take: 40,
    }),
  ]);
  return { items, shipments };
}

export interface BuyerPurchase {
  id: string;
  orderId: string;
  title: string;
  photo: string | null;
  amount: bigint;
  /** FulfillmentItem status: READY_TO_SHIP | IN_SHIPMENT | SHIPPED | DELIVERED. */
  status: string;
  /** True when this came from winning an auction rather than a buy-now purchase. */
  won: boolean;
  shipment: { status: string; trackingNumber: string | null; carrier: string | null; deliveredAt: Date | null } | null;
}

/** Everything the buyer has won/bought that still exists (not discarded), across the
 *  whole lifecycle, for the Purchases overview. Each item carries its shipment (if
 *  any) so the UI can show tracking + the delivered state. `shipmentId` is a loose
 *  FK (no relation), so shipments are fetched + joined in memory. */
export async function getBuyerPurchases(buyerId: string, prisma: PrismaClient = defaultPrisma): Promise<BuyerPurchase[]> {
  const items = await prisma.fulfillmentItem.findMany({
    where: { buyerId, status: { in: ['READY_TO_SHIP', 'IN_SHIPMENT', 'SHIPPED', 'DELIVERED'] } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const shipmentIds = [...new Set(items.map((i) => i.shipmentId).filter((x): x is string => !!x))];
  const shipments = shipmentIds.length
    ? await prisma.shipment.findMany({
        where: { id: { in: shipmentIds } },
        select: { id: true, status: true, trackingNumber: true, carrier: true, deliveredAt: true },
      })
    : [];
  const byId = new Map(shipments.map((s) => [s.id, s]));

  // Was this WON at auction, or bought outright from the shop? Only an auction
  // order carries an auctionId. The distinction drives whether the buyer is
  // offered "I just won this" sharing, which would be false for a buy-now.
  const orderIds = [...new Set(items.map((i) => i.orderId).filter((x): x is string => !!x))];
  const wonOrderIds = new Set(
    orderIds.length
      ? (
          await prisma.order.findMany({
            where: { id: { in: orderIds }, auctionId: { not: null } },
            select: { id: true },
          })
        ).map((o) => o.id)
      : [],
  );

  return items.map((it) => ({
    id: it.id,
    orderId: it.orderId,
    title: it.title,
    photo: it.photo,
    amount: it.amount,
    status: it.status,
    won: it.orderId ? wonOrderIds.has(it.orderId) : false,
    shipment: it.shipmentId ? byId.get(it.shipmentId) ?? null : null,
  }));
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

/** Operator test view: shipments moving through the pipeline (post-label) that an
 *  admin can drive by hand: normally Shippo advances these automatically. */
export function listInflightShipments(prisma: PrismaClient = defaultPrisma) {
  return prisma.shipment.findMany({
    where: { status: { in: ['LABEL_CREATED', 'SHIPPED', 'DELIVERED'] } },
    orderBy: { createdAt: 'asc' },
    take: 100,
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
  params: { buyerId: string; itemIds: string[]; mode?: ShipMode; private?: boolean; quoteId?: string },
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
  // The ORDER, not just the item, has to still be live. A canceled/refunded order
  // means the buyer already has their money back, and a released one is done; in
  // either case shipping it would hand over goods nobody is paying for. The item
  // status alone does not catch this, so check the orders behind the items.
  const liveOrders = await prisma.order.findMany({
    where: { id: { in: items.map((it) => it.orderId) } },
    select: { id: true, status: true },
  });
  const notLive = liveOrders.find(
    (o) => o.status !== OrderStatus.LOCKED && o.status !== OrderStatus.RELEASED,
  );
  if (notLive || liveOrders.length !== new Set(items.map((it) => it.orderId)).size) {
    throw new ShippingError('That order is no longer active, so it can’t be shipped.');
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

  // The price comes from the quote the buyer was shown, never from a fresh
  // calculation here. Re-pricing at charge time is how "it said $12" becomes a
  // $16 ledger entry. consumeQuote also claims the row, so a double-clicked Pay
  // button charges once.
  if (!params.quoteId) throw new QuoteStaleError('Check the shipping price, then try again.');
  const quote = await consumeQuote(
    { quoteId: params.quoteId, buyerId: params.buyerId, itemIds: ids, isPrivate },
    clock,
    prisma,
  );
  const shippingFee = quote.amountMicros;
  const privacyFee = isPrivate ? privacyPremium() : 0n;

  const shipment = await prisma.shipment.create({
    data: {
      buyerId: params.buyerId,
      sellerId,
      mode: params.mode ?? 'STANDARD',
      status: 'PENDING_PAYMENT',
      shippingFee,
      privacyFee,
      // NOT Shipment.carrier: that field means "the carrier currently holding
      // this parcel" and drives tracking lookups. Writing the quoted carrier
      // there would put 'estimated' in front of the tracker on any model-quoted
      // shipment, which 404s at Shippo and leaves the package undeliverable
      // forever. The quoted service is linked through ShipQuote.shipmentId
      // instead, for the operator buying the label.
      shipTo: encryptPii(isPrivate ? hubAddress() : dest) as Prisma.InputJsonValue,
      privateLeg2: isPrivate ? (encryptPii(dest) as Prisma.InputJsonValue) : undefined,
    },
  });
  await prisma.shipQuote.update({ where: { id: quote.id }, data: { shipmentId: shipment.id } });

  const buyerAccountId = await getOrCreateUserAccount(params.buyerId, prisma);

  // Charge the buyer: the whole fee (base shipping + any privacy premium) goes to
  // the FEE pool: the platform buys the label. Throws InsufficientFundsError
  // (mapped to a friendly 400 by the caller) if short.
  try {
    await settleShipping(
      { buyerAccountId, amount: shippingFee + privacyFee, shipmentId: shipment.id },
      prisma,
    );
  } catch (err) {
    // Nothing moved, so put the quote back and drop the unpaid shipment.
    // Otherwise a buyer who is briefly short of funds tops up, hits Ship again,
    // and is told the PRICE expired, which is both wrong and unfixable from
    // their side. The claim above still stops a double click: the concurrent
    // second call fails on the claim, not here.
    await prisma.shipQuote.update({ where: { id: quote.id }, data: { consumedAt: null, shipmentId: null } });
    await prisma.shipment.deleteMany({ where: { id: shipment.id, status: 'PENDING_PAYMENT' } });
    throw err;
  }

  const now = clock.now();
  await prisma.shipment.update({ where: { id: shipment.id }, data: { status: 'PAID', paidAt: now } });
  await prisma.fulfillmentItem.updateMany({
    where: { id: { in: ids } },
    data: { status: 'IN_SHIPMENT', shipmentId: shipment.id },
  });
  await startSellerShipClock(ids, clock, prisma);

  return prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
}

/** Everything a real carrier quote needs about the two ends and the parcel. */
async function shipmentContext(
  buyerId: string,
  itemIds: string[],
  prisma: PrismaClient,
): Promise<{
  items: Awaited<ReturnType<PrismaClient['fulfillmentItem']['findMany']>>;
  sellerId: string;
  origin: FullAddress;
  dest: (FullAddress & Record<string, unknown>) | null;
  hasAddress: boolean;
  parcel: { dims: Dimensions; weightGrams: number };
}> {
  const ids = [...new Set(itemIds)].filter(Boolean);
  if (ids.length === 0) throw new ShippingError('Select at least one item to ship.');

  const items = await prisma.fulfillmentItem.findMany({ where: { id: { in: ids } } });
  if (items.length === 0) throw new ShippingError('Those items were not found.');
  for (const it of items) {
    if (it.buyerId !== buyerId) throw new ShippingError('Those items aren’t yours.');
  }
  const sellerId = items[0]!.sellerId;
  if (items.some((it) => it.sellerId !== sellerId)) {
    throw new ShippingError('A shipment can only contain items from one seller.');
  }

  const [buyer, seller] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: buyerId } }),
    prisma.sellerProfile.findUnique({ where: { userId: sellerId } }),
  ]);
  const dest = decryptPii<FullAddress & Record<string, unknown>>(buyer.shippingAddress);
  const hasAddress = !!(dest && dest.line1 && dest.country);
  const origin: FullAddress = {
    name: seller?.originName,
    line1: seller?.originLine1,
    line2: seller?.originLine2,
    country: seller?.originCountry,
    region: seller?.originRegion,
    city: seller?.originCity,
    postal: seller?.originPostal,
  };
  return { items, sellerId, origin, dest: dest ?? null, hasAddress, parcel: parcelForItems(items) };
}

/**
 * Price a shipment for real and hand back a quote the buyer can pay.
 *
 * Asks the carrier with both real addresses, the seller's declared package and
 * its weight, and takes the cheapest rate. The returned `quoteId` is what
 * createAndPayShipment consumes, so the buyer is charged exactly the number they
 * were shown rather than a second, independently computed one.
 *
 * Creates a ShipQuote row. Charges nothing.
 */
export async function estimateShipment(
  params: { buyerId: string; itemIds: string[]; private?: boolean },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{
  quoteId: string | null;
  shippingFee: bigint;
  privacyFee: bigint;
  total: bigint;
  carrier: string;
  service: string;
  estDays: number | null;
  hasAddress: boolean;
}> {
  const ctx = await shipmentContext(params.buyerId, params.itemIds, prisma);
  const isPrivate = params.private === true;
  const privacyFee = isPrivate ? privacyPremium() : 0n;

  // No address means no lane to price and nothing to pay for yet. Quote the
  // model so the page still shows a number, but issue no quote: there is nothing
  // here anyone should be able to get charged for.
  if (!ctx.dest || !ctx.hasAddress) {
    const fee = quoteShipping(ctx.origin, {}, ctx.parcel.weightGrams, ctx.parcel.dims) + shipMarkupMicros();
    return {
      quoteId: null,
      shippingFee: fee,
      privacyFee,
      total: fee + privacyFee,
      carrier: 'estimated',
      service: 'Standard',
      estDays: null,
      hasAddress: false,
    };
  }

  // Private Secure Shipping is quoted to the buyer's own address, the same as a
  // normal delivery, and the privacy premium covers the detour through the hub.
  // The label the operator actually buys is the seller-to-hub leg, priced
  // separately.
  const rate = await rateShipment(ctx.origin, ctx.dest, ctx.parcel);
  const quote = await issueQuote(
    { buyerId: params.buyerId, itemIds: params.itemIds, rate, isPrivate },
    clock,
    prisma,
  );
  return {
    quoteId: quote.id,
    shippingFee: rate.amountMicros,
    privacyFee,
    total: rate.amountMicros + privacyFee,
    carrier: rate.carrier,
    service: rate.service,
    estDays: rate.estDays,
    hasAddress: true,
  };
}

/**
 * The "~$ est. shipping" number on the bid panel, for an item that is still on
 * the block. DISPLAY ONLY: what the buyer actually pays is quoted live at ship
 * time. This one has to render for every viewer on every item, so it is pure
 * arithmetic (see ship-estimate.ts) with no network call and nothing that can
 * fail mid-auction.
 *
 * Missing weight or package fall back to what the category typically ships as,
 * preferring the listing's own category and then the seller's stream category.
 * A viewer with no saved address gets the local lane back, flagged `isFrom` so
 * the panel can present it as a starting price rather than a quote.
 */
export async function estimateListingShipping(
  buyerId: string,
  listingId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ shippingFee: bigint; privacyFee: bigint; hasAddress: boolean; isFrom: boolean }> {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: {
      sellerId: true,
      category: true,
      weightGrams: true,
      parcelPreset: true,
      parcelLengthMm: true,
      parcelWidthMm: true,
      parcelHeightMm: true,
    },
  });
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
  const { parcelLengthMm: l, parcelWidthMm: w, parcelHeightMm: h } = listing;
  const est = estimateShipping({
    origin,
    dest: hasAddress ? dest : null,
    category: listing.category ?? seller?.streamCategory ?? null,
    weightGrams: listing.weightGrams,
    parcelPreset: listing.parcelPreset,
    parcelDims: l && w && h ? { lengthMm: l, widthMm: w, heightMm: h } : null,
  });
  return {
    shippingFee: est.fee,
    privacyFee: privacyPremium(),
    hasAddress,
    isFrom: est.isFrom,
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
 * Advance a package to SHIPPED: LABEL_CREATED -> SHIPPED. This is driven by the
 * CARRIER: the ShipmentTracker flips a package here the moment tracking shows the
 * label moving (with an admin override for the rare manual case). Sellers never
 * self-attest shipping: they just print the BIDit label and drop the package off;
 * the carrier's first scan is what marks it shipped. The tracking number is already
 * on the label, so there's nothing to enter.
 */
export async function markShipmentShipped(
  shipmentId: string,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  const s = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
  if (s.status !== 'LABEL_CREATED') {
    throw new ShippingError('This package’s label isn’t ready to ship yet.');
  }
  const now = clock.now();
  await prisma.fulfillmentItem.updateMany({ where: { shipmentId: s.id }, data: { status: 'SHIPPED' } });
  // Shipping a weekly bundle closes the week: the buyer's next win starts a fresh
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
      body: 'Print it, tape it to the package, and drop it at your carrier. Tracking takes it from there.',
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

// NOTE: manual discards (buyer gives up an item, seller clears an expired hold)
// live in orders.ts (buyerDiscardItem / sellerDiscardExpiredItem): they may have
// to release escrow, which this module can't reach without an import cycle.

/** Auto-discard items whose ship-later hold expired with no buyer action. Escrow
 *  orders still LOCKED are left for the order timer, which forfeits them to the
 *  seller (releasing the escrow) rather than plain-discarding: otherwise the
 *  escrowed item price would be stranded. Direct-mode orders (already RELEASED)
 *  just discard: the buyer forfeits, the seller keeps the card. */
export async function processFulfillmentTimers(
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ discarded: string[]; purgedPii: number }> {
  const now = clock.now();
  const expired = await prisma.fulfillmentItem.findMany({
    where: { status: 'READY_TO_SHIP', heldUntil: { lte: now } },
    select: { id: true, orderId: true },
  });
  const discarded: string[] = [];
  for (const it of expired) {
    const order = await prisma.order.findUnique({ where: { id: it.orderId }, select: { status: true } });
    if (order?.status === 'LOCKED') continue; // escrow: forfeited by the order timer
    await prisma.fulfillmentItem.update({ where: { id: it.id }, data: { status: 'DISCARDED', discardedAt: now } });
    discarded.push(it.id);
  }
  const purgedPii = await purgeDeliveredShipmentPii(undefined, clock, prisma);
  return { discarded, purgedPii };
}

/** PII retention: null the buyer's address snapshot on shipments delivered more
 *  than `retentionDays` ago: we only keep it long enough to get the package there.
 *  shipTo is NOT-NULL Json (so JSON null), privateLeg2 is nullable. Idempotent. */
export async function purgeDeliveredShipmentPii(
  retentionDays = 90,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - retentionDays * DAY_MS);
  const res = await prisma.shipment.updateMany({
    where: { status: 'DELIVERED', deliveredAt: { lte: cutoff } },
    data: { shipTo: Prisma.JsonNull, privateLeg2: Prisma.DbNull },
  });
  return res.count;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002';
}
