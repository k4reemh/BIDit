import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { placeBid, closeDueAuctions } from '../src/auction.js';
import { settleAuctionDirect } from '../src/orders.js';
import {
  awardOrderPoints,
  getPointsSummary,
  claimMission,
  getLeaderboard,
  pointsForSpend,
  pointsForSale,
  PointsError,
} from '../src/points.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeFundedUser, makeUser, makeRunningAuction } from './setup.js';

const T0 = new Date('2026-04-01T00:00:00.000Z').getTime();

beforeEach(async () => {
  await resetDb();
});

/** Win a $`bid` auction as `buyerId` and settle it (direct-payout mode). */
async function winAuction(buyerId: string, bid: string, clock: ManualClock) {
  const a = await makeRunningAuction({ startingBid: '1', clock, durationSeconds: 20 });
  const r = await placeBid({ auctionId: a.auctionId, userId: buyerId, amount: usdc(bid) }, clock, prisma);
  expect(r.ok).toBe(true);
  clock.advance(21_000);
  await closeDueAuctions(clock, prisma);
  await settleAuctionDirect(a.auctionId, clock, prisma);
  return a;
}

describe('points math', () => {
  it('buyer earns 100 pts per $1, seller 20 pts per $1', () => {
    expect(pointsForSpend(usdc('10'))).toBe(1_000n);
    expect(pointsForSale(usdc('1000'))).toBe(20_000n);
    expect(pointsForSpend(usdc('0.50'))).toBe(50n);
  });
});

describe('automatic accrual on sales', () => {
  it('awards buyer 100x and seller 20x when an auction settles', async () => {
    const clock = new ManualClock(T0);
    const buyer = await makeFundedUser('100');
    const a = await winAuction(buyer.userId, '10', clock);

    const buyerRow = await prisma.user.findUniqueOrThrow({ where: { id: buyer.userId } });
    const sellerRow = await prisma.user.findUniqueOrThrow({ where: { id: a.sellerId } });
    expect(buyerRow.points).toBe(1_000n); // $10 → 1,000 pts
    expect(sellerRow.points).toBe(200n); // $10 sold → 200 pts
  });

  it('is idempotent per order — a retried award pays nothing extra', async () => {
    const clock = new ManualClock(T0);
    const buyer = await makeFundedUser('100');
    await winAuction(buyer.userId, '10', clock);

    const order = await prisma.order.findFirstOrThrow({ where: { buyerId: buyer.userId } });
    await awardOrderPoints({ orderId: order.id, buyerId: order.buyerId, sellerId: order.sellerId, amount: order.amount }, prisma);

    const buyerRow = await prisma.user.findUniqueOrThrow({ where: { id: buyer.userId } });
    expect(buyerRow.points).toBe(1_000n); // unchanged
    expect(await prisma.pointsEvent.count({ where: { userId: buyer.userId, kind: 'buy' } })).toBe(1);
  });
});

describe('missions', () => {
  it('derives status: locked → claimable → claimed, and pays once', async () => {
    const clock = new ManualClock(T0);
    const buyer = await makeFundedUser('100'); // funding = a DEPOSIT ledger entry

    let s = await getPointsSummary(buyer.userId, prisma);
    const get = (id: string) => s.missions.find((m) => m.id === id)!;
    expect(get('deposit').status).toBe('claimable'); // deposited on creation
    expect(get('first_bid').status).toBe('locked');
    expect(get('first_win').status).toBe('locked');
    expect(get('refer_friend').status).toBe('locked'); // coming soon stays locked

    await winAuction(buyer.userId, '10', clock); // places a bid + wins

    s = await getPointsSummary(buyer.userId, prisma);
    expect(get('first_bid').status).toBe('claimable');
    expect(get('first_win').status).toBe('claimable');

    const before = (await prisma.user.findUniqueOrThrow({ where: { id: buyer.userId } })).points;
    const claim = await claimMission(buyer.userId, 'first_win', prisma);
    expect(claim.points).toBe(3_000n);
    expect(claim.total).toBe(before + 3_000n);

    s = await getPointsSummary(buyer.userId, prisma);
    expect(get('first_win').status).toBe('claimed');

    await expect(claimMission(buyer.userId, 'first_win', prisma)).rejects.toThrow(PointsError); // double claim
  });

  it('rejects claiming an incomplete or unknown mission', async () => {
    const user = await makeUser('buyer');
    await expect(claimMission(user.userId, 'first_win', prisma)).rejects.toThrow(/Complete the mission/);
    await expect(claimMission(user.userId, 'nope', prisma)).rejects.toThrow(/Unknown mission/);
    await expect(claimMission(user.userId, 'refer_friend', prisma)).rejects.toThrow(/soon/);
  });

  it('giveaway win unlocks the giveaway mission', async () => {
    const user = await makeUser('buyer');
    const seller = await makeUser('seller');
    await prisma.giveaway.create({
      data: {
        sellerId: seller.userId,
        kind: 'PUBLIC',
        prize: 'Chopper card',
        status: 'CLOSED',
        seed: 's',
        seedHash: 'h',
        winnerUserId: user.userId,
        closesAt: new Date(T0),
      },
    });
    const s = await getPointsSummary(user.userId, prisma);
    expect(s.missions.find((m) => m.id === 'giveaway_win')!.status).toBe('claimable');
  });

  it('seller missions key off fulfilled (shipped/delivered) items and $500 fulfilled value', async () => {
    const seller = await makeUser('seller');
    await prisma.sellerProfile.create({ data: { userId: seller.userId } });
    const buyer = await makeUser('buyer');
    const mk = (n: number, status: string, amount: bigint) => prisma.fulfillmentItem.create({
      data: { orderId: `o${n}`, buyerId: buyer.userId, sellerId: seller.userId, listingId: 'l', title: `Card ${n}`, amount, status, heldUntil: new Date(T0 + 1e9) },
    });

    await mk(1, 'READY_TO_SHIP', usdc('50')); // not fulfilled yet
    let s = await getPointsSummary(seller.userId, prisma);
    const get = (id: string) => s.missions.find((m) => m.id === id)!;
    expect(get('first_sale').status).toBe('locked');

    await mk(2, 'SHIPPED', usdc('100'));
    s = await getPointsSummary(seller.userId, prisma);
    expect(get('first_sale').status).toBe('claimable');
    expect(get('sell_10').status).toBe('locked');
    expect(get('verified_seller').status).toBe('locked'); // $100 < $500

    await mk(3, 'DELIVERED', usdc('450')); // $550 fulfilled total
    s = await getPointsSummary(seller.userId, prisma);
    expect(get('verified_seller').status).toBe('claimable');

    const claim = await claimMission(seller.userId, 'verified_seller', prisma);
    expect(claim.points).toBe(10_000n);
  });
});

describe('leaderboard', () => {
  it('ranks users by points, highest first, skipping zero-point users', async () => {
    const a = await makeUser('buyer');
    const b = await makeUser('buyer');
    await makeUser('buyer'); // zero points — should not appear
    await prisma.user.update({ where: { id: a.userId }, data: { points: 5_000n } });
    await prisma.user.update({ where: { id: b.userId }, data: { points: 12_000n } });

    const rows = await getLeaderboard(10, prisma);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.handle).toBe(b.handle);
    expect(rows[0]!.rank).toBe(1);
    expect(rows[0]!.points).toBe(12_000n);
    expect(rows[1]!.handle).toBe(a.handle);
    expect(rows[1]!.rank).toBe(2);
  });
});
