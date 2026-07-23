import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { DevWalletEscrow } from '../src/escrow.js';
import { placeBid, closeDueAuctions } from '../src/auction.js';
import { settleAuction, processOrderTimers, disputeShipment, releaseOrdersForShipment, DISPUTE_WINDOW_MS } from '../src/orders.js';
import { createAndPayShipment, confirmShipmentForLabel, createShipmentLabel } from '../src/fulfillment.js';
import { ShipmentTracker, MockTrackingProvider, resolveCarrierToken, guessCarrier } from '../src/tracking.js';
import { getSettledBalance, getBuybackPending, getSystemTotal } from '../src/ledger.js';
import { usdc, OrderStatus, SYSTEM_ACCOUNT_IDS } from '@bidit/shared';
import { resetDb, makeFundedUser, makeRunningAuction } from './setup.js';

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const ADDRESS = { name: 'Card Fan', line1: '1 Yonge St', city: 'Toronto', region: 'ON', postal: 'M5V 1J1', country: 'Canada' };

beforeEach(async () => { await resetDb(); });

/** Escrow win → LOCKED order + a labelled shipment ('TRK1'), ready to track. */
async function shippedEscrowOrder(clock: ManualClock) {
  const escrow = new DevWalletEscrow(prisma);
  const auction = await makeRunningAuction({ startingBid: '5', clock, durationSeconds: 20 });
  await prisma.sellerProfile.create({
    data: { userId: auction.sellerId, originCountry: 'Canada', originRegion: 'AB', originCity: 'Calgary', originPostal: 'T2P 1J9' },
  });
  const buyer = await makeFundedUser('100');
  await prisma.user.update({ where: { id: buyer.userId }, data: { shippingAddress: ADDRESS } });
  await placeBid({ auctionId: auction.auctionId, userId: buyer.userId, amount: usdc('20') }, clock, prisma);
  clock.advance(21_000);
  await closeDueAuctions(clock, prisma);
  const order = (await settleAuction(auction.auctionId, escrow, clock, prisma))!;
  const item = await prisma.fulfillmentItem.findFirstOrThrow({ where: { orderId: order.id } });
  const shipment = await createAndPayShipment({ buyerId: buyer.userId, itemIds: [item.id] }, clock, prisma);
  await confirmShipmentForLabel({ shipmentId: shipment.id, sellerId: auction.sellerId, lengthCm: 10, widthCm: 10, heightCm: 2, weightGrams: 30 }, clock, prisma);
  await createShipmentLabel({ shipmentId: shipment.id, labelUrl: 'https://l/x.pdf', trackingNumber: 'TRK1', carrier: 'shippo' }, clock, prisma);
  return { escrow, order, shipment, buyer, sellerId: auction.sellerId };
}

describe('Shippo carrier token resolution', () => {
  it('maps the names an operator actually types to exact Shippo tokens', () => {
    expect(resolveCarrierToken('UPS', '1Z999AA10123456784')).toBe('ups');
    expect(resolveCarrierToken('USPS', '9400111899223197428490')).toBe('usps');
    expect(resolveCarrierToken('FedEx', '123456789012')).toBe('fedex');
    // Multi-word carriers: the old lowercase+strip turned these into 404s.
    expect(resolveCarrierToken('Canada Post', '1234567890123456')).toBe('canada_post');
    expect(resolveCarrierToken('DHL', '1234567890')).toBe('dhl_express');
    // An exact token passes through untouched.
    expect(resolveCarrierToken('canada_post', '1234567890123456')).toBe('canada_post');
  });

  it('falls back to the tracking-number shape when the carrier is blank', () => {
    // The real-world bug: carrier was optional, so labels were saved without one.
    expect(resolveCarrierToken('', '1Z999AA10123456784')).toBe('ups');
    expect(resolveCarrierToken(null, '9400111899223197428490')).toBe('usps');
    expect(resolveCarrierToken(undefined, 'LN123456789US')).toBe('usps');
  });

  it('returns null rather than the `shippo` TEST carrier when it cannot tell', () => {
    // Querying the test carrier with a real number 404s — which is exactly how a
    // delivered package silently stayed "not delivered".
    expect(resolveCarrierToken('', 'NOTATRACKINGNUMBER')).toBeNull();
    expect(resolveCarrierToken('', '')).toBeNull();
    expect(guessCarrier('random-123')).toBeNull();
  });
});

describe('shipment tracking → delivery → escrow release', () => {
  it('delivery opens the 2-day window, then auto-releases 95/4/1', async () => {
    const clock = new ManualClock(T0);
    const { escrow, order, shipment, sellerId } = await shippedEscrowOrder(clock);

    // Shippo reports delivered → tracker advances the package and the order.
    const provider = new MockTrackingProvider();
    provider.set('TRK1', 'delivered');
    expect(await new ShipmentTracker(provider, prisma, clock).tick()).toBe(1);

    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe('DELIVERED');
    const inWindow = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(inWindow.status).toBe(OrderStatus.DISPUTE_WINDOW);
    expect(inWindow.disputeWindowEndsAt).not.toBeNull();

    const sellerAcct = (await prisma.account.findUniqueOrThrow({ where: { userId: sellerId } })).id;
    const feeBefore = await getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma); // already holds the shipping fee

    // 2 days pass, no dispute → auto-release.
    clock.advance(DISPUTE_WINDOW_MS + 1000);
    expect((await processOrderTimers(escrow, clock, prisma)).released).toContain(order.id);

    expect(await getSettledBalance(sellerAcct, prisma)).toBe(usdc('19')); // 95%
    expect(await getBuybackPending(prisma)).toBe(usdc('0.8')); // 4% buyback
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma)).toBe(feeBefore + usdc('0.2')); // +1% fee
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('a buyer dispute (reason + detail + photos) is recorded and halts auto-release', async () => {
    const clock = new ManualClock(T0);
    const { escrow, order, shipment, buyer } = await shippedEscrowOrder(clock);
    const provider = new MockTrackingProvider();
    provider.set('TRK1', 'delivered');
    await new ShipmentTracker(provider, prisma, clock).tick();

    const n = await disputeShipment(
      shipment.id,
      buyer.userId,
      { reason: 'damaged', detail: 'The corner is crushed.', photos: ['data:image/png;base64,AAA'] },
      clock,
      prisma,
    );
    expect(n).toBe(1);

    const disputed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(disputed.status).toBe(OrderStatus.DISPUTED);
    expect(disputed.disputeReason).toBe('damaged');
    expect(disputed.disputeDetail).toContain('crushed');
    expect(disputed.disputePhotos).toEqual(['data:image/png;base64,AAA']);

    // A disputed order is NOT auto-released when its window elapses.
    clock.advance(DISPUTE_WINDOW_MS + 1000);
    expect((await processOrderTimers(escrow, clock, prisma)).released).not.toContain(order.id);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.DISPUTED);
  });

  it('admin release-now releases the escrow immediately, skipping the 2-day wait', async () => {
    const clock = new ManualClock(T0);
    const { escrow, order, shipment, sellerId } = await shippedEscrowOrder(clock);
    const provider = new MockTrackingProvider();
    provider.set('TRK1', 'delivered');
    await new ShipmentTracker(provider, prisma, clock).tick();

    // No clock advance — release right away (as the admin test control does).
    expect(await releaseOrdersForShipment(shipment.id, escrow, clock, prisma)).toContain(order.id);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.RELEASED);
    const sellerAcct = (await prisma.account.findUniqueOrThrow({ where: { userId: sellerId } })).id;
    expect(await getSettledBalance(sellerAcct, prisma)).toBe(usdc('19')); // 95%
  });
});
