import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../src/db.js';
import { applyAsSeller } from '../src/authz.js';
import { sellerPromoStatus, promoState, listPromoSellers, markPromoPaid, PROMO_WINDOW_MS } from '../src/promo.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeUser } from './setup.js';

const ORIGINAL = process.env.BIDIT_PROMO_START;
const ORIGINAL_END = process.env.BIDIT_PROMO_END;
beforeEach(async () => {
  await resetDb();
  delete process.env.BIDIT_PROMO_END;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.BIDIT_PROMO_START;
  else process.env.BIDIT_PROMO_START = ORIGINAL;
  if (ORIGINAL_END === undefined) delete process.env.BIDIT_PROMO_END;
  else process.env.BIDIT_PROMO_END = ORIGINAL_END;
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

  it('does NOT enroll a seller who joined after the enrollment window', async () => {
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

  it('BIDIT_PROMO_END re-opens the window without un-enrolling earlier sellers', async () => {
    // Start was 2 default-windows ago (offer lapsed), then extended 3 days out.
    process.env.BIDIT_PROMO_START = String(Date.now() - 2 * PROMO_WINDOW_MS);
    const early = await makeUser('buyer'); // joined while the offer was lapsed
    await applyAsSeller(early.userId, prisma);
    expect(promoState().active).toBe(false);
    expect((await sellerPromoStatus(early.userId, prisma)).enrolled).toBe(false);

    process.env.BIDIT_PROMO_END = String(Date.now() + 3 * PROMO_WINDOW_MS);
    expect(promoState().active).toBe(true);
    expect(promoState().enrollEndsMs).toBe(Number(process.env.BIDIT_PROMO_END));
    // The earlier seller is inside the widened window now, and a new one enrolls too.
    expect((await sellerPromoStatus(early.userId, prisma)).enrolled).toBe(true);
    const late = await makeUser('buyer');
    await applyAsSeller(late.userId, prisma);
    expect((await sellerPromoStatus(late.userId, prisma)).enrolled).toBe(true);
    expect((await listPromoSellers(prisma)).sellers).toHaveLength(2);
  });

  it('ignores a BIDIT_PROMO_END that is unparseable or before the start', async () => {
    process.env.BIDIT_PROMO_START = String(Date.now() - 1000);
    process.env.BIDIT_PROMO_END = 'not-a-date';
    expect(promoState().active).toBe(true); // falls back to the default window
    expect(promoState().enrollEndsMs).toBe(Number(process.env.BIDIT_PROMO_START) + PROMO_WINDOW_MS);
    process.env.BIDIT_PROMO_END = String(Date.now() - 5000); // before start
    expect(promoState().enrollEndsMs).toBe(Number(process.env.BIDIT_PROMO_START) + PROMO_WINDOW_MS);
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
