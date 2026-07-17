import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { createAuction, startAuction, placeBid, closeDueAuctions } from '../src/auction.js';
import { settleAuctionDirect } from '../src/orders.js';
import { createAndPayShipment, confirmShipmentForLabel, createShipmentLabel, markShipmentShipped } from '../src/fulfillment.js';
import { listNotifications } from '../src/notifications.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeFundedUser, makeRunningAuction } from './setup.js';

const T0 = new Date('2026-04-01T00:00:00.000Z').getTime();
const ADDRESS = { name: 'K', line1: '1 Main St', city: 'Calgary', region: 'AB', postal: 'T2P', country: 'CA' };

beforeEach(async () => {
  await resetDb();
});

describe('notifications', () => {
  it('notifies buyer and seller on a win, and the buyer when it ships', async () => {
    const clock = new ManualClock(T0);
    const auction = await makeRunningAuction({ startingBid: '5', clock, durationSeconds: 20 });
    const buyer = await makeFundedUser('100');
    await prisma.user.update({ where: { id: buyer.userId }, data: { shippingAddress: ADDRESS } });
    await placeBid({ auctionId: auction.auctionId, userId: buyer.userId, amount: usdc('20') }, clock, prisma);
    clock.advance(21_000);
    await closeDueAuctions(clock, prisma);
    await settleAuctionDirect(auction.auctionId, clock, prisma);

    const buyerN = await listNotifications(buyer.userId, prisma);
    const sellerN = await listNotifications(auction.sellerId, prisma);
    expect(buyerN.items.some((n) => n.kind === 'won')).toBe(true);
    expect(buyerN.unread).toBeGreaterThan(0);
    expect(sellerN.items.some((n) => n.kind === 'sold')).toBe(true);

    const item = await prisma.fulfillmentItem.findFirstOrThrow({ where: { buyerId: buyer.userId } });
    const shipment = await createAndPayShipment({ buyerId: buyer.userId, itemIds: [item.id] }, clock, prisma);
    await confirmShipmentForLabel({ shipmentId: shipment.id, sellerId: auction.sellerId, lengthCm: 10, widthCm: 10, heightCm: 2, weightGrams: 30 }, clock, prisma);
    await createShipmentLabel({ shipmentId: shipment.id, labelUrl: 'https://labels.test/x.pdf', trackingNumber: '1Z' }, clock, prisma);
    await markShipmentShipped(shipment.id, clock, prisma);

    const afterShip = await listNotifications(buyer.userId, prisma);
    expect(afterShip.items.some((n) => n.kind === 'shipped')).toBe(true);
  });

  it('marks notifications read', async () => {
    const clock = new ManualClock(T0);
    const auction = await makeRunningAuction({ startingBid: '5', clock, durationSeconds: 20 });
    const buyer = await makeFundedUser('100');
    await placeBid({ auctionId: auction.auctionId, userId: buyer.userId, amount: usdc('20') }, clock, prisma);
    clock.advance(21_000);
    await closeDueAuctions(clock, prisma);
    await settleAuctionDirect(auction.auctionId, clock, prisma);

    const before = await listNotifications(buyer.userId, prisma);
    expect(before.unread).toBeGreaterThan(0);
    const { markAllRead } = await import('../src/notifications.js');
    await markAllRead(buyer.userId, prisma);
    const after = await listNotifications(buyer.userId, prisma);
    expect(after.unread).toBe(0);
  });
});
