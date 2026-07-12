import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { estimateShipment, estimateListingShipping } from '../src/fulfillment.js';
import { quoteShipping, multiItemSurcharge } from '../src/shipping.js';

// Proves the estimate reuses seller ship-from + buyer address + item weight and
// reports both the UPS retail number and the 80% charged fee.
describe('estimateShipment (money-path integration)', () => {
  beforeEach(async () => {
    await prisma.fulfillmentItem.deleteMany({});
  });

  it('estimates from seller origin → buyer address for the real item weight', async () => {
    const buyer = await prisma.user.create({
      data: { handle: 'buyer_' + Date.now(), shippingAddress: { line1: '1 Yonge', city: 'Toronto', region: 'ON', postal: 'M5V 1J1', country: 'Canada' } },
    });
    const seller = await prisma.user.create({ data: { handle: 'seller_' + Date.now() } });
    await prisma.sellerProfile.create({
      data: { userId: seller.id, originCountry: 'Canada', originRegion: 'AB', originCity: 'Calgary', originPostal: 'T2P 1J9' },
    });
    const item = await prisma.fulfillmentItem.create({
      data: { orderId: 'o_' + Date.now(), buyerId: buyer.id, sellerId: seller.id, listingId: 'l1', title: 'Tony Chopper', weightGrams: 57, amount: 93_000_000n, status: 'READY_TO_SHIP', heldUntil: new Date(Date.now() + 1e9) },
    });

    const est = await estimateShipment({ buyerId: buyer.id, itemIds: [item.id] }, prisma);
    expect(est.hasAddress).toBe(true);
    // Calgary→Toronto is a far domestic zone; 80% of retail, both positive.
    expect(est.carrierRetail).toBeGreaterThan(0n);
    expect(est.shippingFee).toBe((est.carrierRetail * 80n) / 100n);
    expect(est.total).toBe(est.shippingFee);
    console.log('  → UPS retail $' + (Number(est.carrierRetail)/1e6).toFixed(2) + ' → buyer pays $' + (Number(est.shippingFee)/1e6).toFixed(2));
  });

  it('flags a missing buyer address instead of throwing', async () => {
    const buyer = await prisma.user.create({ data: { handle: 'noaddr_' + Date.now() } });
    const seller = await prisma.user.create({ data: { handle: 'seller2_' + Date.now() } });
    await prisma.sellerProfile.create({ data: { userId: seller.id, originCountry: 'Canada', originRegion: 'AB', originPostal: 'T2P 1J9' } });
    const item = await prisma.fulfillmentItem.create({
      data: { orderId: 'o2_' + Date.now(), buyerId: buyer.id, sellerId: seller.id, listingId: 'l2', title: 'X', weightGrams: 57, amount: 1_000_000n, status: 'READY_TO_SHIP', heldUntil: new Date(Date.now() + 1e9) },
    });
    const est = await estimateShipment({ buyerId: buyer.id, itemIds: [item.id] }, prisma);
    expect(est.hasAddress).toBe(false);
    expect(est.shippingFee).toBeGreaterThan(0n); // still returns a ballpark
  });

  it('applies a 3% multi-item surcharge on a shipment of several items', async () => {
    const dest = { line1: '1 Yonge', city: 'Toronto', region: 'ON', postal: 'M5V 1J1', country: 'Canada' };
    const buyer = await prisma.user.create({ data: { handle: 'multi_' + Date.now(), shippingAddress: dest } });
    const seller = await prisma.user.create({ data: { handle: 'ms_' + Date.now() } });
    const origin = { country: 'Canada', region: 'AB', city: 'Calgary', postal: 'T2P 1J9' };
    await prisma.sellerProfile.create({ data: { userId: seller.id, originCountry: origin.country, originRegion: origin.region, originCity: origin.city, originPostal: origin.postal } });
    const mk = (n: number) => prisma.fulfillmentItem.create({
      data: { orderId: `om_${Date.now()}_${n}`, buyerId: buyer.id, sellerId: seller.id, listingId: 'l', title: 'Card ' + n, weightGrams: 57, amount: 1_000_000n, status: 'READY_TO_SHIP', heldUntil: new Date(Date.now() + 1e9) },
    });
    const a = await mk(1); const b = await mk(2); const c = await mk(3);

    const three = await estimateShipment({ buyerId: buyer.id, itemIds: [a.id, b.id, c.id] }, prisma);
    // Three 57g items → 171g combined, then +6% (two extra items).
    const combined = quoteShipping(origin, dest, 171);
    expect(three.shippingFee).toBe(multiItemSurcharge(combined, 3));
    // Adding items raises the fee vs. a single item.
    const one = await estimateShipment({ buyerId: buyer.id, itemIds: [a.id] }, prisma);
    expect(three.shippingFee).toBeGreaterThan(one.shippingFee);
  });

  it('estimates shipping for a single listing before it is won', async () => {
    const dest = { line1: '1 Yonge', city: 'Toronto', region: 'ON', postal: 'M5V 1J1', country: 'Canada' };
    const buyer = await prisma.user.create({ data: { handle: 'lb_' + Date.now(), shippingAddress: dest } });
    const seller = await prisma.user.create({ data: { handle: 'ls_' + Date.now() } });
    await prisma.sellerProfile.create({ data: { userId: seller.id, originCountry: 'Canada', originRegion: 'AB', originPostal: 'T2P 1J9' } });
    const listing = await prisma.listing.create({
      data: { sellerId: seller.id, title: 'Charizard', photos: [], startingBid: 1_000_000n, quantity: 1, weightGrams: 30, status: 'QUEUED' },
    });
    const est = await estimateListingShipping(buyer.id, listing.id, prisma);
    expect(est.hasAddress).toBe(true);
    expect(est.shippingFee).toBeGreaterThan(0n);
    expect(est.privacyFee).toBeGreaterThan(0n); // flat private-shipping fee is reported
  });
});
