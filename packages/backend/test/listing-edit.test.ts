import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { createListing, updateListing } from '../src/listings.js';
import { usdc, findParcelPreset } from '@bidit/shared';
import { resetDb, makeUser } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

async function sellerWithListing() {
  const seller = await makeUser('seller');
  // isSeller() wants the application row, not just the role.
  await prisma.sellerProfile.create({ data: { userId: seller.userId, appliedAt: new Date() } });
  const listing = await createListing(
    seller.userId,
    { title: 'Charizard', startingBid: usdc('5'), quantity: 3, weightGrams: 100, parcelPreset: 'poly_6x9' },
    prisma,
  );
  return { seller, listing };
}

describe('editing a listing', () => {
  it('updates price, quantity, weight and parcel in place', async () => {
    const { seller, listing } = await sellerWithListing();
    const updated = await updateListing(
      seller.userId,
      listing.id,
      { title: 'Charizard PSA 9', startingBid: usdc('25'), quantity: 5, weightGrams: 250, parcelPreset: 'box_6x4x2' },
      prisma,
    );
    expect(updated.title).toBe('Charizard PSA 9');
    expect(updated.startingBid).toBe(usdc('25'));
    expect(updated.quantity).toBe(5);
    expect(updated.weightGrams).toBe(250);
    // Parcel dims are re-snapshotted from the preset table, same as creation.
    const box = findParcelPreset('box_6x4x2')!;
    expect(updated.parcelLengthMm).toBe(box.lengthMm);
  });

  it('only the owner can edit', async () => {
    const { listing } = await sellerWithListing();
    const stranger = await makeUser('seller');
    await prisma.sellerProfile.create({ data: { userId: stranger.userId, appliedAt: new Date() } });
    await expect(updateListing(stranger.userId, listing.id, { title: 'Mine now' }, prisma)).rejects.toThrow(/yours/);
  });

  it('refuses while the auction is live, and after selling out', async () => {
    // Changing price or quantity mid-auction would reprice the block under the
    // people already bidding on it.
    const { seller, listing } = await sellerWithListing();
    await prisma.listing.update({ where: { id: listing.id }, data: { status: 'LIVE' } });
    await expect(updateListing(seller.userId, listing.id, { startingBid: usdc('99') }, prisma)).rejects.toThrow(/live auction/);
    await prisma.listing.update({ where: { id: listing.id }, data: { status: 'SOLD' } });
    await expect(updateListing(seller.userId, listing.id, { startingBid: usdc('99') }, prisma)).rejects.toThrow(/sold out/);
  });

  it('refuses quantity edits on a randomizer, whose quantity is its prize pool', async () => {
    const { seller, listing } = await sellerWithListing();
    await prisma.listing.update({
      where: { id: listing.id },
      data: { wheel: [{ label: 'Prize A', weight: 1 }] },
    });
    await expect(updateListing(seller.userId, listing.id, { quantity: 50 }, prisma)).rejects.toThrow(/prizes/);
    // Everything else on a wheel stays editable.
    const ok = await updateListing(seller.userId, listing.id, { title: 'Mystery wheel' }, prisma);
    expect(ok.title).toBe('Mystery wheel');
  });

  it('never accepts caller dimensions for a named preset', async () => {
    const { seller, listing } = await sellerWithListing();
    const updated = await updateListing(
      seller.userId,
      listing.id,
      { parcelPreset: 'poly_6x9', parcel: { lengthMm: 2000, widthMm: 2000, heightMm: 2000 } },
      prisma,
    );
    const preset = findParcelPreset('poly_6x9')!;
    expect(updated.parcelLengthMm).toBe(preset.lengthMm); // spoofed dims ignored
  });
});
