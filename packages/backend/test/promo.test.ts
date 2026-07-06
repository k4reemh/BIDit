import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../src/db.js';
import { applyAsSeller } from '../src/authz.js';
import { sellerPromoStatus, promoState, listPromoSellers, markPromoPaid, PROMO_WINDOW_MS } from '../src/promo.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeUser } from './setup.js';

const ORIGINAL = process.env.BIDIT_PROMO_START;
beforeEach(async () => { await resetDb(); });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.BIDIT_PROMO_START;
  else process.env.BIDIT_PROMO_START = ORIGINAL;
});

async function ship(sellerId: string, buyerId: string, amount: string, status: 'SHIPPED' | 'DELIVERED' = 'SHIPPED') {
  await prisma.fulfillmentItem.create({
    data: {
      orderId: `o_${Math.random().toString(36).slice(2)}`,
      buyerId,
      sellerId,
      listingId: 'l',
      title: 'Item',
      amount: usdc(amount),
      status,
    },
  });
}

describe('launch $100 seller promo', () => {
  it('enrolls a seller who joined inside the window and sums fulfilled value', async () => {
    process.env.BIDIT_PROMO_START = String(Date.now() - 1000); // window open now
    const seller = await makeUser('buyer');
    await applyAsSeller(seller.userId, prisma);
    const buyer = await makeUser('buyer');
    await ship(seller.userId, buyer.userId, '40');
    await ship(seller.userId, buyer.userId, '25', 'DELIVERED');

    const s = await sellerPromoStatus(seller.userId, prisma);
    expect(s.enrolled).toBe(true);
    expect(s.fulfilledUsd).toBe('65');
    expect(s.earned).toBe(false);
  });

  it('marks earned once the seller fulfils $100', async () => {
    process.env.BIDIT_PROMO_START = String(Date.now() - 1000);
    const seller = await makeUser('buyer');
    await applyAsSeller(seller.userId, prisma);
    const buyer = await makeUser('buyer');
    await ship(seller.userId, buyer.userId, '60');
    await ship(seller.userId, buyer.userId, '45');

    const s = await sellerPromoStatus(seller.userId, prisma);
    expect(s.earned).toBe(true);
    expect(s.fulfilledUsd).toBe('105');
  });

  it('does NOT enroll a seller who joined after the 3-day window', async () => {
    process.env.BIDIT_PROMO_START = String(Date.now() - PROMO_WINDOW_MS - 60_000); // window closed
    const seller = await makeUser('buyer');
    await applyAsSeller(seller.userId, prisma);
    const buyer = await makeUser('buyer');
    await ship(seller.userId, buyer.userId, '200');

    const s = await sellerPromoStatus(seller.userId, prisma);
    expect(s.enrolled).toBe(false);
    expect(s.earned).toBe(false);
    expect(s.fulfilledUsd).toBe('0'); // value isn't counted for non-enrolled sellers
  });

  it('is inactive when BIDIT_PROMO_START is unset', async () => {
    delete process.env.BIDIT_PROMO_START;
    expect(promoState().active).toBe(false);
    const seller = await makeUser('buyer');
    await applyAsSeller(seller.userId, prisma);
    const s = await sellerPromoStatus(seller.userId, prisma);
    expect(s.promoActive).toBe(false);
    expect(s.enrolled).toBe(false);
  });

  it('admin list shows enrolled sellers, eligibility, and records manual payout', async () => {
    process.env.BIDIT_PROMO_START = String(Date.now() - 1000);
    const seller = await makeUser('buyer');
    await applyAsSeller(seller.userId, prisma);
    const buyer = await makeUser('buyer');
    await ship(seller.userId, buyer.userId, '120');

    let list = await listPromoSellers(prisma);
    expect(list.configured).toBe(true);
    expect(list.sellers).toHaveLength(1);
    expect(list.sellers[0]!.earned).toBe(true);
    expect(list.sellers[0]!.paidAt).toBeNull();

    await markPromoPaid(seller.userId, prisma);
    list = await listPromoSellers(prisma);
    expect(list.sellers[0]!.paidAt).not.toBeNull();
  });
});
