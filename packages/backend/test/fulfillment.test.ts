import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { placeBid, closeDueAuctions } from '../src/auction.js';
import { settleAuctionDirect } from '../src/orders.js';
import {
  createAndPayShipment,
  confirmShipmentForLabel,
  createShipmentLabel,
  markShipmentShipped,
  markShipmentDelivered,
  discardItem,
  processFulfillmentTimers,
  ShippingError,
  SHIP_LATER_HOLD_MS,
} from '../src/fulfillment.js';
import { getSettledBalance, getSystemTotal } from '../src/ledger.js';
import { privacyPremium } from '../src/shipping.js';
import { usdc, AuctionStatus, SYSTEM_ACCOUNT_IDS } from '@bidit/shared';
import { resetDb, makeFundedUser, makeRunningAuction } from './setup.js';

const T0 = new Date('2026-02-01T00:00:00.000Z').getTime();
const ADDRESS = { name: 'Kareem', line1: '1 Main St', city: 'Calgary', region: 'AB', postal: 'T2P', country: 'CA' };

beforeEach(async () => {
  await resetDb();
});

/** Drive an auction to a direct-payout sale; returns the won FulfillmentItem + players. */
async function wonAndSettled(clock: ManualClock, opts?: { deposit?: string; bid?: string }) {
  const auction = await makeRunningAuction({ startingBid: '5', clock, durationSeconds: 20 });
  const buyer = await makeFundedUser(opts?.deposit ?? '100');
  const r = await placeBid({ auctionId: auction.auctionId, userId: buyer.userId, amount: usdc(opts?.bid ?? '20') }, clock, prisma);
  expect(r.ok).toBe(true);
  clock.advance(21_000);
  const closed = await closeDueAuctions(clock, prisma);
  expect(closed[0]?.status).toBe(AuctionStatus.SETTLING);
  await settleAuctionDirect(auction.auctionId, clock, prisma);
  const item = await prisma.fulfillmentItem.findFirstOrThrow({ where: { buyerId: buyer.userId } });
  return { item, buyer, sellerId: auction.sellerId };
}

async function accountId(userId: string): Promise<string> {
  const a = await prisma.account.findUniqueOrThrow({ where: { userId } });
  return a.id;
}
async function setAddress(userId: string, addr: unknown = ADDRESS) {
  await prisma.user.update({ where: { id: userId }, data: { shippingAddress: addr as object } });
}

describe('fulfillment', () => {
  it('creates a Ready-to-Ship item on a direct-payout sale', async () => {
    const clock = new ManualClock(T0);
    const { item, buyer, sellerId } = await wonAndSettled(clock);
    expect(item.status).toBe('READY_TO_SHIP');
    expect(item.buyerId).toBe(buyer.userId);
    expect(item.sellerId).toBe(sellerId);
    expect(item.title).toBe('Charizard Holo');
    expect(item.heldUntil?.getTime()).toBe(T0 + 21_000 + SHIP_LATER_HOLD_MS);
  });

  it('buyer pays shipping: fee pool credited (not seller), item IN_SHIPMENT, ledger balances', async () => {
    const clock = new ManualClock(T0);
    const { item, buyer, sellerId } = await wonAndSettled(clock);
    await setAddress(buyer.userId);

    const sellerAcct = await accountId(sellerId);
    const sellerBefore = await getSettledBalance(sellerAcct, prisma);
    const buyerBefore = await getSettledBalance(buyer.accountId, prisma);
    const feeBefore = await getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma);

    const shipment = await createAndPayShipment({ buyerId: buyer.userId, itemIds: [item.id] }, clock, prisma);
    expect(shipment.status).toBe('PAID');
    expect(shipment.shippingFee).toBeGreaterThan(0n);

    const fee = shipment.shippingFee;
    // Platform runs shipping: the whole fee goes to the FEE pool, NOT the seller.
    expect(await getSettledBalance(sellerAcct, prisma)).toBe(sellerBefore);
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma)).toBe(feeBefore + fee);
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(buyerBefore - fee);

    const after = await prisma.fulfillmentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe('IN_SHIPMENT');
    expect(after.shipmentId).toBe(shipment.id);
    expect(await getSystemTotal(prisma)).toBe(0n); // double-entry preserved
  });

  it('seller ships then it is delivered', async () => {
    const clock = new ManualClock(T0);
    const { item, buyer, sellerId } = await wonAndSettled(clock);
    await setAddress(buyer.userId);
    const shipment = await createAndPayShipment({ buyerId: buyer.userId, itemIds: [item.id] }, clock, prisma);

    // Platform-label flow: seller confirms size → BIDit makes the label → seller ships.
    await confirmShipmentForLabel({ shipmentId: shipment.id, sellerId, lengthCm: 10, widthCm: 10, heightCm: 2, weightGrams: 30 }, clock, prisma);
    await createShipmentLabel({ shipmentId: shipment.id, labelUrl: 'https://labels.test/x.pdf', trackingNumber: '1Z999', carrier: 'UPS' }, clock, prisma);
    const shipped = await markShipmentShipped({ shipmentId: shipment.id, sellerId }, clock, prisma);
    expect(shipped.status).toBe('SHIPPED');
    expect(shipped.trackingNumber).toBe('1Z999');
    expect((await prisma.fulfillmentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('SHIPPED');

    const delivered = await markShipmentDelivered(shipment.id, clock, prisma);
    expect(delivered.status).toBe('DELIVERED');
    expect((await prisma.fulfillmentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('DELIVERED');
  });

  it('label pipeline: confirm size → BIDit makes label → seller ships (guards enforced)', async () => {
    const clock = new ManualClock(T0);
    const { item, buyer, sellerId } = await wonAndSettled(clock);
    await setAddress(buyer.userId);
    const shipment = await createAndPayShipment({ buyerId: buyer.userId, itemIds: [item.id] }, clock, prisma);
    expect(shipment.status).toBe('PAID');

    // Can't ship before BIDit has generated a label.
    await expect(markShipmentShipped({ shipmentId: shipment.id, sellerId }, clock, prisma)).rejects.toThrow(ShippingError);

    // Seller confirms the package size → LABEL_PENDING (BIDit is making the label).
    const pending = await confirmShipmentForLabel({ shipmentId: shipment.id, sellerId, lengthCm: 12, widthCm: 9, heightCm: 3, weightGrams: 45 }, clock, prisma);
    expect(pending.status).toBe('LABEL_PENDING');
    expect(pending.packageWeightG).toBe(45);

    // Operator attaches the label → LABEL_CREATED, and the seller is notified.
    const created = await createShipmentLabel({ shipmentId: shipment.id, labelUrl: 'https://labels.test/x.pdf', trackingNumber: '1Z-CONFIRM', carrier: 'UPS' }, clock, prisma);
    expect(created.status).toBe('LABEL_CREATED');
    expect(created.labelUrl).toContain('labels.test');
    expect(await prisma.notification.count({ where: { userId: sellerId, kind: 'label_ready' } })).toBe(1);

    // Now the seller can ship; tracking comes from the label, not the seller.
    const shipped = await markShipmentShipped({ shipmentId: shipment.id, sellerId }, clock, prisma);
    expect(shipped.status).toBe('SHIPPED');
    expect(shipped.trackingNumber).toBe('1Z-CONFIRM');
  });

  it('discard forfeits the item and moves no money', async () => {
    const clock = new ManualClock(T0);
    const { item, buyer } = await wonAndSettled(clock);
    const buyerBefore = await getSettledBalance(buyer.accountId, prisma);
    const discarded = await discardItem(item.id, buyer.userId, clock, prisma);
    expect(discarded.status).toBe('DISCARDED');
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(buyerBefore); // no refund — forfeit
  });

  it('auto-discards items past the 7-day hold', async () => {
    const clock = new ManualClock(T0);
    const { item } = await wonAndSettled(clock);
    clock.advance(SHIP_LATER_HOLD_MS + 22_000);
    const { discarded } = await processFulfillmentTimers(clock, prisma);
    expect(discarded).toContain(item.id);
    expect((await prisma.fulfillmentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('DISCARDED');
  });

  it('requires a shipping address before shipping', async () => {
    const clock = new ManualClock(T0);
    const { item, buyer } = await wonAndSettled(clock);
    await expect(createAndPayShipment({ buyerId: buyer.userId, itemIds: [item.id] }, clock, prisma)).rejects.toBeInstanceOf(
      ShippingError,
    );
  });

  it('rejects mixing items from two sellers in one shipment', async () => {
    const clock = new ManualClock(T0);
    const a = await wonAndSettled(clock);
    // Second sale to the SAME buyer from a different seller.
    const auction2 = await makeRunningAuction({ startingBid: '5', clock, durationSeconds: 20 });
    const r = await placeBid({ auctionId: auction2.auctionId, userId: a.buyer.userId, amount: usdc('10') }, clock, prisma);
    expect(r.ok).toBe(true);
    clock.advance(21_000);
    await closeDueAuctions(clock, prisma);
    await settleAuctionDirect(auction2.auctionId, clock, prisma);
    const item2 = await prisma.fulfillmentItem.findFirstOrThrow({ where: { buyerId: a.buyer.userId, sellerId: auction2.sellerId } });
    await setAddress(a.buyer.userId);
    await expect(
      createAndPayShipment({ buyerId: a.buyer.userId, itemIds: [a.item.id, item2.id] }, clock, prisma),
    ).rejects.toBeInstanceOf(ShippingError);
  });

  it('private shipping charges a privacy premium to the fee pool and hides the buyer address', async () => {
    const clock = new ManualClock(T0);
    const { item, buyer } = await wonAndSettled(clock);
    await setAddress(buyer.userId);
    const feeBefore = await getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma);
    const platformBefore = await getSettledBalance(SYSTEM_ACCOUNT_IDS.PLATFORM, prisma);

    const shipment = await createAndPayShipment({ buyerId: buyer.userId, itemIds: [item.id], mode: 'PRIVATE' }, clock, prisma);
    expect(shipment.privacyFee).toBe(privacyPremium());
    // Base shipping + privacy premium both land in the FEE pool; buyback pool untouched.
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma)).toBe(feeBefore + shipment.shippingFee + shipment.privacyFee);
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.PLATFORM, prisma)).toBe(platformBefore);
    // shipTo shown to the seller is the hub, NOT the buyer's real address.
    expect((shipment.shipTo as { line1?: string }).line1).not.toBe(ADDRESS.line1);
    expect((shipment.privateLeg2 as { line1?: string }).line1).toBe(ADDRESS.line1);
    expect(await getSystemTotal(prisma)).toBe(0n);
  });
});
