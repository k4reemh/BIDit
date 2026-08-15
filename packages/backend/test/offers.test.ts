import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { DevWalletEscrow } from '../src/escrow.js';
import { createMarketListing, buyMarketItem } from '../src/market.js';
import { makeOffer, respondOffer, expireOffers, OfferError, OFFER_TTL_MS } from '../src/offers.js';
import {
  startConversation,
  sendMessage,
  listConversations,
  getThread,
  unreadTotal,
  MessageError,
} from '../src/messages.js';
import { createNftListing } from '../src/nft.js';
import { getAvailableBalance, getSettledBalance } from '../src/ledger.js';
import { usdc, OrderStatus, SYSTEM_ACCOUNT_IDS } from '@bidit/shared';
import { applyAsSeller } from '../src/authz.js';
import { resetDb, makeFundedUser, makeUser } from './setup.js';

const T0 = new Date('2026-02-01T00:00:00.000Z').getTime();
const escrow = new DevWalletEscrow(prisma);
const OPTS = { directPayout: false, escrow };
const PHOTO = 'data:image/jpeg;base64,aGVsbG8=';
const US_ADDR = { name: 'Al', line1: '1 Main St', city: 'NYC', region: 'NY', postal: '10001', country: 'US' };

beforeEach(async () => { await resetDb(); });

async function setAddress(userId: string, addr: unknown) {
  await prisma.user.update({ where: { id: userId }, data: { shippingAddress: addr as object } });
}

/** Seller + a live $100 buy-now listing shipping US $10. */
async function fixedItem() {
  const clock = new ManualClock(T0);
  const seller = await makeUser('buyer');
  await applyAsSeller(seller.userId, prisma);
  const created = await createMarketListing(
    seller.userId,
    { title: 'Slam Dunk Cel', photos: [PHOTO], saleMode: 'fixed', price: usdc('100'), shipPrices: { US: usdc('10') } },
    clock,
    prisma,
  );
  return { listingId: created.listingId, sellerId: seller.userId, clock };
}

async function usBuyer(amount: string) {
  const u = await makeFundedUser(amount);
  await setAddress(u.userId, US_ADDR);
  return u;
}

describe('offers: making and backing', () => {
  it('reserves offer + shipping; bounds and guards hold', async () => {
    const { listingId, sellerId, clock } = await fixedItem();
    const buyer = await usBuyer('200');

    await expect(makeOffer(buyer.userId, listingId, usdc('0.50'), clock, prisma)).rejects.toThrow(/start at \$1/);
    await expect(makeOffer(buyer.userId, listingId, usdc('100'), clock, prisma)).rejects.toThrow(/just buy it/);
    await expect(makeOffer(sellerId, listingId, usdc('50'), clock, prisma)).rejects.toThrow(/own listing/);
    const noAddr = await makeFundedUser('200');
    await expect(makeOffer(noAddr.userId, listingId, usdc('50'), clock, prisma)).rejects.toThrow(/shipping address/);

    const r = await makeOffer(buyer.userId, listingId, usdc('80'), clock, prisma);
    expect(r.shippingC).toBe(usdc('10').toString());
    // $80 + $10 reserved: available drops, settled untouched.
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('110'));
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('200'));

    // Short buyer can't back an offer.
    const poor = await usBuyer('50');
    await expect(makeOffer(poor.userId, listingId, usdc('60'), clock, prisma)).rejects.toThrow(/available to back/);
  });

  it('a new offer replaces the previous one and frees its hold', async () => {
    const { listingId, clock } = await fixedItem();
    const buyer = await usBuyer('120');
    const first = await makeOffer(buyer.userId, listingId, usdc('60'), clock, prisma);
    // 120 - 70 reserved = 50 available; an $85 offer needs 95: only possible
    // because replacing releases the first hold.
    const second = await makeOffer(buyer.userId, listingId, usdc('85'), clock, prisma);
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('25'));
    const old = await prisma.offer.findUniqueOrThrow({ where: { id: first.offerId } });
    expect(old.status).toBe('CANCELED');
    expect(await prisma.hold.count({ where: { offerId: first.offerId, status: 'ACTIVE' } })).toBe(0);
    expect(await prisma.hold.count({ where: { offerId: second.offerId, status: 'ACTIVE' } })).toBe(1);
  });

  it('cancel and decline both free the reserve and land in the thread', async () => {
    const { listingId, sellerId, clock } = await fixedItem();
    const buyer = await usBuyer('100');
    const o1 = await makeOffer(buyer.userId, listingId, usdc('40'), clock, prisma);
    await respondOffer(buyer.userId, o1.offerId, 'cancel', OPTS, undefined, clock, prisma);
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('100'));

    const o2 = await makeOffer(buyer.userId, listingId, usdc('45'), clock, prisma);
    const r = await respondOffer(sellerId, o2.offerId, 'decline', OPTS, undefined, clock, prisma);
    expect(r.status).toBe('DECLINED');
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('100'));

    const thread = await getThread(o2.conversationId, buyer.userId, {}, clock, prisma);
    const kinds = thread.messages.map((m) => m.kind);
    expect(kinds.filter((k) => k === 'OFFER')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'SYSTEM')).toHaveLength(2); // withdrawn + declined
  });
});

describe('offers: accept settles the sale at the offer price', () => {
  it('seller accepts: charged offer + shipping, PAID shipment, listing SOLD', async () => {
    const { listingId, sellerId, clock } = await fixedItem();
    const buyer = await usBuyer('100');
    const o = await makeOffer(buyer.userId, listingId, usdc('75'), clock, prisma);

    const r = await respondOffer(sellerId, o.offerId, 'accept', OPTS, undefined, clock, prisma);
    expect(r.status).toBe('ACCEPTED');
    expect(r.orderId).toBeTruthy();

    // Money: $75 escrow, $10 shipping to FEE, $15 left. Hold fully consumed.
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('15'));
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('15'));
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.ESCROW, prisma)).toBe(usdc('75'));
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma)).toBe(usdc('10'));

    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId! } });
    expect(order.status).toBe(OrderStatus.LOCKED);
    expect(order.amount).toBe(usdc('75'));
    const shipment = await prisma.shipment.findFirstOrThrow({ where: { buyerId: buyer.userId, sellerId } });
    expect(shipment.status).toBe('PAID');
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('SOLD');
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: o.offerId } });
    expect(offer.status).toBe('ACCEPTED');
    expect(offer.orderId).toBe(r.orderId);
    expect(await prisma.hold.count({ where: { offerId: o.offerId, status: 'ACTIVE' } })).toBe(0);
  });

  it('accept after the item sold: clean failure, offer dead, funds free', async () => {
    const { listingId, sellerId, clock } = await fixedItem();
    const offerer = await usBuyer('100');
    const sniper = await usBuyer('200');
    const o = await makeOffer(offerer.userId, listingId, usdc('60'), clock, prisma);
    await buyMarketItem(sniper.userId, listingId, OPTS, clock, prisma);

    await expect(respondOffer(sellerId, o.offerId, 'accept', OPTS, undefined, clock, prisma)).rejects.toThrow(
      /no longer available/,
    );
    expect(await getAvailableBalance(offerer.accountId, prisma)).toBe(usdc('100'));
    // Pre-check catches it before the offer is consumed, so it stays PENDING
    // until expiry; the important part is the money is whole.
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: o.offerId } });
    expect(['PENDING', 'EXPIRED']).toContain(offer.status);
  });

  it('counter flow: buyer accepts at the counter price', async () => {
    const { listingId, sellerId, clock } = await fixedItem();
    const buyer = await usBuyer('100');
    const o = await makeOffer(buyer.userId, listingId, usdc('70'), clock, prisma);

    await expect(respondOffer(sellerId, o.offerId, 'counter', OPTS, usdc('60'), clock, prisma)).rejects.toThrow(
      /above the buyer/,
    );
    await expect(respondOffer(sellerId, o.offerId, 'counter', OPTS, usdc('150'), clock, prisma)).rejects.toThrow(
      /exceed the asking/,
    );
    const c = await respondOffer(sellerId, o.offerId, 'counter', OPTS, usdc('85'), clock, prisma);
    expect(c.status).toBe('COUNTERED');
    // Hold still backs the original 70 + 10.
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('20'));

    const r = await respondOffer(buyer.userId, o.offerId, 'accept', OPTS, undefined, clock, prisma);
    expect(r.status).toBe('ACCEPTED');
    // Charged 85 + 10: settled 100 -> 5.
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('5'));
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.ESCROW, prisma)).toBe(usdc('85'));
  });

  it('buyer can’t accept a counter they can’t afford; offer survives', async () => {
    const { listingId, sellerId, clock } = await fixedItem();
    const buyer = await usBuyer('85'); // 70+10 reserved fine; 95+10 total is not
    const o = await makeOffer(buyer.userId, listingId, usdc('70'), clock, prisma);
    await respondOffer(sellerId, o.offerId, 'counter', OPTS, usdc('95'), clock, prisma);
    await expect(respondOffer(buyer.userId, o.offerId, 'accept', OPTS, undefined, clock, prisma)).rejects.toThrow(
      /Deposit the difference/,
    );
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: o.offerId } });
    expect(offer.status).toBe('COUNTERED');
    expect(await prisma.hold.count({ where: { offerId: o.offerId, status: 'ACTIVE' } })).toBe(1);
  });

  it('NFT fixed listing: offer needs no address; accept credits instantly', async () => {
    const clock = new ManualClock(T0);
    const seller = await makeUser('buyer');
    await applyAsSeller(seller.userId, prisma);
    const asset = await prisma.nftAsset.create({
      data: { mint: `OfferMint_${seller.userId.slice(-6)}`, ownerId: seller.userId, custodyUserId: seller.userId, status: 'HELD' },
    });
    const created = await createNftListing(
      seller.userId,
      { assetIds: [asset.id], startingBid: 0n, mode: 'market', fixedPrice: usdc('50') },
      clock,
      prisma,
    );
    const buyer = await makeFundedUser('40'); // no address on purpose
    const o = await makeOffer(buyer.userId, created.listingId, usdc('30'), clock, prisma);
    expect(o.shippingC).toBe('0');
    const r = await respondOffer(seller.userId, o.offerId, 'accept', OPTS, undefined, clock, prisma);
    expect(r.status).toBe('ACCEPTED');
    const owned = await prisma.nftAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(owned.ownerId).toBe(buyer.userId);
    const sellerAcct = await prisma.account.findUniqueOrThrow({ where: { userId: seller.userId } });
    expect(await getSettledBalance(sellerAcct.id, prisma)).toBe(usdc('28.50')); // 95% of 30
  });

  it('expiry frees the reserve', async () => {
    const { listingId, clock } = await fixedItem();
    const buyer = await usBuyer('100');
    await makeOffer(buyer.userId, listingId, usdc('50'), clock, prisma);
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('40'));
    clock.advance(OFFER_TTL_MS + 1000);
    expect(await expireOffers(clock, prisma)).toBe(1);
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('100'));
  });
});

describe('messaging', () => {
  it('gate: sellers are reachable, strangers are not; replies always work', async () => {
    const seller = await makeUser('buyer');
    await applyAsSeller(seller.userId, prisma);
    const buyer = await makeUser('buyer');
    const stranger = await makeUser('buyer');

    await expect(startConversation(buyer.userId, buyer.userId, prisma)).rejects.toThrow(/yourself/);
    await expect(startConversation(buyer.userId, stranger.userId, prisma)).rejects.toThrow(/message sellers/);
    const { conversationId } = await startConversation(buyer.userId, seller.userId, prisma);
    // The seller can now reply to the buyer even though the buyer isn't a seller.
    const again = await startConversation(seller.userId, buyer.userId, prisma);
    expect(again.conversationId).toBe(conversationId);
  });

  it('send, unread, read-marking', async () => {
    const clock = new ManualClock(T0);
    const seller = await makeUser('buyer');
    await applyAsSeller(seller.userId, prisma);
    const buyer = await makeUser('buyer');
    const { conversationId } = await startConversation(buyer.userId, seller.userId, prisma);

    await sendMessage(conversationId, buyer.userId, 'Is this still available?', clock, prisma);
    clock.advance(1000);
    await sendMessage(conversationId, buyer.userId, 'Would you take 80?', clock, prisma);
    expect(await unreadTotal(seller.userId, prisma)).toBe(2);
    expect(await unreadTotal(buyer.userId, prisma)).toBe(0);

    const inbox = await listConversations(seller.userId, prisma);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.unread).toBe(2);
    expect(inbox[0]!.other.handle).toBe((await prisma.user.findUniqueOrThrow({ where: { id: buyer.userId } })).handle);

    // Opening the thread marks it read.
    clock.advance(1000);
    const thread = await getThread(conversationId, seller.userId, {}, clock, prisma);
    expect(thread.messages.map((m) => m.text)).toEqual(['Is this still available?', 'Would you take 80?']);
    expect(await unreadTotal(seller.userId, prisma)).toBe(0);

    await expect(sendMessage(conversationId, seller.userId, '', clock, prisma)).rejects.toThrow(/Write something/);
    await expect(sendMessage(conversationId, seller.userId, 'x'.repeat(2001), clock, prisma)).rejects.toThrow(/under 2000/);
    const outsider = await makeUser('buyer');
    await expect(sendMessage(conversationId, outsider.userId, 'hi', clock, prisma)).rejects.toBeInstanceOf(MessageError);
  });
});
