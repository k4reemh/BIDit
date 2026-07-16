import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { placeBid, closeDueAuctions, createAuction, startAuction } from '../src/auction.js';
import { DevWalletEscrow } from '../src/escrow.js';
import {
  settleAuction,
  settleAuctionDirect,
  markShipped,
  markDelivered,
  openDispute,
  resolveDispute,
  releaseOrder,
  processOrderTimers,
  DISPUTE_WINDOW_MS,
  NO_SHIP_TIMEOUT_MS,
} from '../src/orders.js';
import {
  getSettledBalance,
  getAvailableBalance,
  getBuybackPending,
  getSystemTotal,
} from '../src/ledger.js';
import { usdc, AuctionStatus, OrderStatus, ListingStatus, SYSTEM_ACCOUNT_IDS, ESCROW_WALLET_ADDRESS } from '@bidit/shared';
import { resetDb, makeFundedUser, makeRunningAuction, makeUser } from './setup.js';

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const escrow = new DevWalletEscrow(prisma);

beforeEach(async () => {
  await resetDb();
});

/** Produce a SETTLING auction with a winning bid; returns the players. */
async function won(opts: { deposit: string; startingBid: string; bid: string; clock: ManualClock }) {
  const auction = await makeRunningAuction({
    startingBid: opts.startingBid,
    clock: opts.clock,
    durationSeconds: 20,
  });
  const buyer = await makeFundedUser(opts.deposit);
  const r = await placeBid(
    { auctionId: auction.auctionId, userId: buyer.userId, amount: usdc(opts.bid) },
    opts.clock,
    prisma,
  );
  expect(r.ok).toBe(true);
  opts.clock.advance(21_000);
  const closed = await closeDueAuctions(opts.clock, prisma);
  expect(closed[0]?.status).toBe(AuctionStatus.SETTLING);
  return { auctionId: auction.auctionId, sellerId: auction.sellerId, buyer };
}

async function sellerAccountId(sellerId: string): Promise<string> {
  const account = await prisma.account.findUnique({ where: { userId: sellerId } });
  return account!.id;
}

describe('listing quantity + re-auction', () => {
  it('decrements the listing on each sale and re-queues it until sold out', async () => {
    const clock = new ManualClock(T0);
    const seller = await makeUser('seller');
    const listing = await prisma.listing.create({
      data: { sellerId: seller.userId, title: '2× Charizard', photos: [], startingBid: usdc('5'), quantity: 2, status: ListingStatus.QUEUED },
    });

    const runSale = async () => {
      const auctionId = await createAuction({ listingId: listing.id, startingBid: usdc('5'), durationSeconds: 20 }, prisma);
      await startAuction(auctionId, clock, prisma);
      const buyer = await makeFundedUser('50');
      const r = await placeBid({ auctionId, userId: buyer.userId, amount: usdc('5') }, clock, prisma);
      expect(r.ok).toBe(true);
      clock.advance(21_000);
      await closeDueAuctions(clock, prisma);
      await settleAuction(auctionId, escrow, clock, prisma);
    };

    await runSale();
    let l = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.quantity).toBe(1);
    expect(l.status).toBe(ListingStatus.QUEUED); // one unit left → auction it again

    await runSale();
    l = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.quantity).toBe(0);
    expect(l.status).toBe(ListingStatus.SOLD); // sold out
  });
});

describe('direct-payout settlement (no escrow, no fee)', () => {
  it('pays the seller 100% immediately and spends the buyer, idempotently', async () => {
    const clock = new ManualClock(T0);
    const { auctionId, sellerId, buyer } = await won({ deposit: '100', startingBid: '10', bid: '40', clock });

    const order = await settleAuctionDirect(auctionId, clock, prisma);
    expect(order?.status).toBe(OrderStatus.RELEASED);
    expect(order?.platformFee).toBe(0n);
    expect(order?.sellerProceeds).toBe(usdc('40'));

    const sellerAcc = await sellerAccountId(sellerId);
    const buyerAcc = (await prisma.account.findUniqueOrThrow({ where: { userId: buyer.userId } })).id;
    // Seller got the full $40, immediately withdrawable (no hold).
    expect(await getSettledBalance(sellerAcc, prisma)).toBe(usdc('40'));
    expect(await getAvailableBalance(sellerAcc, prisma)).toBe(usdc('40'));
    // Buyer's $40 is actually spent (hold captured): $100 -> $60, no lingering hold.
    expect(await getSettledBalance(buyerAcc, prisma)).toBe(usdc('60'));
    expect(await getAvailableBalance(buyerAcc, prisma)).toBe(usdc('60'));

    // Idempotent — re-running doesn't double-pay.
    const again = await settleAuctionDirect(auctionId, clock, prisma);
    expect(again?.id).toBe(order?.id);
    expect(await getSettledBalance(sellerAcc, prisma)).toBe(usdc('40'));
  });
});

describe('settlement (auction close -> LOCKED order)', () => {
  it('creates a LOCKED order and moves the bid into escrow (no fee yet)', async () => {
    const clock = new ManualClock(T0);
    const { auctionId, buyer } = await won({ deposit: '100', startingBid: '5', bid: '20', clock });

    const order = await settleAuction(auctionId, escrow, clock, prisma);
    expect(order).not.toBeNull();
    expect(order!.status).toBe(OrderStatus.LOCKED);
    expect(order!.escrowRef).toBe(`devwallet:${ESCROW_WALLET_ADDRESS}:${order!.id}`);
    expect(order!.amount).toBe(usdc('20'));
    expect(order!.platformFee).toBe(usdc('1')); // 5%
    expect(order!.sellerProceeds).toBe(usdc('19')); // 95%
    expect(order!.lockedAt).not.toBeNull();
    expect(order!.noShipDeadline).not.toBeNull();

    // Buyer charged; funds now sit in escrow. No fee taken yet.
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('80'));
    expect(await getAvailableBalance(buyer.accountId, prisma)).toBe(usdc('80'));
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.ESCROW, prisma)).toBe(usdc('20'));
    expect(await getBuybackPending(prisma)).toBe(0n);
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('is idempotent — settling twice yields the same single order', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await won({ deposit: '100', startingBid: '5', bid: '20', clock });
    const a = await settleAuction(auctionId, escrow, clock, prisma);
    const b = await settleAuction(auctionId, escrow, clock, prisma);
    expect(a!.id).toBe(b!.id);
    expect(await prisma.order.count()).toBe(1);
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.ESCROW, prisma)).toBe(usdc('20'));
  });
});

describe('happy path: ship -> deliver -> release splits 95/4/1', () => {
  it('walks LOCKED -> SHIPPED -> DISPUTE_WINDOW -> RELEASED and pays out correctly', async () => {
    const clock = new ManualClock(T0);
    const { auctionId, sellerId } = await won({ deposit: '100', startingBid: '5', bid: '20', clock });
    const sellerAcct = await sellerAccountId(sellerId);
    const order = (await settleAuction(auctionId, escrow, clock, prisma))!;

    const shipped = await markShipped(order.id, 'TRACK-123', clock, prisma);
    expect(shipped.status).toBe(OrderStatus.SHIPPED);
    expect(shipped.trackingNumber).toBe('TRACK-123');

    const delivered = await markDelivered(order.id, clock, prisma);
    expect(delivered.status).toBe(OrderStatus.DISPUTE_WINDOW);
    expect(delivered.deliveredAt).not.toBeNull();
    expect(delivered.disputeWindowEndsAt).not.toBeNull();

    // Window passes with no dispute -> auto release.
    clock.advance(DISPUTE_WINDOW_MS + 1000);
    const result = await processOrderTimers(escrow, clock, prisma);
    expect(result.released).toEqual([order.id]);

    const released = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(released.status).toBe(OrderStatus.RELEASED);

    // 95% seller / 4% buyback / 1% fee, escrow emptied.
    expect(await getSettledBalance(sellerAcct, prisma)).toBe(usdc('19'));
    expect(await getBuybackPending(prisma)).toBe(usdc('0.8')); // 4% buyback pool
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma)).toBe(usdc('0.2')); // 1% fee pool
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.ESCROW, prisma)).toBe(0n);
    expect(await getSystemTotal(prisma)).toBe(0n);
  });
});

describe('refunds return the whole amount (fee only taken on release)', () => {
  it('no-ship timeout cancels and refunds 100% to the buyer', async () => {
    const clock = new ManualClock(T0);
    const { auctionId, buyer, sellerId } = await won({ deposit: '100', startingBid: '5', bid: '20', clock });
    const sellerAcct = await sellerAccountId(sellerId);
    const order = (await settleAuction(auctionId, escrow, clock, prisma))!;

    // Seller never ships; the no-ship deadline passes.
    clock.advance(NO_SHIP_TIMEOUT_MS + 1000);
    const result = await processOrderTimers(escrow, clock, prisma);
    expect(result.refunded).toEqual([order.id]);

    const refunded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(refunded.status).toBe(OrderStatus.REFUNDED);
    expect(refunded.canceledAt).not.toBeNull();

    // Buyer whole again; no fee ever taken; seller got nothing.
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('100'));
    expect(await getSettledBalance(sellerAcct, prisma)).toBe(0n);
    expect(await getBuybackPending(prisma)).toBe(0n);
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.ESCROW, prisma)).toBe(0n);
    expect(await getSystemTotal(prisma)).toBe(0n);
  });

  it('dispute resolved as REFUND returns 100% to the buyer', async () => {
    const clock = new ManualClock(T0);
    const { auctionId, buyer } = await won({ deposit: '100', startingBid: '5', bid: '20', clock });
    const order = (await settleAuction(auctionId, escrow, clock, prisma))!;
    await markShipped(order.id, 'T', clock, prisma);
    await markDelivered(order.id, clock, prisma);

    const disputed = await openDispute(order.id, clock, prisma);
    expect(disputed.status).toBe(OrderStatus.DISPUTED);

    const resolved = await resolveDispute(order.id, 'REFUND', escrow, clock, prisma);
    expect(resolved.status).toBe(OrderStatus.REFUNDED);
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('100'));
    expect(await getBuybackPending(prisma)).toBe(0n);
    expect(await getSystemTotal(prisma)).toBe(0n);
  });
});

describe('dispute resolved as RELEASE pays the seller', () => {
  it('splits 95/4/1 just like the happy path', async () => {
    const clock = new ManualClock(T0);
    const { auctionId, sellerId } = await won({ deposit: '100', startingBid: '5', bid: '20', clock });
    const sellerAcct = await sellerAccountId(sellerId);
    const order = (await settleAuction(auctionId, escrow, clock, prisma))!;
    await markShipped(order.id, 'T', clock, prisma);
    await markDelivered(order.id, clock, prisma);
    await openDispute(order.id, clock, prisma);

    const resolved = await resolveDispute(order.id, 'RELEASE', escrow, clock, prisma);
    expect(resolved.status).toBe(OrderStatus.RELEASED);
    expect(await getSettledBalance(sellerAcct, prisma)).toBe(usdc('19'));
    expect(await getBuybackPending(prisma)).toBe(usdc('0.8')); // 4% buyback pool
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma)).toBe(usdc('0.2')); // 1% fee pool
    expect(await getSystemTotal(prisma)).toBe(0n);
  });
});

describe('guards', () => {
  it('rejects out-of-order transitions', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await won({ deposit: '100', startingBid: '5', bid: '20', clock });
    const order = (await settleAuction(auctionId, escrow, clock, prisma))!;
    // Can't deliver before shipping.
    await expect(markDelivered(order.id, clock, prisma)).rejects.toThrow();
  });

  it('escrow release is idempotent — no double payout', async () => {
    const clock = new ManualClock(T0);
    const { auctionId, sellerId } = await won({ deposit: '100', startingBid: '5', bid: '20', clock });
    const sellerAcct = await sellerAccountId(sellerId);
    const order = (await settleAuction(auctionId, escrow, clock, prisma))!;
    await markShipped(order.id, 'T', clock, prisma);
    await markDelivered(order.id, clock, prisma);
    await releaseOrder(order.id, escrow, clock, prisma);

    // Calling the escrow release again must not pay the seller twice.
    await escrow.release(order.id);
    expect(await getSettledBalance(sellerAcct, prisma)).toBe(usdc('19'));
    expect(await getBuybackPending(prisma)).toBe(usdc('0.8')); // 4% buyback pool
    expect(await getSettledBalance(SYSTEM_ACCOUNT_IDS.FEE, prisma)).toBe(usdc('0.2')); // 1% fee pool
    expect(await getSystemTotal(prisma)).toBe(0n);
  });
});
