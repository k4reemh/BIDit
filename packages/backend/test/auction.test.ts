import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import {
  placeBid,
  getAuctionSnapshot,
  closeDueAuctions,
} from '../src/auction.js';
import { getAvailableBalance } from '../src/ledger.js';
import {
  usdc,
  formatUsdc,
  minNextBid,
  BidRejectReason,
  AuctionStatus,
  BidStatus,
  ListingStatus,
  HoldStatus,
} from '@bidit/shared';
import { resetDb, makeFundedUser, makeRunningAuction } from './setup.js';

describe('tiered minimum increment', () => {
  const next = (cur: string) => formatUsdc(minNextBid(usdc(cur), usdc('1')));
  it('is $1/5% below $50, then flat $2 at ≥$50 and $5 at ≥$150', () => {
    expect(next('10')).toBe('11'); // below $50 → $1 floor
    expect(next('50')).toBe('52'); // ≥$50 → +$2
    expect(next('100')).toBe('102'); // still +$2
    expect(next('150')).toBe('155'); // ≥$150 → +$5
    expect(next('300')).toBe('305'); // still +$5
  });
});

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();

beforeEach(async () => {
  await resetDb();
});

describe('timer extension (anti-snipe)', () => {
  it('starts with endsAt = now + durationSeconds', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const snap = await getAuctionSnapshot(auctionId, clock, prisma);
    expect(snap?.status).toBe(AuctionStatus.RUNNING);
    expect(snap?.endsAt?.getTime()).toBe(T0 + 20_000);
    expect(snap?.remainingMs).toBe(20_000);
  });

  it('does NOT extend when more than 5s remain (outside the window)', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const buyer = await makeFundedUser('100');

    // remaining = 20s > 5s window -> no extension, no flash.
    const res = await placeBid({ auctionId, userId: buyer.userId, amount: usdc('10') }, clock, prisma);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.extended).toBe(false);
      expect(res.snapshot.endsAt?.getTime()).toBe(T0 + 20_000);
    }
  });

  it('does NOT extend just outside the window (5.001s left)', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const buyer = await makeFundedUser('100');
    // At 14.999s in, remaining = 5.001s > 5s -> no extension.
    clock.advance(14_999);
    const res = await placeBid({ auctionId, userId: buyer.userId, amount: usdc('10') }, clock, prisma);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.extended).toBe(false);
      expect(res.snapshot.endsAt?.getTime()).toBe(T0 + 20_000);
    }
  });

  it('bumps +1s when a bid lands in the 3–5s band', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const a = await makeFundedUser('100');
    const b = await makeFundedUser('100');

    await placeBid({ auctionId, userId: a.userId, amount: usdc('10') }, clock, prisma);

    // Jump to 16s in: remaining = 4s (3–5s band) -> +1s -> endsAt = T0+21s.
    clock.advance(16_000);
    const res = await placeBid({ auctionId, userId: b.userId, amount: usdc('11') }, clock, prisma);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.extended).toBe(true);
      expect(res.snapshot.endsAt?.getTime()).toBe(T0 + 21_000);
    }
  });

  it('bumps +2s when a bid lands under 3s (urgent band)', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const a = await makeFundedUser('100');
    const b = await makeFundedUser('100');

    await placeBid({ auctionId, userId: a.userId, amount: usdc('10') }, clock, prisma);

    // Jump to 18s in: remaining = 2s (<3s) -> +2s -> endsAt = T0+22s.
    clock.advance(18_000);
    const res = await placeBid({ auctionId, userId: b.userId, amount: usdc('11') }, clock, prisma);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.extended).toBe(true);
      expect(res.snapshot.endsAt?.getTime()).toBe(T0 + 22_000);
    }
  });

  it('caps the deadline so it can never sit more than 5s out', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const a = await makeFundedUser('100');
    const b = await makeFundedUser('100');

    await placeBid({ auctionId, userId: a.userId, amount: usdc('10') }, clock, prisma);

    // Jump to 15.5s in: remaining = 4.5s, +1s would be 5.5s but the cap pins it
    // to exactly now + 5s = T0+20.5s (only +0.5s of real extension).
    clock.advance(15_500);
    const res = await placeBid({ auctionId, userId: b.userId, amount: usdc('11') }, clock, prisma);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.extended).toBe(true);
      expect(res.snapshot.endsAt?.getTime()).toBe(T0 + 20_500);
      // Deadline is now exactly 5s from "now" — the perpetual-final-seconds cap.
      expect(res.snapshot.remainingMs).toBe(5_000);
    }
  });

  it('keeps bumping on repeated late bids but never past the 5s cap', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const a = await makeFundedUser('100');
    const b = await makeFundedUser('100');

    // Drive into the urgent band and trade bids; the deadline should ratchet
    // forward each time yet always cap at now + 5s.
    clock.advance(18_000); // remaining 2s
    let leader = a;
    for (let i = 0; i < 4; i++) {
      const bidder = leader.userId === a.userId ? b : a;
      const res = await placeBid(
        { auctionId, userId: bidder.userId, amount: usdc(String(11 + i)) },
        clock,
        prisma,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.extended).toBe(true);
        // Never more than 5s out from the moment of the bid.
        expect(res.snapshot.remainingMs).toBeLessThanOrEqual(5_000);
        expect(res.snapshot.remainingMs).toBeGreaterThan(0);
      }
      leader = bidder;
      clock.advance(1_500); // time ticks between bids, staying in the danger zone
    }
  });
});

describe('bid validation pipeline', () => {
  it('AUCTION_NOT_FOUND for an unknown auction', async () => {
    const clock = new ManualClock(T0);
    const buyer = await makeFundedUser('100');
    const res = await placeBid({ auctionId: 'nope', userId: buyer.userId, amount: usdc('10') }, clock, prisma);
    expect(res).toEqual({ ok: false, reason: BidRejectReason.AUCTION_NOT_FOUND });
  });

  it('AUCTION_ENDED once the deadline passes', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const buyer = await makeFundedUser('100');
    clock.advance(20_001); // past endsAt
    const res = await placeBid({ auctionId, userId: buyer.userId, amount: usdc('10') }, clock, prisma);
    expect(res).toEqual({ ok: false, reason: BidRejectReason.AUCTION_ENDED });
  });

  it('BID_TOO_LOW below the starting bid', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const buyer = await makeFundedUser('100');
    const res = await placeBid({ auctionId, userId: buyer.userId, amount: usdc('9.99') }, clock, prisma);
    expect(res).toEqual({ ok: false, reason: BidRejectReason.BID_TOO_LOW });
  });

  it('BID_TOO_LOW below current + minIncrement', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const a = await makeFundedUser('100');
    const b = await makeFundedUser('100');
    await placeBid({ auctionId, userId: a.userId, amount: usdc('10') }, clock, prisma);
    // current 10, min increment = max($1, 5% of 10 = $0.50) = $1 -> need >= $11
    const res = await placeBid({ auctionId, userId: b.userId, amount: usdc('10.50') }, clock, prisma);
    expect(res).toEqual({ ok: false, reason: BidRejectReason.BID_TOO_LOW });
  });

  it('ALREADY_LEADING — no bidding against yourself', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const a = await makeFundedUser('100');
    await placeBid({ auctionId, userId: a.userId, amount: usdc('10') }, clock, prisma);
    const res = await placeBid({ auctionId, userId: a.userId, amount: usdc('20') }, clock, prisma);
    expect(res).toEqual({ ok: false, reason: BidRejectReason.ALREADY_LEADING });
  });

  it('INSUFFICIENT_BALANCE when available < amount', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const poor = await makeFundedUser('10');
    const res = await placeBid({ auctionId, userId: poor.userId, amount: usdc('50') }, clock, prisma);
    expect(res).toEqual({ ok: false, reason: BidRejectReason.INSUFFICIENT_BALANCE });
  });
});

describe('leader tracking & holds', () => {
  it('tracks leader, moves the hold, and frees the outbid user instantly', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const a = await makeFundedUser('100');
    const b = await makeFundedUser('100');

    await placeBid({ auctionId, userId: a.userId, amount: usdc('10') }, clock, prisma);
    // A leads, $10 held, available 90.
    expect(await getAvailableBalance(a.accountId, prisma)).toBe(usdc('90'));

    const res = await placeBid({ auctionId, userId: b.userId, amount: usdc('11') }, clock, prisma);
    expect(res.ok).toBe(true);

    const snap = await getAuctionSnapshot(auctionId, clock, prisma);
    expect(snap?.currentLeaderUserId).toBe(b.userId);
    expect(snap?.currentBid).toBe(usdc('11'));
    // min next = 11 + max($1, 5% of 11 = $0.55) = $12
    expect(snap?.minNextBid).toBe(usdc('12'));

    // A's hold released -> back to full balance; B holds $11.
    expect(await getAvailableBalance(a.accountId, prisma)).toBe(usdc('100'));
    expect(await getAvailableBalance(b.accountId, prisma)).toBe(usdc('89'));

    // Exactly one ACTIVE hold on the auction, owned by B.
    const activeHolds = await prisma.hold.findMany({
      where: { auctionId, status: HoldStatus.ACTIVE },
    });
    expect(activeHolds).toHaveLength(1);
    expect(activeHolds[0]?.accountId).toBe(b.accountId);
    expect(activeHolds[0]?.amount).toBe(usdc('11'));

    // A's bid is OUTBID, B's is ACTIVE.
    const aBid = await prisma.bid.findFirst({ where: { auctionId, userId: a.userId } });
    const bBid = await prisma.bid.findFirst({ where: { auctionId, userId: b.userId } });
    expect(aBid?.status).toBe(BidStatus.OUTBID);
    expect(bBid?.status).toBe(BidStatus.ACTIVE);
  });
});

describe('server-driven closing', () => {
  it('closes a contested auction to SETTLING with the leader as winner', async () => {
    const clock = new ManualClock(T0);
    const { auctionId, listingId } = await makeRunningAuction({ startingBid: '10', clock });
    const a = await makeFundedUser('100');
    const b = await makeFundedUser('100');
    await placeBid({ auctionId, userId: a.userId, amount: usdc('10') }, clock, prisma);
    await placeBid({ auctionId, userId: b.userId, amount: usdc('11') }, clock, prisma);

    clock.advance(60_000); // well past the deadline
    const results = await closeDueAuctions(clock, prisma);
    expect(results).toEqual([
      { auctionId, status: AuctionStatus.SETTLING, winnerUserId: b.userId },
    ]);

    const auction = await prisma.auction.findUnique({ where: { id: auctionId } });
    expect(auction?.status).toBe(AuctionStatus.SETTLING);

    const winningBid = await prisma.bid.findFirst({ where: { auctionId, userId: b.userId } });
    expect(winningBid?.status).toBe(BidStatus.WON);

    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    expect(listing?.status).toBe(ListingStatus.SOLD);

    // Winner's hold remains ACTIVE — captured at settlement (Chunk 5).
    const winnerHolds = await prisma.hold.findMany({
      where: { auctionId, status: HoldStatus.ACTIVE },
    });
    expect(winnerHolds).toHaveLength(1);
    expect(winnerHolds[0]?.amount).toBe(usdc('11'));
  });

  it('closes an auction with no bids to CLOSED and re-queues the listing (still has stock)', async () => {
    const clock = new ManualClock(T0);
    const { auctionId, listingId } = await makeRunningAuction({ startingBid: '10', clock });
    clock.advance(20_001);
    const results = await closeDueAuctions(clock, prisma);
    expect(results).toEqual([
      { auctionId, status: AuctionStatus.CLOSED, winnerUserId: null },
    ]);
    // Nothing sold → the item is still available, so it goes back to QUEUED and
    // can be auctioned again (rather than being stuck as UNSOLD).
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    expect(listing?.status).toBe(ListingStatus.QUEUED);
  });

  it('does not close early when a late bid extended the deadline', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });
    const a = await makeFundedUser('100');
    const b = await makeFundedUser('100');

    await placeBid({ auctionId, userId: a.userId, amount: usdc('10') }, clock, prisma);
    clock.advance(18_000); // remaining 2s (urgent) -> +2s -> endsAt = T0+22s
    const ext = await placeBid({ auctionId, userId: b.userId, amount: usdc('11') }, clock, prisma);
    expect(ext.ok && ext.extended).toBe(true);

    // Past the ORIGINAL deadline (T0+20s) but before the extended one (T0+22s).
    clock.set(T0 + 21_000);
    expect(await closeDueAuctions(clock, prisma)).toEqual([]);
    const stillRunning = await prisma.auction.findUnique({ where: { id: auctionId } });
    expect(stillRunning?.status).toBe(AuctionStatus.RUNNING);

    // Past the extended deadline -> now it closes.
    clock.set(T0 + 22_500);
    const results = await closeDueAuctions(clock, prisma);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe(AuctionStatus.SETTLING);
  });
});
