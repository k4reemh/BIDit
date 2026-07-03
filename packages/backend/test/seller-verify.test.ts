import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { applyAsSeller, isVerifiedSeller } from '../src/authz.js';
import { maybeVerifySeller, sellerFulfilledCount, VERIFY_THRESHOLD } from '../src/seller-verify.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeUser } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

async function shipItems(sellerId: string, buyerId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await prisma.fulfillmentItem.create({
      data: {
        orderId: `o_${sellerId}_${Date.now()}_${i}_${Math.random().toString(36).slice(2)}`,
        buyerId,
        sellerId,
        listingId: 'l',
        title: 'Item',
        amount: usdc('5'),
        status: 'SHIPPED',
      },
    });
  }
}

describe('seller auto-verification', () => {
  it(`verifies a seller after ${VERIFY_THRESHOLD} fulfilled orders`, async () => {
    const seller = await makeUser('buyer');
    await applyAsSeller(seller.userId, prisma);
    const buyer = await makeUser('buyer');

    await shipItems(seller.userId, buyer.userId, VERIFY_THRESHOLD - 1);
    await maybeVerifySeller(seller.userId, prisma);
    expect(await isVerifiedSeller(seller.userId, prisma)).toBe(false); // one short
    expect(await sellerFulfilledCount(seller.userId, prisma)).toBe(VERIFY_THRESHOLD - 1);

    await shipItems(seller.userId, buyer.userId, 1); // hits the threshold
    await maybeVerifySeller(seller.userId, prisma);
    expect(await isVerifiedSeller(seller.userId, prisma)).toBe(true);
    const p = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: seller.userId } });
    expect(p.verifiedBy).toBe('auto');
    expect(p.verifiedAt).not.toBeNull();
  });

  it('does not verify a user who never applied', async () => {
    const seller = await makeUser('buyer'); // no SellerProfile
    const buyer = await makeUser('buyer');
    await shipItems(seller.userId, buyer.userId, VERIFY_THRESHOLD + 2);
    await maybeVerifySeller(seller.userId, prisma); // no profile → no-op
    expect(await isVerifiedSeller(seller.userId, prisma)).toBe(false);
  });
});
