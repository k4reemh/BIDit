import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { openGiveaway, enterGiveaway, drawGiveaway, ensureGiveawayFulfillment } from '../src/giveaways.js';
import { sellerFulfilledCount } from '../src/seller-verify.js';
import { ManualClock } from '../src/clock.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeUser } from './setup.js';

const clock = () => new ManualClock(new Date('2026-08-08T12:00:00Z'));

describe('giveaway fulfillment', () => {
  beforeEach(async () => { await resetDb(); });

  it('drawing a winner creates a free Ready-to-Ship item + notifies them', async () => {
    const seller = await makeUser('seller');
    const entrant = await makeUser('buyer');
    const c = clock();
    const g = await openGiveaway(seller.userId, { kind: 'PUBLIC', prize: 'Charizard promo' }, c, prisma);
    await enterGiveaway(g.id, entrant.userId, c, prisma);
    c.advance(60_000); // window closes

    const result = await drawGiveaway(g.id, c, prisma);
    expect(result.ok).toBe(true);

    const item = await prisma.fulfillmentItem.findUnique({ where: { orderId: `gw_${g.id}` } });
    expect(item).not.toBeNull();
    expect(item!.buyerId).toBe(entrant.userId);
    expect(item!.sellerId).toBe(seller.userId);
    expect(item!.title).toBe('Charizard promo');
    expect(item!.amount).toBe(0n);
    expect(item!.status).toBe('READY_TO_SHIP');

    const note = await prisma.notification.findFirst({ where: { userId: entrant.userId, kind: 'giveaway_won' } });
    expect(note).not.toBeNull();

    // A repeat draw re-derives the same winner and must not duplicate anything.
    await drawGiveaway(g.id, c, prisma);
    expect(await prisma.fulfillmentItem.count({ where: { orderId: `gw_${g.id}` } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: entrant.userId, kind: 'giveaway_won' } })).toBe(1);
  });

  it('a giveaway with no entrants creates nothing', async () => {
    const seller = await makeUser('seller');
    const c = clock();
    const g = await openGiveaway(seller.userId, { kind: 'PUBLIC', prize: 'Nothing burger' }, c, prisma);
    c.advance(60_000);
    const result = await drawGiveaway(g.id, c, prisma);
    expect(result.ok).toBe(false);
    expect(await prisma.fulfillmentItem.count()).toBe(0);
  });

  it('backfills items for giveaways drawn before fulfillment existed', async () => {
    const seller = await makeUser('seller');
    const winner = await makeUser('buyer');
    // Simulate a pre-feature drawn giveaway: winner recorded, no fulfillment item.
    const g = await prisma.giveaway.create({
      data: { sellerId: seller.userId, kind: 'PUBLIC', prize: 'Old-stream prize', status: 'CLOSED', seed: 's', seedHash: 'h', winnerUserId: winner.userId, closesAt: new Date(), drawnAt: new Date() },
    });
    const created = await ensureGiveawayFulfillment(prisma);
    expect(created).toBe(1);
    const item = await prisma.fulfillmentItem.findUnique({ where: { orderId: `gw_${g.id}` } });
    expect(item!.buyerId).toBe(winner.userId);
    // Idempotent re-run.
    expect(await ensureGiveawayFulfillment(prisma)).toBe(0);
  });

  it('giveaway prizes never count toward the Verified badge', async () => {
    const seller = await makeUser('seller');
    const buyer = await makeUser('buyer');
    await prisma.fulfillmentItem.createMany({
      data: [
        { orderId: 'gw_x', buyerId: buyer.userId, sellerId: seller.userId, listingId: 'gw_x', title: 'Prize', amount: 0n, status: 'SHIPPED' },
        { orderId: 'o_paid', buyerId: buyer.userId, sellerId: seller.userId, listingId: 'l', title: 'Card', amount: usdc('20'), status: 'SHIPPED' },
      ],
    });
    expect(await sellerFulfilledCount(seller.userId, prisma)).toBe(1); // the paid one only
  });
});
