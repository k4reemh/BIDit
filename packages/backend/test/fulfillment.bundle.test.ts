import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { createAuction, startAuction, placeBid, closeDueAuctions } from '../src/auction.js';
import { settleAuctionDirect } from '../src/orders.js';
import { markShipmentShipped } from '../src/fulfillment.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeFundedUser, makeUser } from './setup.js';

const T0 = new Date('2026-03-01T00:00:00.000Z').getTime();
const ADDRESS = { name: 'Kareem', line1: '1 Main St', city: 'Calgary', region: 'AB', postal: 'T2P', country: 'CA' };

beforeEach(async () => {
  await resetDb();
});

async function makeBundlingSeller() {
  const seller = await makeUser('seller');
  await prisma.sellerProfile.create({ data: { userId: seller.userId, verified: true, weeklyBundling: true } });
  const listing = await prisma.listing.create({
    data: { sellerId: seller.userId, title: 'Charizard Holo', photos: [], startingBid: usdc('1'), quantity: 20, weightGrams: 60, status: 'QUEUED' },
  });
  return { sellerId: seller.userId, listingId: listing.id };
}

async function sale(listingId: string, buyerId: string, bid: string, clock: ManualClock) {
  const auctionId = await createAuction({ listingId, startingBid: usdc('1'), durationSeconds: 20 }, prisma);
  await startAuction(auctionId, clock, prisma);
  const r = await placeBid({ auctionId, userId: buyerId, amount: usdc(bid) }, clock, prisma);
  expect(r.ok).toBe(true);
  clock.advance(21_000);
  await closeDueAuctions(clock, prisma);
  await settleAuctionDirect(auctionId, clock, prisma);
  const order = await prisma.order.findFirstOrThrow({ where: { auctionId } });
  return prisma.fulfillmentItem.findUniqueOrThrow({ where: { orderId: order.id } });
}

describe('weekly bundling', () => {
  it('charges shipping once a week and rides later wins free', async () => {
    const clock = new ManualClock(T0);
    const { sellerId, listingId } = await makeBundlingSeller();
    const buyer = await makeFundedUser('100');
    await prisma.user.update({ where: { id: buyer.userId }, data: { bundleShipping: true, shippingAddress: ADDRESS } });

    const item1 = await sale(listingId, buyer.userId, '5', clock);
    expect(item1.status).toBe('IN_SHIPMENT');
    const shipments1 = await prisma.shipment.findMany({ where: { buyerId: buyer.userId } });
    expect(shipments1).toHaveLength(1);
    expect(shipments1[0]!.mode).toBe('WEEKLY_BUNDLE');
    expect(shipments1[0]!.status).toBe('PAID');
    expect(shipments1[0]!.shippingFee).toBeGreaterThan(0n);

    // Second win the same week: same shipment, no extra shipping charge.
    const item2 = await sale(listingId, buyer.userId, '6', clock);
    expect(item2.status).toBe('IN_SHIPMENT');
    expect(item2.shipmentId).toBe(item1.shipmentId);
    const shipments2 = await prisma.shipment.findMany({ where: { buyerId: buyer.userId } });
    expect(shipments2).toHaveLength(1); // still exactly one shipment
    const passes = await prisma.weeklyShippingPass.findMany({ where: { buyerId: buyer.userId, sellerId } });
    expect(passes).toHaveLength(1);
  });

  it('starts a fresh charge after the seller ships the bundle', async () => {
    const clock = new ManualClock(T0);
    const { sellerId, listingId } = await makeBundlingSeller();
    const buyer = await makeFundedUser('100');
    await prisma.user.update({ where: { id: buyer.userId }, data: { bundleShipping: true, shippingAddress: ADDRESS } });

    const item1 = await sale(listingId, buyer.userId, '5', clock);
    await markShipmentShipped({ shipmentId: item1.shipmentId!, sellerId, trackingNumber: 'T1' }, clock, prisma);
    const pass = await prisma.weeklyShippingPass.findFirstOrThrow({ where: { shipmentId: item1.shipmentId! } });
    expect(pass.closedAt).not.toBeNull();

    const item3 = await sale(listingId, buyer.userId, '7', clock);
    expect(item3.shipmentId).not.toBe(item1.shipmentId); // new week → new shipment
    expect(await prisma.shipment.count({ where: { buyerId: buyer.userId } })).toBe(2);
  });

  it('falls back to Standard when the buyer has not opted in', async () => {
    const clock = new ManualClock(T0);
    const { listingId } = await makeBundlingSeller();
    const buyer = await makeFundedUser('100');
    await prisma.user.update({ where: { id: buyer.userId }, data: { shippingAddress: ADDRESS } }); // no bundleShipping
    const item = await sale(listingId, buyer.userId, '5', clock);
    expect(item.status).toBe('READY_TO_SHIP');
    expect(await prisma.shipment.count({ where: { buyerId: buyer.userId } })).toBe(0);
  });

  it('falls back to Standard when the buyer cannot afford shipping', async () => {
    const clock = new ManualClock(T0);
    const { listingId } = await makeBundlingSeller();
    const buyer = await makeFundedUser('5'); // exactly the bid, nothing left for shipping
    await prisma.user.update({ where: { id: buyer.userId }, data: { bundleShipping: true, shippingAddress: ADDRESS } });
    const item = await sale(listingId, buyer.userId, '5', clock);
    expect(item.status).toBe('READY_TO_SHIP');
    expect(await prisma.shipment.count({ where: { buyerId: buyer.userId } })).toBe(0);
  });

  it('auto-ships each win for a ship-to-address buyer even when the seller does not bundle', async () => {
    const clock = new ManualClock(T0);
    const seller = await makeUser('seller');
    await prisma.sellerProfile.create({
      data: { userId: seller.userId, verified: true, weeklyBundling: false, originCountry: 'CA', originRegion: 'AB', originPostal: 'T2P' },
    });
    const listing = await prisma.listing.create({
      data: { sellerId: seller.userId, title: 'Pikachu', photos: [], startingBid: usdc('1'), quantity: 20, weightGrams: 60, status: 'QUEUED' },
    });
    const buyer = await makeFundedUser('100');
    await prisma.user.update({ where: { id: buyer.userId }, data: { bundleShipping: true, shippingAddress: ADDRESS } });

    const item = await sale(listing.id, buyer.userId, '5', clock);
    expect(item.status).toBe('IN_SHIPMENT'); // shipped immediately on win
    const shipments = await prisma.shipment.findMany({ where: { buyerId: buyer.userId } });
    expect(shipments).toHaveLength(1);
    expect(shipments[0]!.status).toBe('PAID');
    // Non-bundling seller → no weekly pass; each win pays its own shipping.
    expect(await prisma.weeklyShippingPass.count({ where: { buyerId: buyer.userId } })).toBe(0);
  });
});
