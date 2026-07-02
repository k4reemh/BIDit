import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { placeBid } from '../src/auction.js';
import { getAvailableBalance, getSettledBalance, getActiveHolds, withdraw } from '../src/ledger.js';
import { InsufficientFundsError } from '../src/errors.js';
import { usdc, BidRejectReason, HoldStatus } from '@bidit/shared';
import { resetDb, makeFundedUser, makeUser, makeRunningAuction } from './setup.js';

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();

beforeEach(async () => {
  await resetDb();
});

describe('multi-auction hold guarantee', () => {
  it('cannot lead two auctions whose holds exceed settled balance', async () => {
    const clock = new ManualClock(T0);
    const user = await makeFundedUser('100');
    const auctionA = await makeRunningAuction({ startingBid: '60', clock });
    const auctionB = await makeRunningAuction({ startingBid: '60', clock });

    // Lead A at $60 -> $60 held, $40 available.
    const r1 = await placeBid({ auctionId: auctionA.auctionId, userId: user.userId, amount: usdc('60') }, clock, prisma);
    expect(r1.ok).toBe(true);
    expect(await getAvailableBalance(user.accountId, prisma)).toBe(usdc('40'));

    // Try to also lead B at $60 -> rejected, even though settled balance is $100.
    const r2 = await placeBid({ auctionId: auctionB.auctionId, userId: user.userId, amount: usdc('60') }, clock, prisma);
    expect(r2).toEqual({ ok: false, reason: BidRejectReason.INSUFFICIENT_BALANCE });

    // Still exactly one ACTIVE hold for the user.
    const holds = await prisma.hold.findMany({ where: { accountId: user.accountId, status: HoldStatus.ACTIVE } });
    expect(holds).toHaveLength(1);
    expect(await getSettledBalance(user.accountId, prisma)).toBe(usdc('100'));
    expect(await getActiveHolds(user.accountId, prisma)).toBe(usdc('60'));
  });

  it('frees the user the instant they are outbid, letting them lead elsewhere', async () => {
    const clock = new ManualClock(T0);
    const user = await makeFundedUser('100');
    const rival = await makeFundedUser('100');
    const auctionA = await makeRunningAuction({ startingBid: '60', clock });
    const auctionB = await makeRunningAuction({ startingBid: '60', clock });

    await placeBid({ auctionId: auctionA.auctionId, userId: user.userId, amount: usdc('60') }, clock, prisma);
    // Rival outbids on A -> user's hold on A releases.
    await placeBid({ auctionId: auctionA.auctionId, userId: rival.userId, amount: usdc('63') }, clock, prisma);
    expect(await getAvailableBalance(user.accountId, prisma)).toBe(usdc('100'));

    // Now the user can lead B at $60.
    const r = await placeBid({ auctionId: auctionB.auctionId, userId: user.userId, amount: usdc('60') }, clock, prisma);
    expect(r.ok).toBe(true);
    expect(await getAvailableBalance(user.accountId, prisma)).toBe(usdc('40'));
  });
});

describe('holds integrate with the Chunk 1 ledger', () => {
  it('a withdrawal cannot touch funds locked in a hold', async () => {
    const clock = new ManualClock(T0);
    const user = await makeFundedUser('100');
    const auction = await makeRunningAuction({ startingBid: '60', clock });
    await placeBid({ auctionId: auction.auctionId, userId: user.userId, amount: usdc('60') }, clock, prisma);

    // $60 held, $40 available: withdrawing $50 must fail, $40 must pass.
    await expect(withdraw({ accountId: user.accountId, amount: usdc('50') }, prisma)).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    await withdraw({ accountId: user.accountId, amount: usdc('40') }, prisma);

    expect(await getSettledBalance(user.accountId, prisma)).toBe(usdc('60'));
    expect(await getAvailableBalance(user.accountId, prisma)).toBe(usdc('0'));
  });
});
