import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { resolveRoomByCoin, linkCoinToSeller, seedRunningAuction, setSellerCoin } from '../src/sellers.js';
import { makeUser } from './setup.js';
import { AuctionStatus } from '@bidit/shared';
import { resetDb } from './setup.js';

beforeEach(async () => {
  await resetDb();
});

describe('coin <-> seller resolution', () => {
  it('returns null for an unlinked coin', async () => {
    expect(await resolveRoomByCoin('COIN_unlinked', prisma)).toBeNull();
  });

  it('links a coin to a seller and resolves it back to their room', async () => {
    const linked = await linkCoinToSeller('COIN_abc', 'seller_jane', prisma);
    const resolved = await resolveRoomByCoin('COIN_abc', prisma);
    expect(resolved).toEqual({ room: linked.room, sellerHandle: 'seller_jane' });
  });

  it('relinking moves the coin and keeps a single profile', async () => {
    const a = await linkCoinToSeller('COIN_1', 'seller_jane', prisma);
    const b = await linkCoinToSeller('COIN_2', 'seller_jane', prisma);
    expect(a.room).toBe(b.room);
    expect(await resolveRoomByCoin('COIN_1', prisma)).toBeNull();
    expect((await resolveRoomByCoin('COIN_2', prisma))?.room).toBe(b.room);
    expect(await prisma.sellerProfile.count({ where: { userId: b.room } })).toBe(1);
  });

  it('a coin belongs to exactly one seller — the latest claimant wins', async () => {
    // Two sellers link the SAME coin (e.g. repeat test signups). Without the
    // exclusive claim, resolve could return the stale first seller and a buyer
    // would never see the active seller's auctions.
    const a = await makeUser('seller');
    const b = await makeUser('seller');
    await setSellerCoin(a.userId, 'SHARED_COIN', prisma);
    await setSellerCoin(b.userId, 'SHARED_COIN', prisma); // b claims it last

    expect((await resolveRoomByCoin('SHARED_COIN', prisma))?.room).toBe(b.userId);
    // a no longer holds the coin
    const aProfile = await prisma.sellerProfile.findUnique({ where: { userId: a.userId } });
    expect(aProfile?.pumpCoinAddress).toBeNull();
    // exactly one profile points at the coin
    expect(await prisma.sellerProfile.count({ where: { pumpCoinAddress: 'SHARED_COIN' } })).toBe(1);
  });

  it('resolve ignores blank/whitespace coins and trims lookups', async () => {
    const s = await makeUser('seller');
    await setSellerCoin(s.userId, 'TRIMCOIN', prisma);
    expect(await resolveRoomByCoin('', prisma)).toBeNull();
    expect(await resolveRoomByCoin('   ', prisma)).toBeNull();
    expect((await resolveRoomByCoin('  TRIMCOIN  ', prisma))?.room).toBe(s.userId);
  });

  it('seeds a running auction and reuses it on a second call', async () => {
    const { room } = await linkCoinToSeller('COIN_seed', 'seller_seed', prisma);
    const id1 = await seedRunningAuction(room, {}, undefined, prisma);
    const id2 = await seedRunningAuction(room, {}, undefined, prisma);
    expect(id1).toBe(id2);
    const auction = await prisma.auction.findUnique({ where: { id: id1 } });
    expect(auction?.status).toBe(AuctionStatus.RUNNING);
  });
});
