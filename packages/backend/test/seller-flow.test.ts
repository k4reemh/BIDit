import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { Role, usdc, AuctionStatus, ListingStatus } from '@bidit/shared';
import { createListing, setListingWheel } from '../src/listings.js';
import { startAuctionFromListing } from '../src/sellers.js';
import { verifySeller, listSellers, ledgerAudit } from '../src/admin.js';
import {
  requireAdmin,
  requireVerifiedSeller,
  findOrCreateByWallet,
  findOrCreateByHandle,
  ForbiddenError,
} from '../src/authz.js';
import { placeBid } from '../src/auction.js';
import { getOrCreateUserAccount } from '../src/ledger.js';
import { ManualClock } from '../src/clock.js';
import { resetDb, makeUser, makeFundedUser } from './setup.js';

async function makeAdmin(): Promise<string> {
  const user = await prisma.user.create({ data: { handle: `admin_${Date.now()}`, role: Role.admin } });
  await getOrCreateUserAccount(user.id, prisma);
  return user.id;
}

beforeEach(async () => {
  await resetDb();
});

describe('seller verification gate', () => {
  it('blocks unverified sellers from creating listings', async () => {
    const seller = await makeUser('seller');
    await expect(
      createListing(seller.userId, { title: 'Card', startingBid: usdc('5') }, prisma),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('admin verifies a seller, who can then list and run auctions', async () => {
    const adminId = await makeAdmin();
    const seller = await makeUser('buyer'); // starts as a plain buyer
    await verifySeller(adminId, seller.userId, prisma);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: seller.userId } });
    expect(updated.role).toBe(Role.seller);
    await requireVerifiedSeller(seller.userId, prisma); // no throw

    const listing = await createListing(
      seller.userId,
      { title: 'Charizard', startingBid: usdc('5'), photos: ['x.png'] },
      prisma,
    );
    expect(listing.status).toBe(ListingStatus.QUEUED);

    const clock = new ManualClock(Date.now());
    const { auctionId, room } = await startAuctionFromListing(listing.id, { durationSeconds: 30 }, clock, prisma);
    expect(room).toBe(seller.userId);
    expect((await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } })).status).toBe(
      AuctionStatus.RUNNING,
    );

    const buyer = await makeFundedUser('100');
    const r = await placeBid({ auctionId, userId: buyer.userId, amount: usdc('5') }, clock, prisma);
    expect(r.ok).toBe(true);

    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe(
      ListingStatus.LIVE,
    );
  });

  it("can't start an auction on a non-queued listing", async () => {
    const adminId = await makeAdmin();
    const seller = await makeUser('seller');
    await verifySeller(adminId, seller.userId, prisma);
    const listing = await createListing(seller.userId, { title: 'Card', startingBid: usdc('5') }, prisma);
    const clock = new ManualClock(Date.now());
    await startAuctionFromListing(listing.id, {}, clock, prisma); // QUEUED -> LIVE
    await expect(startAuctionFromListing(listing.id, {}, clock, prisma)).rejects.toThrow();
  });
});

describe('admin gates & audit', () => {
  it('non-admins cannot use admin tools', async () => {
    const buyer = await makeUser('buyer');
    await expect(requireAdmin(buyer.userId, prisma)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listSellers(buyer.userId, prisma)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(verifySeller(buyer.userId, buyer.userId, prisma)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('audit lists balances and the conservation total stays zero', async () => {
    const adminId = await makeAdmin();
    await makeFundedUser('100');
    const audit = await ledgerAudit(adminId, prisma);
    expect(audit.systemTotal).toBe('0');
    expect(audit.accounts.some((a) => a.kind === 'ESCROW')).toBe(true);
    expect(audit.accounts.some((a) => a.kind === 'PLATFORM')).toBe(true);
  });
});

describe('account resolution', () => {
  it('creates users (with accounts) by wallet and by handle, idempotently', async () => {
    const wallet = 'SoLWa11etAddrExample1111111111111111111111';
    const byWallet = await findOrCreateByWallet(wallet, prisma);
    expect(byWallet.walletAddress).toBe(wallet);
    expect(await prisma.account.findUnique({ where: { userId: byWallet.id } })).not.toBeNull();
    expect((await findOrCreateByWallet(wallet, prisma)).id).toBe(byWallet.id);

    const byHandle = await findOrCreateByHandle('v1_seller', prisma);
    expect(byHandle.handle).toBe('v1_seller');
  });
});

describe('wheel setup (setListingWheel)', () => {
  async function verifiedSeller(): Promise<string> {
    const adminId = await makeAdmin();
    const seller = await makeUser('buyer');
    await verifySeller(adminId, seller.userId, prisma);
    return seller.userId;
  }

  it('a verified seller attaches a normalized wheel, then clears it', async () => {
    const sellerId = await verifiedSeller();
    const listing = await createListing(sellerId, { title: 'Roll', startingBid: usdc('5') }, prisma);

    const entries = await setListingWheel(
      sellerId,
      listing.id,
      [
        { label: '  Charizard ex  ', tier: 'Chase', weight: 2 },
        { label: 'Booster Pack' },
        { label: '' }, // dropped
      ],
      prisma,
    );
    expect(entries).toEqual([{ label: 'Charizard ex', tier: 'Chase', weight: 2 }, { label: 'Booster Pack' }]);
    const saved = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(saved.wheel).toEqual(entries);

    await setListingWheel(sellerId, listing.id, [], prisma);
    const cleared = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(cleared.wheel).toBeNull();
  });

  it("refuses to touch another seller's listing", async () => {
    const owner = await verifiedSeller();
    const intruder = await verifiedSeller();
    const listing = await createListing(owner, { title: 'X', startingBid: usdc('5') }, prisma);
    await expect(setListingWheel(intruder, listing.id, [{ label: 'A' }], prisma)).rejects.toThrow(/not your listing/);
  });

  it('blocks unverified sellers', async () => {
    const seller = await makeUser('seller');
    const listing = await prisma.listing.create({
      data: { sellerId: seller.userId, title: 'X', photos: [], startingBid: usdc('5'), status: ListingStatus.QUEUED },
    });
    await expect(setListingWheel(seller.userId, listing.id, [{ label: 'A' }], prisma)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('locks the wheel once the auction starts (must be set up beforehand)', async () => {
    const sellerId = await verifiedSeller();
    const listing = await createListing(sellerId, { title: 'X', startingBid: usdc('5') }, prisma);
    await setListingWheel(sellerId, listing.id, [{ label: 'A' }], prisma); // fine while QUEUED
    const clock = new ManualClock(Date.now());
    await startAuctionFromListing(listing.id, { durationSeconds: 30 }, clock, prisma); // listing -> LIVE
    await expect(setListingWheel(sellerId, listing.id, [{ label: 'B' }], prisma)).rejects.toThrow(/QUEUED/);
  });
});
