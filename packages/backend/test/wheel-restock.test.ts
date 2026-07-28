import { describe, it, expect, beforeEach } from 'vitest';
import { usdc, ListingStatus, normalizeWheelEntries, buildReel } from '@bidit/shared';
import { prisma } from '../src/db.js';
import { createListing, setListingWheel } from '../src/listings.js';
import { registerWithEmail } from '../src/authz.js';
import { resetDb } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

async function seller() {
  const user = await registerWithEmail({ email: `s${Date.now()}@example.com`, password: 'hunter2pw' });
  await prisma.sellerProfile.create({ data: { userId: user.id, verified: true } });
  await prisma.user.update({ where: { id: user.id }, data: { role: 'seller' } });
  return user.id;
}

describe('a wheel can be auctioned once per prize copy', () => {
  it('sets the listing stock to the total number of prize copies', async () => {
    const sellerId = await seller();
    const listing = await createListing(sellerId, { title: 'Mystery wheel', startingBid: usdc('1') });
    // 2 + 3 + 1 copies = 6 rolls available.
    await setListingWheel(sellerId, listing.id, [
      { label: 'ETB', weight: 2 },
      { label: 'Pack', weight: 3 },
      { label: 'Slab', weight: 1 },
    ]);
    const row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(row.quantity).toBe(6);
    expect(row.status).toBe(ListingStatus.QUEUED);
  });

  it('a single-copy wheel is still worth exactly one auction', async () => {
    const sellerId = await seller();
    const listing = await createListing(sellerId, { title: 'One of each', startingBid: usdc('1') });
    await setListingWheel(sellerId, listing.id, [{ label: 'A' }, { label: 'B' }]);
    const row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(row.quantity).toBe(2); // weight defaults to 1 per entry
  });

  it('clearing the wheel leaves the listing quantity alone', async () => {
    const sellerId = await seller();
    const listing = await createListing(sellerId, { title: 'Wheel', startingBid: usdc('1'), quantity: 4 });
    await setListingWheel(sellerId, listing.id, []);
    const row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(row.quantity).toBe(4);
    expect(row.wheel).toBeNull();
  });
});

describe('prize art survives storage', () => {
  it('keeps a full data URL instead of truncating it to a broken image', () => {
    // ~9KB, the shape the seller UI produces. The old 2000-char cap shredded it.
    const dataUrl = `data:image/jpeg;base64,${'A'.repeat(9000)}`;
    const [entry] = normalizeWheelEntries([{ label: 'Chase', imageUrl: dataUrl }]);
    expect(entry!.imageUrl).toBe(dataUrl);
  });

  it('still bounds an absurd image so one prize cannot bloat every broadcast', () => {
    const huge = `data:image/jpeg;base64,${'A'.repeat(200_000)}`;
    const [entry] = normalizeWheelEntries([{ label: 'Chase', imageUrl: huge }]);
    expect(entry!.imageUrl!.length).toBeLessThan(huge.length);
  });

  it('does not repeat prize art in every reel slot', () => {
    const dataUrl = `data:image/jpeg;base64,${'A'.repeat(4000)}`;
    const entries = normalizeWheelEntries([
      { label: 'A', imageUrl: dataUrl },
      { label: 'B', imageUrl: dataUrl },
    ]);
    const { reel } = buildReel(entries, 0);
    // The strip is long; art is carried once on `entries` and resolved by index.
    expect(reel.length).toBeGreaterThan(8);
    expect(reel.every((s) => s.imageUrl === undefined)).toBe(true);
    expect(entries.every((e) => e.imageUrl === dataUrl)).toBe(true);
  });
});
