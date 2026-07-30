import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { placeBid } from '../src/auction.js';
import { DevWalletEscrow } from '../src/escrow.js';
import { purchaseListing, listStoreItems, ItemUnavailableError } from '../src/store.js';
import { processOrderTimers } from '../src/orders.js';
import { getBuyerPurchases, createAndPayShipment, ShippingError } from '../src/fulfillment.js';
import { getSettledBalance, getAvailableBalance, getSystemTotal } from '../src/ledger.js';
import { InsufficientFundsError } from '../src/errors.js';
import { usdc, OrderStatus, ListingStatus, SYSTEM_ACCOUNT_IDS } from '@bidit/shared';
import { resetDb, makeFundedUser, makeUser, makeRunningAuction } from './setup.js';

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const ADDRESS = { name: 'Kareem', line1: '1 Main St', city: 'Calgary', region: 'AB', postal: 'T2P', country: 'CA' };
const escrow = new DevWalletEscrow(prisma);
const direct = { directPayout: true, escrow };
const escrowed = { directPayout: false, escrow };

beforeEach(async () => {
  await resetDb();
});

async function makeStoreListing(opts?: { price?: string; quantity?: number; status?: ListingStatus }) {
  const seller = await makeUser('seller');
  const listing = await prisma.listing.create({
    data: {
      sellerId: seller.userId,
      title: 'OP-09 Booster Pack',
      photos: ['https://img.example/pack.png'],
      startingBid: usdc('1'),
      buyNowPrice: usdc(opts?.price ?? '30'),
      quantity: opts?.quantity ?? 3,
      status: opts?.status ?? ListingStatus.QUEUED,
      weightGrams: 40,
    },
  });
  return { seller, listing };
}

describe('store buy-now (direct payout)', () => {
  it('charges the buyer, pays the seller 100%, decrements stock, creates fulfillment', async () => {
    const clock = new ManualClock(T0);
    const { seller, listing } = await makeStoreListing({ price: '30', quantity: 2 });
    const buyer = await makeFundedUser('100');

    const order = await purchaseListing(buyer.userId, listing.id, { ...direct, clock }, prisma);

    expect(order.status).toBe(OrderStatus.RELEASED);
    expect(order.auctionId).toBeNull();
    expect(order.listingId).toBe(listing.id);
    expect(order.amount).toBe(usdc('30'));
    expect(order.platformFee).toBe(0n);

    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('70'));
    expect(await getSettledBalance(seller.accountId, prisma)).toBe(usdc('30'));
    expect(await getSystemTotal(prisma)).toBe(0n);

    const l = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.quantity).toBe(1);
    expect(l.status).toBe(ListingStatus.QUEUED); // stock remains → still buyable/auctionable

    const item = await prisma.fulfillmentItem.findFirst({ where: { orderId: order.id } });
    expect(item).not.toBeNull();
    expect(item!.buyerId).toBe(buyer.userId);
    expect(item!.title).toBe('OP-09 Booster Pack');
  });

  it('retires the listing at zero stock and blocks further buys', async () => {
    const clock = new ManualClock(T0);
    const { listing } = await makeStoreListing({ price: '10', quantity: 1 });
    const a = await makeFundedUser('50');
    const b = await makeFundedUser('50');

    await purchaseListing(a.userId, listing.id, { ...direct, clock }, prisma);
    const l = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.quantity).toBe(0);
    expect(l.status).toBe(ListingStatus.SOLD);

    await expect(purchaseListing(b.userId, listing.id, { ...direct, clock }, prisma)).rejects.toThrow(
      ItemUnavailableError,
    );
    expect(await getSettledBalance(b.accountId, prisma)).toBe(usdc('50')); // untouched
  });

  it('spends from AVAILABLE balance: funds held under a live bid cannot be double-spent', async () => {
    const clock = new ManualClock(T0);
    const { listing } = await makeStoreListing({ price: '30' });
    const buyer = await makeFundedUser('50');

    // Lock $30 of the buyer's $50 under a live auction bid…
    const auction = await makeRunningAuction({ startingBid: '30', clock, durationSeconds: 60 });
    const r = await placeBid({ auctionId: auction.auctionId, userId: buyer.userId, amount: usdc('30') }, clock, prisma);
    expect(r.ok).toBe(true);
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('20'));

    // …so a $30 store buy must be rejected even though settled = $50.
    await expect(purchaseListing(buyer.userId, listing.id, { ...direct, clock }, prisma)).rejects.toThrow(
      InsufficientFundsError,
    );

    // The claim was rolled back: stock intact, no order, no money moved.
    const l = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.quantity).toBe(3);
    expect(await prisma.order.count()).toBe(0);
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('50'));
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('is blocked while the listing is LIVE in an auction', async () => {
    const clock = new ManualClock(T0);
    const { listing } = await makeStoreListing({ status: ListingStatus.LIVE });
    const buyer = await makeFundedUser('100');
    await expect(purchaseListing(buyer.userId, listing.id, { ...direct, clock }, prisma)).rejects.toThrow(
      ItemUnavailableError,
    );
  });

  it('rejects buying your own listing and items with no store price', async () => {
    const clock = new ManualClock(T0);
    const { seller, listing } = await makeStoreListing();
    await expect(purchaseListing(seller.userId, listing.id, { ...direct, clock }, prisma)).rejects.toThrow(
      ItemUnavailableError,
    );

    const plain = await prisma.listing.create({
      data: { sellerId: seller.userId, title: 'No store price', photos: [], startingBid: usdc('1'), status: ListingStatus.QUEUED },
    });
    const buyer = await makeFundedUser('100');
    await expect(purchaseListing(buyer.userId, plain.id, { ...direct, clock }, prisma)).rejects.toThrow(
      ItemUnavailableError,
    );
  });

  it('two buyers racing for the last unit: exactly one succeeds', async () => {
    const clock = new ManualClock(T0);
    const { listing } = await makeStoreListing({ price: '10', quantity: 1 });
    const a = await makeFundedUser('50');
    const b = await makeFundedUser('50');

    const results = await Promise.allSettled([
      purchaseListing(a.userId, listing.id, { ...direct, clock }, prisma),
      purchaseListing(b.userId, listing.id, { ...direct, clock }, prisma),
    ]);
    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter((r) => r.status === 'rejected');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);

    const l = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.quantity).toBe(0);
    expect(l.status).toBe(ListingStatus.SOLD);
    expect(await prisma.order.count()).toBe(1);
    expect(await getSystemTotal(prisma)).toBe(0n);
  });
});

describe('store buy-now (escrow payout)', () => {
  it('locks funds in escrow with the 95/5 split and NO ship deadline yet', async () => {
    const clock = new ManualClock(T0);
    const { seller, listing } = await makeStoreListing({ price: '20' });
    const buyer = await makeFundedUser('100');

    const order = await purchaseListing(buyer.userId, listing.id, { ...escrowed, clock }, prisma);

    expect(order.status).toBe(OrderStatus.LOCKED);
    expect(order.auctionId).toBeNull();
    expect(order.platformFee + order.sellerProceeds).toBe(usdc('20'));
    expect(order.platformFee).toBeGreaterThan(0n);
    // The seller's ship-clock must NOT start at purchase. Starting it here meant a
    // buyer who simply waited 7 days got refunded while their item stayed
    // shippable, so they could pay $5 shipping and keep a card they were refunded
    // for. It starts when the buyer pays shipping, exactly like an auction win.
    expect(order.noShipDeadline).toBeNull();

    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('80'));
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.ESCROW, prisma)).toBe(usdc('20'));
    expect(await getSettledBalance(seller.accountId, prisma)).toBe(0n); // paid on release, not now
    expect(await getSystemTotal(prisma)).toBe(0n);

    // The bug: an ESCROW store buy must ALSO create a ready-to-ship item (it used
    // to only happen in direct mode, so the purchase vanished from the buyer's UI).
    const item = await prisma.fulfillmentItem.findFirst({ where: { orderId: order.id } });
    expect(item).not.toBeNull();
    expect(item!.status).toBe('READY_TO_SHIP');
    expect(item!.buyerId).toBe(buyer.userId);

    // …and it shows up in the Purchases overview, in the "to ship" stage.
    const purchases = await getBuyerPurchases(buyer.userId, prisma);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]!.status).toBe('READY_TO_SHIP');
    expect(purchases[0]!.title).toBe('OP-09 Booster Pack');
  });
});

describe('a refunded escrow store buy cannot also be shipped', () => {
  /**
   * The exploit this closes: buy a card in escrow mode, sit on it for 8 days, get
   * auto-refunded 100%, then pay $5 shipping on the still-live Ready-to-ship item
   * and receive the card anyway. The seller was never paid, so they ate the loss.
   */
  it('refunds nothing on an idle purchase, and forfeits to the seller instead', async () => {
    const clock = new ManualClock(T0);
    const { seller, listing } = await makeStoreListing({ price: '500' });
    const buyer = await makeFundedUser('600');
    const order = await purchaseListing(buyer.userId, listing.id, { ...escrowed, clock }, prisma);

    // 8 days of doing nothing: the old code refunded here. Now nothing fires,
    // because the ship-clock never started.
    clock.advance(8 * 24 * 60 * 60 * 1000);
    const day8 = await processOrderTimers(escrow, clock, prisma);
    expect(day8.refunded).toEqual([]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.LOCKED);
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('100')); // still charged

    // Past the 14-day hold it forfeits to the SELLER (buyer abandoned it), which
    // is the same treatment an unpaid auction win gets.
    clock.advance(7 * 24 * 60 * 60 * 1000);
    const later = await processOrderTimers(escrow, clock, prisma);
    expect(later.forfeited).toEqual([order.id]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.RELEASED);
    expect((await prisma.fulfillmentItem.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe('DISCARDED');
    expect(await getSettledBalance(seller.accountId, prisma)).toBe(usdc('475')); // 95% of 500
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.ESCROW, prisma)).toBe(0n);
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('discards the item when a paid-for order refunds, and refuses to ship it', async () => {
    const clock = new ManualClock(T0);
    const { listing } = await makeStoreListing({ price: '500' });
    const buyer = await makeFundedUser('600');
    const order = await purchaseListing(buyer.userId, listing.id, { ...escrowed, clock }, prisma);
    const item = await prisma.fulfillmentItem.findFirstOrThrow({ where: { orderId: order.id } });

    // Buyer pays shipping, which is what actually starts the seller's clock.
    await prisma.user.update({ where: { id: buyer.userId }, data: { shippingAddress: ADDRESS as object } });
    await prisma.order.update({
      where: { id: order.id },
      data: { noShipDeadline: new Date(clock.now().getTime() + 1000) },
    });

    // Seller misses the deadline: buyer is refunded in full...
    clock.advance(2000);
    expect((await processOrderTimers(escrow, clock, prisma)).refunded).toEqual([order.id]);
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('600')); // whole again

    // ...and the goods claim dies with the money claim.
    expect((await prisma.fulfillmentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('DISCARDED');
    await expect(
      createAndPayShipment({ buyerId: buyer.userId, itemIds: [item.id] }, clock, prisma),
    ).rejects.toThrow(ShippingError);
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('refuses to ship an item whose order was refunded even if the item is still live', async () => {
    const clock = new ManualClock(T0);
    const { listing } = await makeStoreListing({ price: '500' });
    const buyer = await makeFundedUser('600');
    const order = await purchaseListing(buyer.userId, listing.id, { ...escrowed, clock }, prisma);
    const item = await prisma.fulfillmentItem.findFirstOrThrow({ where: { orderId: order.id } });
    await prisma.user.update({ where: { id: buyer.userId }, data: { shippingAddress: ADDRESS as object } });

    // Force the exact bad state the old code could reach: order refunded, item
    // still READY_TO_SHIP. The order check must catch it on its own.
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.REFUNDED } });
    await expect(
      createAndPayShipment({ buyerId: buyer.userId, itemIds: [item.id] }, clock, prisma),
    ).rejects.toThrow(/no longer active/);
  });
});

describe('storefront listing', () => {
  it('lists only in-stock, priced, QUEUED items', async () => {
    const { seller, listing } = await makeStoreListing({ price: '30' });
    // Noise that must NOT appear: no price / LIVE / sold out.
    await prisma.listing.create({
      data: { sellerId: seller.userId, title: 'auction only', photos: [], startingBid: usdc('1'), status: ListingStatus.QUEUED },
    });
    await prisma.listing.create({
      data: { sellerId: seller.userId, title: 'mid-auction', photos: [], startingBid: usdc('1'), buyNowPrice: usdc('5'), status: ListingStatus.LIVE },
    });
    await prisma.listing.create({
      data: { sellerId: seller.userId, title: 'sold out', photos: [], startingBid: usdc('1'), buyNowPrice: usdc('5'), quantity: 0, status: ListingStatus.SOLD },
    });

    const items = await listStoreItems(seller.userId, prisma);
    expect(items.map((i) => i.id)).toEqual([listing.id]);
  });
});

/**
 * A randomizer's prize pool and the listing's `quantity` are two records of the
 * same stock. Buy-now decremented the counter without removing a prize, then the
 * next auction close recomputed the counter FROM the pool, silently restoring the
 * unit that had just been sold. That minted sellable units that do not exist, and
 * a buyer of a phantom unit could have escrow released to the seller for a card
 * with no prize behind it. Randomizers are auction-only now.
 */
describe('randomizers cannot be bought outright (SEC-10)', () => {
  async function makeWheelListing() {
    const seller = await makeUser('seller');
    const listing = await prisma.listing.create({
      data: {
        sellerId: seller.userId,
        title: 'Mystery wheel',
        photos: [],
        startingBid: usdc('1'),
        buyNowPrice: usdc('30'), // priced BEFORE the wheel was attached
        quantity: 3,
        status: ListingStatus.QUEUED,
        wheel: [{ label: 'Charizard', weight: 1 }, { label: 'Pack', weight: 2 }] as object,
      },
    });
    return { seller, listing };
  }

  it('refuses a buy-now on a wheel listing, even if it already had a price', async () => {
    const clock = new ManualClock(T0);
    const { listing } = await makeWheelListing();
    const buyer = await makeFundedUser('100');
    await expect(purchaseListing(buyer.userId, listing.id, { ...direct, clock }, prisma))
      .rejects.toThrow(ItemUnavailableError);
    // Stock untouched and nothing charged: the oversell needed this sale to land.
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).quantity).toBe(3);
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('100'));
    expect(await prisma.order.count()).toBe(0);
  });
});
