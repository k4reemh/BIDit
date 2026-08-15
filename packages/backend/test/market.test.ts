import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { closeDueAuctions } from '../src/auction.js';
import { DevWalletEscrow } from '../src/escrow.js';
import { settleAuction } from '../src/orders.js';
import {
  createMarketListing,
  listMarket,
  getMarketItem,
  placeMarketBid,
  buyMarketItem,
  delistMarketListing,
  regionForCountry,
  MarketError,
  MARKET_ANTI_SNIPE_MS,
} from '../src/market.js';
import { createNftListing } from '../src/nft.js';
import { getAvailableBalance, getSettledBalance } from '../src/ledger.js';
import { usdc, AuctionStatus, OrderStatus, SYSTEM_ACCOUNT_IDS } from '@bidit/shared';
import { applyAsSeller } from '../src/authz.js';
import { resetDb, makeFundedUser, makeUser } from './setup.js';

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const escrow = new DevWalletEscrow(prisma);
const PHOTO = 'data:image/jpeg;base64,aGVsbG8=';
const US_ADDR = { name: 'Al', line1: '1 Main St', city: 'NYC', region: 'NY', postal: '10001', country: 'US' };
const CA_ADDR = { name: 'Kay', line1: '2 Elm St', city: 'Calgary', region: 'AB', postal: 'T2P', country: 'CA' };

beforeEach(async () => { await resetDb(); });

async function setAddress(userId: string, addr: unknown) {
  await prisma.user.update({ where: { id: userId }, data: { shippingAddress: addr as object } });
}

/** Seller + a live 24h marketplace listing: $10 start, ships US $15 / CA $20. */
async function listedItem(clock: ManualClock) {
  const seller = await makeUser('buyer');
  await applyAsSeller(seller.userId, prisma);
  const created = await createMarketListing(
    seller.userId,
    {
      title: 'PSA 10 Charizard',
      description: 'Grail.',
      category: 'Pokémon',
      photos: [PHOTO],
      startingBid: usdc('10'),
      durationHours: 24,
      shipPrices: { US: usdc('15'), CA: usdc('20') },
    },
    clock,
    prisma,
  );
  // Auction mode always returns an auction + deadline; narrow for the tests.
  return { ...created, auctionId: created.auctionId!, endsAt: created.endsAt!, sellerId: seller.userId };
}

describe('marketplace listings', () => {
  it('creates a running timed auction with region shipping', async () => {
    const clock = new ManualClock(T0);
    const { auctionId, endsAt } = await listedItem(clock);
    expect(endsAt.getTime()).toBe(T0 + 24 * 3600 * 1000);
    const grid = await listMarket({}, clock, prisma);
    expect(grid.total).toBe(1);
    expect(grid.items[0]!.auctionId).toBe(auctionId);
    expect(grid.items[0]!.shipPrices).toEqual({ US: usdc('15').toString(), CA: usdc('20').toString() });
  });

  it('rejects bad input: no photo, no shipping region, silly duration', async () => {
    const clock = new ManualClock(T0);
    const seller = await makeUser('buyer');
    await applyAsSeller(seller.userId, prisma);
    const base = { title: 'Item', photos: [PHOTO], startingBid: usdc('10'), durationHours: 24, shipPrices: { US: usdc('5') } };
    await expect(createMarketListing(seller.userId, { ...base, photos: [] }, clock, prisma)).rejects.toBeInstanceOf(MarketError);
    await expect(createMarketListing(seller.userId, { ...base, shipPrices: {} }, clock, prisma)).rejects.toBeInstanceOf(MarketError);
    await expect(createMarketListing(seller.userId, { ...base, durationHours: 0 }, clock, prisma)).rejects.toBeInstanceOf(MarketError);
    await expect(createMarketListing(seller.userId, { ...base, durationHours: 200 }, clock, prisma)).rejects.toBeInstanceOf(MarketError);
  });

  it('maps countries to regions', () => {
    expect(regionForCountry('US')).toBe('US');
    expect(regionForCountry('ca')).toBe('CA');
    expect(regionForCountry('GB')).toBe('UK');
    expect(regionForCountry('DE')).toBe('EU');
    expect(regionForCountry('JP')).toBe('ASIA');
    expect(regionForCountry('BR')).toBe('OTHER');
  });
});

describe('marketplace bidding (shipping rides the hold)', () => {
  it('holds bid + the bidder region shipping; outbid releases both', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await listedItem(clock);
    const us = await makeFundedUser('100');
    const ca = await makeFundedUser('100');
    await setAddress(us.userId, US_ADDR);
    await setAddress(ca.userId, CA_ADDR);

    // US bidder: $10 bid + $15 US shipping reserved.
    const r1 = await placeMarketBid(us.userId, auctionId, usdc('10'), clock, prisma);
    expect(r1.ok).toBe(true);
    expect(await getAvailableBalance(us.accountId, prisma)).toBe(usdc('75'));

    // CA bidder outbids: US bidder's full 25 comes back; CA reserves 12+20.
    const r2 = await placeMarketBid(ca.userId, auctionId, usdc('12'), clock, prisma);
    expect(r2.ok).toBe(true);
    expect(await getAvailableBalance(us.accountId, prisma)).toBe(usdc('100'));
    expect(await getAvailableBalance(ca.accountId, prisma)).toBe(usdc('68'));
  });

  it('needs funds for bid + shipping, not just the bid', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await listedItem(clock);
    const buyer = await makeFundedUser('20'); // $10 bid ok alone, not with $15 shipping
    await setAddress(buyer.userId, US_ADDR);
    const r = await placeMarketBid(buyer.userId, auctionId, usdc('10'), clock, prisma);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INSUFFICIENT_BALANCE');
  });

  it('rejects a region the seller does not ship to, a missing address, and self-bids', async () => {
    const clock = new ManualClock(T0);
    const { auctionId, sellerId } = await listedItem(clock);
    const de = await makeFundedUser('100');
    await setAddress(de.userId, { ...US_ADDR, country: 'DE' }); // EU not priced
    await expect(placeMarketBid(de.userId, auctionId, usdc('10'), clock, prisma)).rejects.toThrow(/ship to your region/);
    const noAddr = await makeFundedUser('100');
    await expect(placeMarketBid(noAddr.userId, auctionId, usdc('10'), clock, prisma)).rejects.toThrow(/shipping address/);
    await expect(placeMarketBid(sellerId, auctionId, usdc('10'), clock, prisma)).rejects.toThrow(/own listing/);
  });

  it('a bid in the final window extends the deadline to the anti-snipe floor', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await listedItem(clock);
    const buyer = await makeFundedUser('100');
    await setAddress(buyer.userId, US_ADDR);
    // Jump to 30s before the end, then bid: deadline moves to now + floor.
    clock.advance(24 * 3600 * 1000 - 30_000);
    const r = await placeMarketBid(buyer.userId, auctionId, usdc('10'), clock, prisma);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.extended).toBe(true);
      expect(r.snapshot.endsAt!.getTime()).toBe(clock.now().getTime() + MARKET_ANTI_SNIPE_MS);
    }
  });
});

describe('marketplace settlement (win charges bid + shipping)', () => {
  it('close -> settle: escrows the bid, charges shipping to FEE, hands the seller a PAID shipment', async () => {
    const clock = new ManualClock(T0);
    const { auctionId, sellerId } = await listedItem(clock);
    const buyer = await makeFundedUser('100');
    await setAddress(buyer.userId, US_ADDR);
    expect((await placeMarketBid(buyer.userId, auctionId, usdc('30'), clock, prisma)).ok).toBe(true);

    clock.advance(24 * 3600 * 1000 + MARKET_ANTI_SNIPE_MS + 1000);
    const closed = await closeDueAuctions(clock, prisma);
    expect(closed[0]?.status).toBe(AuctionStatus.SETTLING);

    const order = await settleAuction(auctionId, escrow, clock, prisma);
    expect(order).not.toBeNull();
    expect(order!.amount).toBe(usdc('30'));

    // Money: $30 bid in escrow, $15 shipping in the FEE pool, $55 left settled.
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('55'));
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.ESCROW, prisma)).toBe(usdc('30'));
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma)).toBe(usdc('15'));

    // Physical: the shipment is already PAID with the seller's price, the item is
    // attached (no Ready-to-ship step), and the seller's ship clock is running.
    const shipment = await prisma.shipment.findFirstOrThrow({ where: { buyerId: buyer.userId, sellerId } });
    expect(shipment.status).toBe('PAID');
    expect(shipment.shippingFee).toBe(usdc('15'));
    const item = await prisma.fulfillmentItem.findFirstOrThrow({ where: { orderId: order!.id } });
    expect(item.status).toBe('IN_SHIPMENT');
    expect(item.shipmentId).toBe(shipment.id);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order!.id } });
    expect(after.noShipDeadline).not.toBeNull();
  });

  it('no bids: closes unsold, nothing charged, listing not sold', async () => {
    const clock = new ManualClock(T0);
    const { auctionId, listingId } = await listedItem(clock);
    clock.advance(24 * 3600 * 1000 + 1000);
    const closed = await closeDueAuctions(clock, prisma);
    expect(closed[0]?.status).toBe(AuctionStatus.CLOSED);
    expect(closed[0]?.winnerUserId).toBeNull();
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).not.toBe('SOLD');
  });

  it('detail view shows the viewer their own shipping lane', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await listedItem(clock);
    const ca = await makeUser('buyer');
    await setAddress(ca.userId, CA_ADDR);
    const item = await getMarketItem(auctionId, ca.userId, clock, prisma);
    expect(item!.viewer).toEqual({ region: 'CA', shippingC: usdc('20').toString(), hasAddress: true, leading: false });
    const de = await makeUser('buyer');
    await setAddress(de.userId, { ...US_ADDR, country: 'DE' });
    const item2 = await getMarketItem(auctionId, de.userId, clock, prisma);
    expect(item2!.viewer!.shippingC).toBeNull(); // seller doesn't ship EU
  });
});

describe('marketplace buy now (fixed price)', () => {
  /** Seller + a live buy-now listing: $40, ships US $15 / CA $20. */
  async function fixedItem() {
    const clock = new ManualClock(T0);
    const seller = await makeUser('buyer');
    await applyAsSeller(seller.userId, prisma);
    const created = await createMarketListing(
      seller.userId,
      {
        title: 'Vintage Coach Bag',
        photos: [PHOTO],
        saleMode: 'fixed',
        price: usdc('40'),
        shipPrices: { US: usdc('15'), CA: usdc('20') },
      },
      clock,
      prisma,
    );
    return { listingId: created.listingId, sellerId: seller.userId, clock };
  }

  it('creates a live buy-now listing: no auction, priced grid card, mode filters work', async () => {
    const { listingId, clock } = await fixedItem();
    await listedItem(clock); // one auction alongside it

    const all = await listMarket({}, clock, prisma);
    expect(all.total).toBe(2);
    const fixedCard = all.items.find((c) => c.saleMode === 'fixed')!;
    expect(fixedCard.id).toBe(listingId);
    expect(fixedCard.auctionId).toBeNull();
    expect(fixedCard.buyNow).toBe(usdc('40').toString());
    expect(fixedCard.endsAt).toBeNull();

    expect((await listMarket({ mode: 'fixed' }, clock, prisma)).total).toBe(1);
    expect((await listMarket({ mode: 'auction' }, clock, prisma)).total).toBe(1);

    const item = await getMarketItem(listingId, null, clock, prisma);
    expect(item!.saleMode).toBe('fixed');
    expect(item!.available).toBe(true);
    expect(item!.buyNow).toBe(usdc('40').toString());
  });

  it('buy now: one purchase escrows the price, pays shipping to FEE, seller gets a PAID shipment', async () => {
    const { listingId, sellerId, clock } = await fixedItem();
    const buyer = await makeFundedUser('100');
    await setAddress(buyer.userId, US_ADDR);

    const out = await buyMarketItem(buyer.userId, listingId, { directPayout: false, escrow }, clock, prisma);
    expect(out.nft).toBe(false);
    expect(out.shippingC).toBe(usdc('15').toString());

    // Money: $40 into escrow, $15 shipping into FEE, $45 left settled.
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('45'));
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.ESCROW, prisma)).toBe(usdc('40'));
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma)).toBe(usdc('15'));
    const order = await prisma.order.findUniqueOrThrow({ where: { id: out.orderId } });
    expect(order.status).toBe(OrderStatus.LOCKED);

    // Physical: PAID shipment with the item attached, ship clock running.
    const shipment = await prisma.shipment.findFirstOrThrow({ where: { buyerId: buyer.userId, sellerId } });
    expect(shipment.status).toBe('PAID');
    expect(shipment.shippingFee).toBe(usdc('15'));
    const item = await prisma.fulfillmentItem.findFirstOrThrow({ where: { orderId: out.orderId } });
    expect(item.status).toBe('IN_SHIPMENT');
    expect(item.shipmentId).toBe(shipment.id);

    // The listing is retired and gone from the grid.
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('SOLD');
    expect((await listMarket({}, clock, prisma)).total).toBe(0);
    const detail = await getMarketItem(listingId, null, clock, prisma);
    expect(detail!.available).toBe(false);

    // A second purchase attempt bounces.
    const late = await makeFundedUser('100');
    await setAddress(late.userId, US_ADDR);
    await expect(buyMarketItem(late.userId, listingId, { directPayout: false, escrow }, clock, prisma)).rejects.toThrow(
      /no longer available/,
    );
  });

  it('needs price + shipping available: a short buyer moves no money and keeps the listing live', async () => {
    const { listingId, clock } = await fixedItem();
    const buyer = await makeFundedUser('50'); // $40 alone ok, not with $15 shipping
    await setAddress(buyer.userId, US_ADDR);
    await expect(buyMarketItem(buyer.userId, listingId, { directPayout: false, escrow }, clock, prisma)).rejects.toThrow(
      /available/,
    );
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('50'));
    expect(await prisma.order.count()).toBe(0);
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('QUEUED');
    expect(listing.quantity).toBe(1);
  });

  it('guards: no address, unshipped region, own listing', async () => {
    const { listingId, sellerId, clock } = await fixedItem();
    const noAddr = await makeFundedUser('100');
    await expect(buyMarketItem(noAddr.userId, listingId, { directPayout: false, escrow }, clock, prisma)).rejects.toThrow(
      /shipping address/,
    );
    const de = await makeFundedUser('100');
    await setAddress(de.userId, { ...US_ADDR, country: 'DE' });
    await expect(buyMarketItem(de.userId, listingId, { directPayout: false, escrow }, clock, prisma)).rejects.toThrow(
      /ship to your region/,
    );
    await expect(buyMarketItem(sellerId, listingId, { directPayout: false, escrow }, clock, prisma)).rejects.toThrow(
      /own listing/,
    );
  });

  it('two simultaneous buyers: exactly one order, one charge', async () => {
    const { listingId, clock } = await fixedItem();
    const a = await makeFundedUser('100');
    const b = await makeFundedUser('100');
    await setAddress(a.userId, US_ADDR);
    await setAddress(b.userId, US_ADDR);
    const results = await Promise.allSettled([
      buyMarketItem(a.userId, listingId, { directPayout: false, escrow }, clock, prisma),
      buyMarketItem(b.userId, listingId, { directPayout: false, escrow }, clock, prisma),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.order.count()).toBe(1);
    // Exactly one buyer paid; the loser kept their full balance.
    const balances = [await getSettledBalance(a.accountId, prisma), await getSettledBalance(b.accountId, prisma)].sort(
      (x, y) => (x < y ? -1 : 1),
    );
    expect(balances).toEqual([usdc('45'), usdc('100')]);
  });

  it('delist: off the grid, unbuyable, and loses cleanly to a concurrent sale', async () => {
    const { listingId, sellerId, clock } = await fixedItem();
    await delistMarketListing(sellerId, listingId, prisma);
    expect((await listMarket({}, clock, prisma)).total).toBe(0);
    const buyer = await makeFundedUser('100');
    await setAddress(buyer.userId, US_ADDR);
    await expect(buyMarketItem(buyer.userId, listingId, { directPayout: false, escrow }, clock, prisma)).rejects.toThrow();

    // Sold listings can't be delisted (the guarded transition fails).
    const second = await fixedItem();
    await buyMarketItem(buyer.userId, second.listingId, { directPayout: false, escrow }, clock, prisma);
    await expect(delistMarketListing(second.sellerId, second.listingId, prisma)).rejects.toThrow(/active buy-now/);
  });

  it('NFT fixed price: no address needed, assets credit instantly, seller nets 95% at once', async () => {
    const clock = new ManualClock(T0);
    const seller = await makeUser('buyer');
    await applyAsSeller(seller.userId, prisma);
    const assets = await Promise.all(
      [0, 1].map((i) =>
        prisma.nftAsset.create({
          data: {
            mint: `FixedMint${i}_${seller.userId.slice(-6)}`,
            ownerId: seller.userId,
            custodyUserId: seller.userId,
            name: `Ape #${i + 1}`,
            status: 'HELD',
          },
        }),
      ),
    );
    const created = await createNftListing(
      seller.userId,
      { assetIds: assets.map((a) => a.id), startingBid: 0n, mode: 'market', fixedPrice: usdc('25') },
      clock,
      prisma,
    );
    expect(created.auctionId).toBeNull();

    // On the grid as a buy-now NFT card.
    const grid = await listMarket({ mode: 'fixed' }, clock, prisma);
    expect(grid.total).toBe(1);
    expect(grid.items[0]!.nft).toBe(true);
    expect(grid.items[0]!.nftCount).toBe(2);
    expect(grid.items[0]!.buyNow).toBe(usdc('25').toString());

    const buyer = await makeFundedUser('30'); // deliberately NO shipping address
    const out = await buyMarketItem(buyer.userId, created.listingId, { directPayout: false, escrow }, clock, prisma);
    expect(out.nft).toBe(true);
    expect(out.shippingC).toBe('0');

    // Instant payout: order RELEASED, seller nets 95% immediately.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: out.orderId } });
    expect(order.status).toBe(OrderStatus.RELEASED);
    const sellerAcct = await prisma.account.findUniqueOrThrow({ where: { userId: seller.userId } });
    expect(await getSettledBalance(sellerAcct.id, prisma)).toBe(usdc('23.75'));
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('5'));

    // Both NFTs belong to the buyer, unlocked; no shipping artifacts exist.
    const won = await prisma.nftAsset.findMany({ where: { ownerId: buyer.userId } });
    expect(won).toHaveLength(2);
    expect(won.every((w) => w.listingId === null && w.status === 'HELD')).toBe(true);
    expect(await prisma.fulfillmentItem.count()).toBe(0);
    expect(await prisma.shipment.count()).toBe(0);
  });
});
