import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { placeBid, type BidResult } from '../src/auction.js';
import { getSettledBalance, getActiveHolds } from '../src/ledger.js';
import { usdc, BidRejectReason, AuctionStatus, HoldStatus } from '@bidit/shared';
import { resetDb, makeFundedUser, makeRunningAuction } from './setup.js';

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();

beforeEach(async () => {
  await resetDb();
});

/** The whole-system safety invariants the engine must never violate. */
async function assertGlobalInvariants(): Promise<void> {
  const accounts = await prisma.account.findMany({ where: { kind: 'USER' } });
  for (const account of accounts) {
    const settled = await getSettledBalance(account.id, prisma);
    const holds = await getActiveHolds(account.id, prisma);
    // No user can have holds exceeding their settled balance (no over-commit).
    expect(holds).toBeLessThanOrEqual(settled);
    expect(settled - holds).toBeGreaterThanOrEqual(0n);
  }

  const auctions = await prisma.auction.findMany();
  for (const auction of auctions) {
    const active = await prisma.hold.findMany({
      where: { auctionId: auction.id, status: HoldStatus.ACTIVE },
    });
    // At most one ACTIVE hold per auction (the leader's).
    expect(active.length).toBeLessThanOrEqual(1);
    if (auction.status === AuctionStatus.RUNNING && auction.currentBid !== null) {
      expect(active).toHaveLength(1);
      expect(active[0]?.amount).toBe(auction.currentBid);
      const leaderAccount = await prisma.account.findUnique({
        where: { userId: auction.currentLeaderUserId ?? '' },
      });
      expect(active[0]?.accountId).toBe(leaderAccount?.id);
    }
  }
}

describe('no race double-accept', () => {
  it('only one of many simultaneous equal bids is accepted as leader', async () => {
    const clock = new ManualClock(T0);
    const { auctionId } = await makeRunningAuction({ startingBid: '10', clock });

    const bidders = await Promise.all(
      Array.from({ length: 15 }, () => makeFundedUser('100')),
    );

    // All 15 fire the same $50 bid at once.
    const results = await Promise.all(
      bidders.map((b) =>
        placeBid({ auctionId, userId: b.userId, amount: usdc('50') }, clock, prisma),
      ),
    );

    const accepted = results.filter((r): r is Extract<BidResult, { ok: true }> => r.ok);
    expect(accepted).toHaveLength(1);
    // Everyone else loses cleanly on price (the first $50 raised the bar).
    for (const r of results) {
      if (!r.ok) expect(r.reason).toBe(BidRejectReason.BID_TOO_LOW);
    }

    const auction = await prisma.auction.findUnique({ where: { id: auctionId } });
    expect(auction?.currentBid).toBe(usdc('50'));
    const activeHolds = await prisma.hold.findMany({
      where: { auctionId, status: HoldStatus.ACTIVE },
    });
    expect(activeHolds).toHaveLength(1);
    await assertGlobalInvariants();
  });
});

describe('the multi-auction exploit is blocked under concurrency', () => {
  it('a user firing two leading bids at once can only win one', async () => {
    const clock = new ManualClock(T0);
    const user = await makeFundedUser('100');
    const a = await makeRunningAuction({ startingBid: '60', clock });
    const b = await makeRunningAuction({ startingBid: '60', clock });

    // Fire both $60 bids concurrently — combined they exceed the $100 balance.
    const [r1, r2] = await Promise.all([
      placeBid({ auctionId: a.auctionId, userId: user.userId, amount: usdc('60') }, clock, prisma),
      placeBid({ auctionId: b.auctionId, userId: user.userId, amount: usdc('60') }, clock, prisma),
    ]);

    const okCount = [r1, r2].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    const rejected = [r1, r2].find((r) => !r.ok);
    expect(rejected && !rejected.ok && rejected.reason).toBe(
      BidRejectReason.INSUFFICIENT_BALANCE,
    );

    // Exactly $60 held — never $120.
    expect(await getActiveHolds(user.accountId, prisma)).toBe(usdc('60'));
    await assertGlobalInvariants();
  });
});

describe('invariants hold under randomized concurrent load', () => {
  it('survives a storm of concurrent bids across users and auctions', async () => {
    const clock = new ManualClock(T0);
    const users = await Promise.all(
      Array.from({ length: 6 }, () => makeFundedUser('120')),
    );
    const auctions = await Promise.all(
      Array.from({ length: 4 }, () => makeRunningAuction({ startingBid: '5', clock })),
    );

    const rand = (n: number) => Math.floor(Math.random() * n);
    const bids = Array.from({ length: 60 }, () => {
      const user = users[rand(users.length)]!;
      const auction = auctions[rand(auctions.length)]!;
      const dollars = 5 + rand(36); // $5..$40
      return placeBid(
        { auctionId: auction.auctionId, userId: user.userId, amount: usdc(String(dollars)) },
        clock,
        prisma,
      );
    });

    const results = await Promise.allSettled(bids);
    // No bid should throw — every outcome is a clean accept or typed reject.
    for (const r of results) expect(r.status).toBe('fulfilled');

    await assertGlobalInvariants();
  });
});
