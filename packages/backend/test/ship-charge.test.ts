import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/db.js';
import { estimateShipment, createAndPayShipment } from '../src/fulfillment.js';
import {
  MockLiveRates,
  setLiveRateProvider,
  QuoteStaleError,
  hashItemIds,
  shipMarkupMicros,
} from '../src/ship-charge.js';
import type { ShippoRate } from '../src/shippo.js';
import { deposit, getOrCreateUserAccount } from '../src/ledger.js';
import { usdc, OrderStatus } from '@bidit/shared';
import { systemClock } from '../src/clock.js';
import { estimateShipping } from '../src/ship-estimate.js';
import { resetDb } from './setup.js';

const rate = (over: Partial<ShippoRate> = {}): ShippoRate => ({
  rateId: 'rate_abc',
  carrier: 'USPS',
  service: 'Ground Advantage',
  serviceToken: 'usps_ground_advantage',
  amount: 9.4,
  currency: 'USD',
  estimatedDays: 3,
  ...over,
});

const ADDRESS = { name: 'Buyer', line1: '1 Yonge St', city: 'Toronto', region: 'ON', postal: 'M5V 1J1', country: 'Canada' };

let live: MockLiveRates;

beforeEach(async () => {
  await resetDb();
  live = new MockLiveRates([rate()]);
  setLiveRateProvider(live);
  delete process.env.BIDIT_SHIP_MARKUP_CENTS;
});

afterEach(() => {
  setLiveRateProvider(null);
  delete process.env.BIDIT_SHIP_MARKUP_CENTS;
});

/** A buyer with an address and a balance, a seller with a ship-from, and N won
 *  items sitting in Ready to ship behind live LOCKED orders. */
async function scenario(opts: { items?: number; funds?: string } = {}) {
  const n = opts.items ?? 1;
  const buyer = await prisma.user.create({ data: { handle: 'b_' + Math.random().toString(36).slice(2, 10), shippingAddress: ADDRESS } });
  const seller = await prisma.user.create({ data: { handle: 's_' + Math.random().toString(36).slice(2, 10) } });
  await prisma.sellerProfile.create({
    data: {
      userId: seller.id, originName: 'Shop', originLine1: '1 Test St',
      originCountry: 'Canada', originRegion: 'AB', originCity: 'Calgary', originPostal: 'T2P 1J9',
    },
  });
  const accountId = await getOrCreateUserAccount(buyer.id, prisma);
  await deposit({ accountId, amount: usdc(opts.funds ?? '500'), refId: 'seed-' + buyer.id }, prisma);

  const listing = await prisma.listing.create({
    data: { sellerId: seller.id, title: 'Card', photos: [], startingBid: usdc('1'), weightGrams: 60 },
  });
  const items = [];
  for (let i = 0; i < n; i += 1) {
    const order = await prisma.order.create({
      data: {
        buyerId: buyer.id, sellerId: seller.id, listingId: listing.id,
        amount: usdc('20'), platformFee: 0n, sellerProceeds: usdc('20'), status: OrderStatus.LOCKED,
      },
    });
    items.push(
      await prisma.fulfillmentItem.create({
        data: {
          orderId: order.id, buyerId: buyer.id, sellerId: seller.id, listingId: listing.id,
          title: 'Card ' + i, weightGrams: 60, amount: usdc('20'),
          status: 'READY_TO_SHIP', heldUntil: new Date(Date.now() + 1e9),
        },
      }),
    );
  }
  return { buyer, seller, accountId, items, ids: items.map((i) => i.id) };
}

describe('the buyer is charged the carrier rate they were shown', () => {
  it('quotes the cheapest live rate plus the markup, and charges exactly that', async () => {
    const { buyer, ids, accountId } = await scenario();
    live.set([rate({ amount: 14.0, rateId: 'r_pricey' }), rate({ amount: 9.4, rateId: 'r_cheap' }), rate({ amount: 22.0 })]);

    const est = await estimateShipment({ buyerId: buyer.id, itemIds: ids }, systemClock, prisma);
    expect(est.shippingFee).toBe(usdc('9.4') + shipMarkupMicros());
    expect(est.carrier).toBe('USPS');
    expect(est.quoteId).toBeTruthy();

    const before = await prisma.ledgerEntry.aggregate({ where: { accountId }, _sum: { amount: true } });
    const shipment = await createAndPayShipment({ buyerId: buyer.id, itemIds: ids, quoteId: est.quoteId! }, systemClock, prisma);
    // The ledger moved the quoted number, not a freshly computed one.
    expect(shipment.shippingFee).toBe(est.shippingFee);
    const after = await prisma.ledgerEntry.aggregate({ where: { accountId }, _sum: { amount: true } });
    expect((before._sum.amount ?? 0n) - (after._sum.amount ?? 0n)).toBe(est.shippingFee);

    // And the rate object is kept, so the label can be bought on the same rate.
    const quote = await prisma.shipQuote.findUniqueOrThrow({ where: { id: est.quoteId! } });
    expect(quote.rateObjectId).toBe('r_cheap');
    expect(quote.source).toBe('shippo');
    expect(quote.shipmentId).toBe(shipment.id);
  });

  it('honours the configured markup', async () => {
    process.env.BIDIT_SHIP_MARKUP_CENTS = '0';
    const { buyer, ids } = await scenario();
    const est = await estimateShipment({ buyerId: buyer.id, itemIds: ids }, systemClock, prisma);
    expect(est.shippingFee).toBe(usdc('9.4'));
  });

  it('converts a CAD rate into the USD the ledger settles in', async () => {
    process.env.BIDIT_SHIP_MARKUP_CENTS = '0';
    process.env.BIDIT_CAD_USD = '0.5';
    try {
      const { buyer, ids } = await scenario();
      live.set([rate({ amount: 20, currency: 'CAD' })]);
      const est = await estimateShipment({ buyerId: buyer.id, itemIds: ids }, systemClock, prisma);
      expect(est.shippingFee).toBe(usdc('10')); // 20 CAD at 0.5
    } finally {
      delete process.env.BIDIT_CAD_USD;
    }
  });

  it('ignores rates it cannot price rather than treating them as free', async () => {
    process.env.BIDIT_SHIP_MARKUP_CENTS = '0';
    const { buyer, ids } = await scenario();
    // A zero amount and an unknown currency are broken rates, not cheap ones.
    // Picking either would hand the buyer a label BIDit pays for.
    live.set([rate({ amount: 0 }), rate({ amount: 1, currency: 'JPY' }), rate({ amount: 12.5 })]);
    const est = await estimateShipment({ buyerId: buyer.id, itemIds: ids }, systemClock, prisma);
    expect(est.shippingFee).toBe(usdc('12.5'));
  });
});

describe('the carrier being unreachable does not break checkout', () => {
  it('falls back to the local model when Shippo throws', async () => {
    const { buyer, ids } = await scenario();
    live.set(new Error('shippo 503'));
    const est = await estimateShipment({ buyerId: buyer.id, itemIds: ids }, systemClock, prisma);
    expect(est.shippingFee).toBeGreaterThan(0n);
    expect(est.quoteId).toBeTruthy(); // still payable
    const quote = await prisma.shipQuote.findUniqueOrThrow({ where: { id: est.quoteId! } });
    expect(quote.source).toBe('model');
    expect(quote.rateObjectId).toBeNull();
    // And it still charges, so a buyer is never stranded holding an item.
    const shipment = await createAndPayShipment({ buyerId: buyer.id, itemIds: ids, quoteId: est.quoteId! }, systemClock, prisma);
    expect(shipment.status).toBe('PAID');
  });

  it('falls back when the lane returns no rates at all', async () => {
    const { buyer, ids } = await scenario();
    live.set([]);
    const est = await estimateShipment({ buyerId: buyer.id, itemIds: ids }, systemClock, prisma);
    const quote = await prisma.shipQuote.findUniqueOrThrow({ where: { id: est.quoteId! } });
    expect(quote.source).toBe('model');
  });

  it('never calls the carrier when there is no address to price', async () => {
    const { buyer, ids } = await scenario();
    // DbNull, not undefined: Prisma reads undefined as "leave this field alone".
    await prisma.user.update({ where: { id: buyer.id }, data: { shippingAddress: Prisma.DbNull } });
    const est = await estimateShipment({ buyerId: buyer.id, itemIds: ids }, systemClock, prisma);
    expect(est.hasAddress).toBe(false);
    expect(est.quoteId).toBeNull(); // nothing chargeable exists
    expect(live.calls).toBe(0);
  });
});

describe('a quote binds the price to this buyer, these items, once', () => {
  it('refuses to charge without one', async () => {
    const { buyer, ids } = await scenario();
    await expect(createAndPayShipment({ buyerId: buyer.id, itemIds: ids }, systemClock, prisma)).rejects.toBeInstanceOf(
      QuoteStaleError,
    );
  });

  it('cannot be spent twice, so a double click charges once', async () => {
    const { buyer, ids, accountId } = await scenario();
    const est = await estimateShipment({ buyerId: buyer.id, itemIds: ids }, systemClock, prisma);
    const before = await prisma.ledgerEntry.aggregate({ where: { accountId }, _sum: { amount: true } });

    const results = await Promise.allSettled([
      createAndPayShipment({ buyerId: buyer.id, itemIds: ids, quoteId: est.quoteId! }, systemClock, prisma),
      createAndPayShipment({ buyerId: buyer.id, itemIds: ids, quoteId: est.quoteId! }, systemClock, prisma),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const after = await prisma.ledgerEntry.aggregate({ where: { accountId }, _sum: { amount: true } });
    expect((before._sum.amount ?? 0n) - (after._sum.amount ?? 0n)).toBe(est.shippingFee);
    expect(await prisma.shipment.count({ where: { buyerId: buyer.id, status: 'PAID' } })).toBe(1);
  });

  it('cannot be replayed against a different set of items', async () => {
    const { buyer, ids } = await scenario({ items: 3 });
    // Price one card, then try to ship all three on that quote.
    const est = await estimateShipment({ buyerId: buyer.id, itemIds: [ids[0]!] }, systemClock, prisma);
    await expect(
      createAndPayShipment({ buyerId: buyer.id, itemIds: ids, quoteId: est.quoteId! }, systemClock, prisma),
    ).rejects.toBeInstanceOf(QuoteStaleError);
  });

  it('cannot be used by another buyer', async () => {
    const a = await scenario();
    const b = await scenario();
    const est = await estimateShipment({ buyerId: a.buyer.id, itemIds: a.ids }, systemClock, prisma);
    await expect(
      createAndPayShipment({ buyerId: b.buyer.id, itemIds: b.ids, quoteId: est.quoteId! }, systemClock, prisma),
    ).rejects.toBeInstanceOf(QuoteStaleError);
  });

  it('expires', async () => {
    const { buyer, ids } = await scenario();
    const est = await estimateShipment({ buyerId: buyer.id, itemIds: ids }, systemClock, prisma);
    await prisma.shipQuote.update({ where: { id: est.quoteId! }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(
      createAndPayShipment({ buyerId: buyer.id, itemIds: ids, quoteId: est.quoteId! }, systemClock, prisma),
    ).rejects.toBeInstanceOf(QuoteStaleError);
  });

  it('will not let a standard quote pay for a private shipment', async () => {
    // Private adds a fee and a different handling path, so its price is not
    // interchangeable with the standard one.
    const { buyer, ids } = await scenario();
    const est = await estimateShipment({ buyerId: buyer.id, itemIds: ids }, systemClock, prisma);
    await expect(
      createAndPayShipment({ buyerId: buyer.id, itemIds: ids, quoteId: est.quoteId!, mode: 'PRIVATE', private: true }, systemClock, prisma),
    ).rejects.toBeInstanceOf(QuoteStaleError);
  });

  it('binds items order-independently', async () => {
    expect(hashItemIds(['b', 'a'])).toBe(hashItemIds(['a', 'b']));
    expect(hashItemIds(['a', 'a', 'b'])).toBe(hashItemIds(['a', 'b']));
    expect(hashItemIds(['a'])).not.toBe(hashItemIds(['a', 'b']));
  });
});

describe('the parcel that gets priced', () => {
  it('is the seller-declared package and weight, combined across items', async () => {
    const { buyer, ids } = await scenario({ items: 3 });
    await estimateShipment({ buyerId: buyer.id, itemIds: ids }, systemClock, prisma);
    // One carrier call for the whole shipment, not one per item.
    expect(live.calls).toBe(1);
  });
});

describe('the fallback price matches what the bid panel promised', () => {
  it('quotes the same formula the estimate showed, not a second model', async () => {
    // This drifted once: the fallback reached for the old zone/per-pound model
    // while the panel used the new formula, so a Seattle buyer saw $10.50 and
    // would have been charged $24.17. Both paths must price the same way.
    const { buyer, ids } = await scenario();
    live.set(new Error('shippo down'));

    const est = await estimateShipment({ buyerId: buyer.id, itemIds: ids }, systemClock, prisma);
    const item = await prisma.fulfillmentItem.findUniqueOrThrow({ where: { id: ids[0]! } });
    const panel = estimateShipping({
      origin: { country: 'Canada', region: 'AB', city: 'Calgary', postal: 'T2P 1J9' },
      dest: { country: ADDRESS.country, region: ADDRESS.region, city: ADDRESS.city, postal: ADDRESS.postal },
      weightGrams: item.weightGrams,
      parcelDims: null,
    }).fee;

    // The charge is the panel's number plus the flat handling markup, and
    // nothing else.
    expect(est.shippingFee).toBe(panel + shipMarkupMicros());
  });
});
