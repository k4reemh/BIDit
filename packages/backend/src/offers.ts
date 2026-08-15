/**
 * Offers on fixed-price marketplace listings. An offer is REAL money: the
 * amount + the buyer's region shipping go on Hold the moment it's made (same
 * Hold table that backs auction bids, so getAvailableBalance counts it), which
 * is what lets a seller accept knowing the sale cannot bounce.
 *
 * State machine (see the Offer model):
 *   PENDING   seller: accept / decline / counter     buyer: cancel
 *   COUNTERED buyer: accept (pays counterAmount) / decline
 *             seller: decline (retract the counter)
 *   ACCEPTED | DECLINED | CANCELED | EXPIRED         terminal
 *
 * Every transition out of PENDING/COUNTERED releases the hold; ACCEPTED
 * releases it immediately before the charge (the charge itself re-verifies
 * funds and rolls back cleanly, so a pathological race costs nobody money).
 * Offers auto-expire after 48h (expireOffers, called from a worker tick).
 *
 * Each offer event lands in the buyer<->seller message thread (messages.ts) as
 * an OFFER card or SYSTEM notice, so the whole negotiation reads as a chat.
 */
import { HoldStatus, ListingStatus } from '@prisma/client';
import { formatUsdc } from '@bidit/shared';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import {
  MarketError,
  settleMarketSale,
  regionForCountry,
  parseShipPrices,
  type MarketBuyOptions,
} from './market.js';
import { getSettledBalance, getActiveHolds, getOrCreateUserAccount } from './ledger.js';
import { postThreadEvent } from './messages.js';
import { decryptPii } from './pii.js';
import { notify } from './notifications.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

export class OfferError extends Error {}

export const OFFER_TTL_MS = 48 * 3600 * 1000;
const MIN_OFFER = 1_000_000n; // $1

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
async function lockAccount(tx: Tx, accountId: string): Promise<void> {
  await tx.$executeRaw`SELECT id FROM "Account" WHERE id = ${accountId} FOR UPDATE`;
}

/** Release an offer's ACTIVE hold (idempotent). */
async function releaseHold(offerId: string, prisma: PrismaClient): Promise<void> {
  await prisma.hold.updateMany({
    where: { offerId, status: HoldStatus.ACTIVE },
    data: { status: HoldStatus.RELEASED, releasedAt: new Date() },
  });
}

/**
 * Make an offer on a fixed-price listing. Reserves amount + shipping.
 * A new offer on the same listing replaces the buyer's previous pending one
 * (old hold released first, so the balance check sees the freed funds).
 */
export async function makeOffer(
  buyerId: string,
  listingId: string,
  amount: bigint,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ offerId: string; conversationId: string; shippingC: string; expiresAt: number }> {
  const l = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!l || !l.marketplace || l.buyNowPrice === null || l.wheel !== null) {
    throw new OfferError('That listing was not found.');
  }
  if (l.sellerId === buyerId) throw new OfferError('You can’t make an offer on your own listing.');
  if (l.status !== ListingStatus.QUEUED || l.quantity <= 0) {
    throw new OfferError('This item is no longer available.');
  }
  if (amount < MIN_OFFER) throw new OfferError('Offers start at $1.');
  if (amount >= l.buyNowPrice) {
    throw new OfferError(`That’s the asking price or more: just buy it for $${formatUsdc(l.buyNowPrice)}.`);
  }

  // Physical items reserve shipping to the buyer's region, exactly like a bid.
  let shippingC = 0n;
  if (!l.nft) {
    const u = await prisma.user.findUnique({ where: { id: buyerId }, select: { shippingAddress: true } });
    const dest = decryptPii<{ country?: string }>(u?.shippingAddress ?? null);
    if (!dest?.country) throw new OfferError('Add your shipping address before making an offer (Account → Payments & Shipping).');
    const region = regionForCountry(dest.country);
    const lane = parseShipPrices(l.shipPrices)[region];
    if (lane === undefined) throw new OfferError('This seller doesn’t ship to your region.');
    shippingC = lane;
  }

  const now = clock.now();
  const expiresAt = new Date(now.getTime() + OFFER_TTL_MS);

  // Replace any previous live offer by this buyer on this listing: retire it
  // and free its hold BEFORE the balance check, so upgrading an offer doesn't
  // require double the funds.
  const previous = await prisma.offer.findMany({
    where: { listingId, buyerId, status: { in: ['PENDING', 'COUNTERED'] } },
    select: { id: true },
  });
  for (const p of previous) {
    await prisma.offer.updateMany({
      where: { id: p.id, status: { in: ['PENDING', 'COUNTERED'] } },
      data: { status: 'CANCELED' },
    });
    await releaseHold(p.id, prisma);
  }

  // Reserve the funds under an account lock (the placeBid pattern): the check
  // and the hold land atomically, so parallel offers can't both pass.
  const totalReserve = amount + shippingC;
  const offer = await prisma.$transaction(async (tx) => {
    const account = await tx.account.findUnique({ where: { userId: buyerId } });
    if (!account) throw new OfferError('Deposit funds before making an offer.');
    await lockAccount(tx, account.id);
    const settled = await getSettledBalance(account.id, tx);
    const holds = await getActiveHolds(account.id, tx);
    if (settled - holds < totalReserve) {
      throw new OfferError(
        `You need $${formatUsdc(totalReserve)} available to back this offer: $${formatUsdc(amount)} + $${formatUsdc(shippingC)} shipping. Offers are real: funds stay reserved until the seller responds.`,
      );
    }
    const created = await tx.offer.create({
      data: { listingId, buyerId, sellerId: l.sellerId, amount, shippingC, expiresAt },
    });
    await tx.hold.create({
      data: { accountId: account.id, offerId: created.id, amount: totalReserve, status: HoldStatus.ACTIVE },
    });
    return created;
  });

  const { conversationId } = await postThreadEvent(
    { u1: buyerId, u2: l.sellerId, senderId: buyerId, kind: 'OFFER', listingId, offerId: offer.id },
    clock,
    prisma,
  );
  const buyer = await prisma.user.findUnique({ where: { id: buyerId }, select: { handle: true } });
  await notify(
    {
      userId: l.sellerId,
      kind: 'offer',
      title: `Offer on ${l.title}: $${formatUsdc(amount)}`,
      body: `@${buyer?.handle ?? 'a buyer'} offered $${formatUsdc(amount)} (asking $${formatUsdc(l.buyNowPrice)}). Funds are reserved; accept and it sells instantly.`,
      href: `/messages/${conversationId}`,
    },
    prisma,
  );
  return { offerId: offer.id, conversationId, shippingC: shippingC.toString(), expiresAt: expiresAt.getTime() };
}

export type OfferAction = 'accept' | 'decline' | 'counter' | 'cancel';

/**
 * Act on an offer. Which actions are legal depends on who is calling and the
 * offer's state (see the module doc). Accept settles the sale immediately at
 * the agreed price through settleMarketSale.
 */
export async function respondOffer(
  userId: string,
  offerId: string,
  action: OfferAction,
  opts: MarketBuyOptions,
  counterAmount?: bigint,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ status: string; orderId?: string }> {
  const offer = await prisma.offer.findUnique({ where: { id: offerId }, include: { listing: true } });
  if (!offer) throw new OfferError('That offer was not found.');
  const isSeller = userId === offer.sellerId;
  const isBuyer = userId === offer.buyerId;
  if (!isSeller && !isBuyer) throw new OfferError('That offer was not found.');
  const l = offer.listing;

  const system = (text: string, actor: string) =>
    postThreadEvent(
      { u1: offer.buyerId, u2: offer.sellerId, senderId: actor, kind: 'SYSTEM', text, listingId: offer.listingId, offerId: offer.id },
      clock,
      prisma,
    );

  // ---- terminal declines/cancels (hold released, thread notified) ----
  if (action === 'cancel' && isBuyer && (offer.status === 'PENDING' || offer.status === 'COUNTERED')) {
    const claimed = await prisma.offer.updateMany({
      where: { id: offerId, status: { in: ['PENDING', 'COUNTERED'] } },
      data: { status: 'CANCELED' },
    });
    if (claimed.count !== 1) throw new OfferError('That offer already closed.');
    await releaseHold(offerId, prisma);
    await system(`Offer of $${formatUsdc(offer.amount)} withdrawn.`, userId);
    return { status: 'CANCELED' };
  }

  if (action === 'decline') {
    const allowed =
      (isSeller && (offer.status === 'PENDING' || offer.status === 'COUNTERED')) ||
      (isBuyer && offer.status === 'COUNTERED');
    if (!allowed) throw new OfferError('That offer already closed.');
    const claimed = await prisma.offer.updateMany({
      where: { id: offerId, status: { in: ['PENDING', 'COUNTERED'] } },
      data: { status: 'DECLINED' },
    });
    if (claimed.count !== 1) throw new OfferError('That offer already closed.');
    await releaseHold(offerId, prisma);
    await system(
      isSeller
        ? `Offer of $${formatUsdc(offer.amount)} declined.`
        : `Counter of $${formatUsdc(offer.counterAmount ?? offer.amount)} declined.`,
      userId,
    );
    const otherId = isSeller ? offer.buyerId : offer.sellerId;
    await notify(
      {
        userId: otherId,
        kind: 'offer',
        title: `Offer declined on ${l.title}`,
        body: isSeller ? 'Your reserved funds are released. Make another offer anytime.' : 'The buyer passed on your counter.',
        href: `/marketplace/${offer.listingId}`,
        email: false,
      },
      prisma,
    );
    return { status: 'DECLINED' };
  }

  // ---- seller counters ----
  if (action === 'counter') {
    if (!isSeller || offer.status !== 'PENDING') throw new OfferError('Only a pending offer can be countered.');
    const c = counterAmount ?? 0n;
    if (c <= offer.amount) throw new OfferError('Counter above the buyer’s offer (or just accept it).');
    if (l.buyNowPrice !== null && c > l.buyNowPrice) {
      throw new OfferError('A counter can’t exceed the asking price.');
    }
    const claimed = await prisma.offer.updateMany({
      where: { id: offerId, status: 'PENDING' },
      data: { status: 'COUNTERED', counterAmount: c, expiresAt: new Date(clock.now().getTime() + OFFER_TTL_MS) },
    });
    if (claimed.count !== 1) throw new OfferError('That offer already closed.');
    // The original hold stays: it keeps backing the buyer up to their offer +
    // shipping; the delta up to the counter is checked when the buyer accepts.
    await system(`Countered at $${formatUsdc(c)}.`, userId);
    await notify(
      {
        userId: offer.buyerId,
        kind: 'offer',
        title: `Counter-offer on ${l.title}: $${formatUsdc(c)}`,
        body: `You offered $${formatUsdc(offer.amount)}; the seller countered at $${formatUsdc(c)}. Accept and it’s yours instantly.`,
        href: `/messages`,
      },
      prisma,
    );
    return { status: 'COUNTERED' };
  }

  // ---- accept: the sale happens NOW at the agreed price ----
  if (action === 'accept') {
    const sellerAccepting = isSeller && offer.status === 'PENDING';
    const buyerAccepting = isBuyer && offer.status === 'COUNTERED';
    if (!sellerAccepting && !buyerAccepting) throw new OfferError('That offer can’t be accepted now.');
    const price = buyerAccepting ? (offer.counterAmount ?? offer.amount) : offer.amount;
    const buyerId = offer.buyerId;

    // The listing already sold or was delisted: this offer can never complete,
    // so retire it NOW and free the buyer's reserve instead of stranding it
    // until the 48h expiry.
    if (l.status !== ListingStatus.QUEUED || l.quantity <= 0) {
      const dead = await prisma.offer.updateMany({
        where: { id: offerId, status: { in: ['PENDING', 'COUNTERED'] } },
        data: { status: 'EXPIRED' },
      });
      if (dead.count === 1) {
        await releaseHold(offerId, prisma);
        await system('The item is no longer available; the offer closed.', userId).catch(() => {});
      }
      throw new OfferError('This item is no longer available.');
    }

    // Buyer accepting a counter pays MORE than their hold reserves: verify the
    // delta is actually available before consuming anything.
    if (buyerAccepting && price > offer.amount) {
      const accountId = await getOrCreateUserAccount(buyerId, prisma);
      const available = await getSettledBalance(accountId, prisma) - (await getActiveHolds(accountId, prisma));
      // The hold's own reserve comes back the moment we release it below, so it
      // counts toward what the buyer can spend on the counter.
      if (available + offer.amount + offer.shippingC < price + offer.shippingC) {
        throw new OfferError(
          `Accepting needs $${formatUsdc(price + offer.shippingC)} available ($${formatUsdc(price)} + $${formatUsdc(offer.shippingC)} shipping). Deposit the difference first.`,
        );
      }
    }

    const claimed = await prisma.offer.updateMany({
      where: { id: offerId, status: { in: ['PENDING', 'COUNTERED'] } },
      data: { status: 'ACCEPTED' },
    });
    if (claimed.count !== 1) throw new OfferError('That offer already closed.');

    // Free the reserve so the charge can consume it, then run the exact same
    // sale pipeline as buy-now at the agreed price. Any failure rolls the offer
    // to EXPIRED with the hold already released: nobody is out any money.
    await releaseHold(offerId, prisma);
    try {
      const sale = await settleMarketSale(
        { listingId: offer.listingId, buyerId, amount: price, shippingC: offer.shippingC, via: 'offer' },
        opts,
        clock,
        prisma,
      );
      await prisma.offer.update({ where: { id: offerId }, data: { orderId: sale.orderId } });
      await system(`Offer accepted: sold for $${formatUsdc(price)}.`, userId);
      return { status: 'ACCEPTED', orderId: sale.orderId };
    } catch (err) {
      await prisma.offer.updateMany({ where: { id: offerId, status: 'ACCEPTED' }, data: { status: 'EXPIRED' } });
      await system('The item sold before this offer could be accepted.', userId).catch(() => {});
      if (err instanceof MarketError) throw new OfferError(err.message);
      throw err;
    }
  }

  throw new OfferError('That action isn’t available.');
}

/** Expire overdue offers and free their reserves. Called from a worker tick. */
export async function expireOffers(clock: Clock = systemClock, prisma: PrismaClient = defaultPrisma): Promise<number> {
  const due = await prisma.offer.findMany({
    where: { status: { in: ['PENDING', 'COUNTERED'] }, expiresAt: { lte: clock.now() } },
    include: { listing: { select: { title: true } } },
    take: 100,
  });
  let n = 0;
  for (const o of due) {
    const claimed = await prisma.offer.updateMany({
      where: { id: o.id, status: { in: ['PENDING', 'COUNTERED'] } },
      data: { status: 'EXPIRED' },
    });
    if (claimed.count !== 1) continue;
    await releaseHold(o.id, prisma);
    await postThreadEvent(
      { u1: o.buyerId, u2: o.sellerId, senderId: o.sellerId, kind: 'SYSTEM', text: `Offer of $${formatUsdc(o.amount)} expired.`, listingId: o.listingId, offerId: o.id },
      clock,
      prisma,
    ).catch(() => {});
    await notify(
      {
        userId: o.buyerId,
        kind: 'offer',
        title: `Your offer on ${o.listing.title} expired`,
        body: 'The reserved funds are back in your available balance.',
        href: `/marketplace/${o.listingId}`,
        email: false,
      },
      prisma,
    );
    n += 1;
  }
  return n;
}

/** DTO for rendering an offer card in a thread or on the listing page. */
export async function offerCard(offerId: string, prisma: PrismaClient = defaultPrisma) {
  const o = await prisma.offer.findUnique({
    where: { id: offerId },
    include: { listing: { select: { title: true, photos: true, buyNowPrice: true } } },
  });
  if (!o) return null;
  return {
    offerId: o.id,
    listingId: o.listingId,
    buyerId: o.buyerId,
    sellerId: o.sellerId,
    amount: o.amount.toString(),
    shippingC: o.shippingC.toString(),
    counterAmount: o.counterAmount?.toString() ?? null,
    status: o.status,
    expiresAt: o.expiresAt.getTime(),
    listingTitle: o.listing.title,
    listingPhoto: o.listing.photos[0] ?? null,
    askingPrice: o.listing.buyNowPrice?.toString() ?? null,
  };
}
