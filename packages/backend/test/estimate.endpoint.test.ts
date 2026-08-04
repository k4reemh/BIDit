import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { estimateShipment, estimateListingShipping } from '../src/fulfillment.js';
import { quoteShipping } from '../src/shipping.js';
import { combineParcels, defaultParcel } from '@bidit/shared';
import { systemClock } from '../src/clock.js';
import { shipMarkupMicros } from '../src/ship-charge.js';

// Proves the estimate reuses the seller's ship-from, the buyer's address and the
// item weight, and that a priceable lane hands back a quote id (the only thing
// the charge path will accept).
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

    const est = await estimateShipment({ buyerId: buyer.id, itemIds: [item.id] }, systemClock, prisma);
    expect(est.hasAddress).toBe(true);
    expect(est.shippingFee).toBeGreaterThan(0n);
    expect(est.total).toBe(est.shippingFee);
    // A real address gets a quote id, which is the only thing that can be paid.
    expect(est.quoteId).toBeTruthy();
  });

  it('flags a missing buyer address instead of throwing', async () => {
    const buyer = await prisma.user.create({ data: { handle: 'noaddr_' + Date.now() } });
    const seller = await prisma.user.create({ data: { handle: 'seller2_' + Date.now() } });
    await prisma.sellerProfile.create({ data: { userId: seller.id, originCountry: 'Canada', originRegion: 'AB', originPostal: 'T2P 1J9' } });
    const item = await prisma.fulfillmentItem.create({
      data: { orderId: 'o2_' + Date.now(), buyerId: buyer.id, sellerId: seller.id, listingId: 'l2', title: 'X', weightGrams: 57, amount: 1_000_000n, status: 'READY_TO_SHIP', heldUntil: new Date(Date.now() + 1e9) },
    });
    const est = await estimateShipment({ buyerId: buyer.id, itemIds: [item.id] }, systemClock, prisma);
    expect(est.hasAddress).toBe(false);
    expect(est.shippingFee).toBeGreaterThan(0n); // still returns a ballpark
    // ...but no quote: there is no lane priced yet, so nothing to charge against.
    expect(est.quoteId).toBeNull();
  });

  it('prices several items as one combined package, not a per-item surcharge', async () => {
    const dest = { line1: '1 Yonge', city: 'Toronto', region: 'ON', postal: 'M5V 1J1', country: 'Canada' };
    const buyer = await prisma.user.create({ data: { handle: 'multi_' + Date.now(), shippingAddress: dest } });
    const seller = await prisma.user.create({ data: { handle: 'ms_' + Date.now() } });
    const origin = { country: 'Canada', region: 'AB', city: 'Calgary', postal: 'T2P 1J9' };
    await prisma.sellerProfile.create({ data: { userId: seller.id, originCountry: origin.country, originRegion: origin.region, originCity: origin.city, originPostal: origin.postal } });
    const mk = (n: number) => prisma.fulfillmentItem.create({
      data: { orderId: `om_${Date.now()}_${n}`, buyerId: buyer.id, sellerId: seller.id, listingId: 'l', title: 'Card ' + n, weightGrams: 57, amount: 1_000_000n, status: 'READY_TO_SHIP', heldUntil: new Date(Date.now() + 1e9) },
    });
    const a = await mk(1); const b = await mk(2); const c = await mk(3);

    const three = await estimateShipment({ buyerId: buyer.id, itemIds: [a.id, b.id, c.id] }, systemClock, prisma);
    // Three 57g items in the default mailer: 171g in whatever single package
    // actually holds all three, which is what the carrier bills for.
    const box = combineParcels([defaultParcel(), defaultParcel(), defaultParcel()]);
    // No Shippo key in tests, so this is the model fallback, plus the flat
    // handling markup that every charged price carries.
    const expected = quoteShipping(origin, dest, 171, {
      lengthCm: box.dims.lengthMm / 10,
      widthCm: box.dims.widthMm / 10,
      heightCm: box.dims.heightMm / 10,
    }) + shipMarkupMicros();
    expect(three.shippingFee).toBe(expected);
    // Three items need a bigger box than one, so they cost more to post.
    const one = await estimateShipment({ buyerId: buyer.id, itemIds: [a.id] }, systemClock, prisma);
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
