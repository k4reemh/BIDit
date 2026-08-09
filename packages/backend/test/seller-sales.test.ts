import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { listSellerSales } from '../src/seller-sales.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeUser } from './setup.js';

const DAY = 86_400_000;

async function order(sellerId: string, buyerId: string, amount: string, createdAt: Date, withAuction: boolean) {
  let auctionId: string | null = null;
  if (withAuction) {
    const listing = await prisma.listing.create({
      data: { sellerId, title: `Card ${Math.random().toString(36).slice(2, 7)}`, startingBid: usdc('1'), photos: [] },
    });
    const auction = await prisma.auction.create({
      data: { listingId: listing.id, status: 'CLOSED', startingBid: usdc('1'), endsAt: createdAt },
    });
    auctionId = auction.id;
  }
  return prisma.order.create({
    data: {
      sellerId,
      buyerId,
      auctionId,
      amount: usdc(amount),
      platformFee: usdc('0'),
      sellerProceeds: usdc(amount),
      status: 'LOCKED',
      createdAt,
    },
  });
}

const giveaway = (sellerId: string, winnerUserId: string, prize: string, drawnAt: Date) =>
  prisma.giveaway.create({
    data: { sellerId, kind: 'PUBLIC', prize, status: 'CLOSED', seed: 's', seedHash: 'h', winnerUserId, closesAt: drawnAt, drawnAt, createdAt: drawnAt },
  });

describe('listSellerSales', () => {
  beforeEach(async () => { await resetDb(); });

  it('merges orders and drawn giveaways, newest first, with a real total', async () => {
    const seller = await makeUser('seller');
    const alice = await makeUser('buyer');
    const bob = await makeUser('buyer');
    const now = Date.now();
    await order(seller.userId, alice.userId, '20', new Date(now - 3000), true);
    await order(seller.userId, bob.userId, '10', new Date(now - 2000), false); // store buy
    await giveaway(seller.userId, alice.userId, 'Promo pack', new Date(now - 1000));

    const page = await listSellerSales(seller.userId, {}, prisma);
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => r.kind)).toEqual(['giveaway', 'store', 'auction']);
    const gw = page.rows[0]!;
    expect(gw.buyer).toBe(alice.handle);
    expect(gw.title).toBe('Promo pack');
    expect(gw.amount).toBe('0');
    expect(gw.status).toBe('GIVEAWAY');
  });

  it('paginates with skip/take while total counts every match', async () => {
    const seller = await makeUser('seller');
    const buyer = await makeUser('buyer');
    const now = Date.now();
    for (let i = 0; i < 7; i += 1) await order(seller.userId, buyer.userId, '5', new Date(now - i * 1000), false);

    const p1 = await listSellerSales(seller.userId, { take: 3 }, prisma);
    expect(p1.total).toBe(7);
    expect(p1.rows).toHaveLength(3);
    const p2 = await listSellerSales(seller.userId, { take: 3, skip: 3 }, prisma);
    expect(p2.rows).toHaveLength(3);
    const p3 = await listSellerSales(seller.userId, { take: 3, skip: 6 }, prisma);
    expect(p3.rows).toHaveLength(1);
    // No overlap across pages
    const ids = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(7);
  });

  it('filters by kind, buyer handle (case-insensitive) and day range', async () => {
    const seller = await makeUser('seller');
    const alice = await makeUser('buyer');
    const bob = await makeUser('buyer');
    const now = Date.now();
    await order(seller.userId, alice.userId, '20', new Date(now - 2 * DAY), true);
    await order(seller.userId, bob.userId, '10', new Date(now - 1000), false);
    await giveaway(seller.userId, bob.userId, 'Sticker pack', new Date(now - 500));

    const auctionsOnly = await listSellerSales(seller.userId, { kind: 'auction' }, prisma);
    expect(auctionsOnly.rows.map((r) => r.kind)).toEqual(['auction']);

    const gwOnly = await listSellerSales(seller.userId, { kind: 'giveaway' }, prisma);
    expect(gwOnly.total).toBe(1);
    expect(gwOnly.rows[0]!.title).toBe('Sticker pack');

    const byAlice = await listSellerSales(seller.userId, { q: alice.handle.toUpperCase() }, prisma);
    expect(byAlice.total).toBe(1);
    expect(byAlice.rows[0]!.buyer).toBe(alice.handle);

    // Today only: the 2-day-old auction drops out, order + giveaway remain.
    const today = await listSellerSales(seller.userId, { fromMs: now - DAY / 2 }, prisma);
    expect(today.total).toBe(2);
    expect(today.rows.every((r) => r.createdAt >= now - DAY / 2)).toBe(true);
  });

  it("never leaks another seller's sales", async () => {
    const seller = await makeUser('seller');
    const other = await makeUser('seller');
    const buyer = await makeUser('buyer');
    await order(other.userId, buyer.userId, '99', new Date(), false);
    await giveaway(other.userId, buyer.userId, 'Not yours', new Date());
    const page = await listSellerSales(seller.userId, {}, prisma);
    expect(page.total).toBe(0);
  });
});
