import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { updateProfile, eraseUserData } from '../src/authz.js';
import { estimateShipment, createAndPayShipment, purgeDeliveredShipmentPii } from '../src/fulfillment.js';
import { decryptPii } from '../src/pii.js';
import { usdc } from '@bidit/shared';
import { resetDb, makeUser, makeFundedUser } from './setup.js';

const KEY = 'a-strong-pii-key-for-tests-1234567890';
const ADDR = { name: 'Kareem', line1: '1 Yonge', city: 'Toronto', region: 'ON', postal: 'M5V 1J1', country: 'Canada' };

beforeEach(async () => {
  await resetDb();
  process.env.BIDIT_PII_KEY = KEY;
});
afterEach(() => {
  delete process.env.BIDIT_PII_KEY;
});

describe('PII encryption across the shipping flow', () => {
  it('stores the address encrypted, still quotes + ships correctly, and stores shipTo encrypted', async () => {
    const seller = await makeUser('seller');
    await prisma.sellerProfile.create({
      data: { userId: seller.userId, originCountry: 'Canada', originRegion: 'AB', originCity: 'Calgary', originPostal: 'T2P 1J9' },
    });
    const buyer = await makeFundedUser('100');

    // Write the address through the real profile path — it must be encrypted at rest.
    await updateProfile(buyer.userId, { shippingAddress: ADDR }, prisma);
    const urow = await prisma.user.findUniqueOrThrow({ where: { id: buyer.userId } });
    expect(typeof urow.shippingAddress).toBe('string');
    expect(String(urow.shippingAddress)).toMatch(/^encv1:/); // ciphertext, not plaintext
    expect(String(urow.shippingAddress)).not.toContain('Yonge');
    expect(decryptPii(urow.shippingAddress)).toMatchObject({ city: 'Toronto' });

    const item = await prisma.fulfillmentItem.create({
      data: { orderId: 'o1', buyerId: buyer.userId, sellerId: seller.userId, listingId: 'l', title: 'Card', weightGrams: 57, amount: usdc('20'), status: 'READY_TO_SHIP', heldUntil: new Date(Date.now() + 1e9) },
    });

    // Estimate must decrypt the address (real quote, not the no-address fallback).
    const est = await estimateShipment({ buyerId: buyer.userId, itemIds: [item.id] }, prisma);
    expect(est.hasAddress).toBe(true);
    expect(est.shippingFee).toBeGreaterThan(0n);

    // Ship it: the shipment's stored address snapshot must also be encrypted.
    const shipment = await createAndPayShipment({ buyerId: buyer.userId, itemIds: [item.id] }, new ManualClock(Date.now()), prisma);
    const srow = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(typeof srow.shipTo).toBe('string');
    expect(String(srow.shipTo)).toMatch(/^encv1:/); // encrypted at rest
    expect(decryptPii(srow.shipTo)).toMatchObject({ city: 'Toronto' }); // decrypts back
  });

  it('eraseUserData wipes the saved address and identity', async () => {
    const buyer = await makeUser();
    await updateProfile(buyer.userId, { shippingAddress: ADDR }, prisma);

    await eraseUserData(buyer.userId, prisma);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: buyer.userId } });
    expect(row.shippingAddress).toBeNull();
    expect(row.email).toBeNull();
    expect(row.passwordHash).toBeNull();
    expect(row.handle).toMatch(/^deleted_/);
  });

  /** A buyer with an address + a shipment for one of their items. */
  async function shipmentFor(deliveredAt: Date | null) {
    const seller = await makeUser('seller');
    await prisma.sellerProfile.create({
      data: { userId: seller.userId, originCountry: 'Canada', originRegion: 'AB', originCity: 'Calgary', originPostal: 'T2P 1J9' },
    });
    const buyer = await makeFundedUser('100');
    await updateProfile(buyer.userId, { shippingAddress: ADDR }, prisma);
    const item = await prisma.fulfillmentItem.create({
      data: { orderId: `o_${buyer.userId}`, buyerId: buyer.userId, sellerId: seller.userId, listingId: 'l', title: 'Card', weightGrams: 57, amount: usdc('20'), status: 'READY_TO_SHIP', heldUntil: new Date(Date.now() + 1e9) },
    });
    const shipment = await createAndPayShipment({ buyerId: buyer.userId, itemIds: [item.id] }, new ManualClock(Date.now()), prisma);
    if (deliveredAt) await prisma.shipment.update({ where: { id: shipment.id }, data: { status: 'DELIVERED', deliveredAt } });
    return { buyer, shipment };
  }

  it('eraseUserData wipes the address snapshot on a delivered shipment (M5)', async () => {
    const { buyer, shipment } = await shipmentFor(new Date());
    await eraseUserData(buyer.userId, prisma);
    const srow = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(srow.shipTo).toBeNull(); // buyer's address snapshot is gone
  });

  it('purgeDeliveredShipmentPii clears delivered addresses past retention, keeps recent ones (M5)', async () => {
    const old = await shipmentFor(new Date(Date.now() - 100 * 86_400_000)); // delivered 100d ago
    const recent = await shipmentFor(new Date(Date.now() - 10 * 86_400_000)); // delivered 10d ago

    const n = await purgeDeliveredShipmentPii(90, new ManualClock(Date.now()), prisma);
    expect(n).toBe(1); // only the 100-day-old one

    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: old.shipment.id } })).shipTo).toBeNull();
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: recent.shipment.id } })).shipTo).not.toBeNull();
  });
});
