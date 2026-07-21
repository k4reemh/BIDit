import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { resolveRoomByCoin, linkCoinToSeller, seedRunningAuction, setSellerCoin, reassignCoin, SellerError } from '../src/sellers.js';
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

  it('self-serve coin claim is FIRST-claim-wins — a second seller cannot hijack it', async () => {
    // The hijack this blocks: whoever streams on SHARED_COIN owns the room buyers
    // route to, so silently repointing it steals their USDC. First-claim-wins means
    // only an admin can move a coin once a seller holds it.
    const a = await makeUser('seller');
    const b = await makeUser('seller');
    await setSellerCoin(a.userId, 'SHARED_COIN', prisma); // a claims first
    await setSellerCoin(b.userId, '', prisma); // b is a seller but has no coin yet

    // b tries to take a's coin → rejected; a keeps it.
    await expect(setSellerCoin(b.userId, 'SHARED_COIN', prisma)).rejects.toThrow(SellerError);
    expect((await resolveRoomByCoin('SHARED_COIN', prisma))?.room).toBe(a.userId);
    expect(await prisma.sellerProfile.count({ where: { pumpCoinAddress: 'SHARED_COIN' } })).toBe(1);
  });

  it('re-affirming your OWN coin is fine, and you can clear it', async () => {
    const a = await makeUser('seller');
    await setSellerCoin(a.userId, 'MY_COIN', prisma);
    await setSellerCoin(a.userId, 'MY_COIN', prisma); // idempotent, no throw
    expect((await resolveRoomByCoin('MY_COIN', prisma))?.room).toBe(a.userId);
    await setSellerCoin(a.userId, '', prisma); // clear
    expect(await resolveRoomByCoin('MY_COIN', prisma)).toBeNull();
  });

  it('admin reassign is the only way a claimed coin moves', async () => {
    const a = await makeUser('seller');
    const b = await makeUser('seller');
    await setSellerCoin(a.userId, 'SHARED_COIN', prisma);
    await setSellerCoin(b.userId, '', prisma); // b needs a SellerProfile for requireSeller

    await reassignCoin(b.userId, 'SHARED_COIN', prisma); // admin force-move
    expect((await resolveRoomByCoin('SHARED_COIN', prisma))?.room).toBe(b.userId);
    expect((await prisma.sellerProfile.findUnique({ where: { userId: a.userId } }))?.pumpCoinAddress).toBeNull();
    expect(await prisma.sellerProfile.count({ where: { pumpCoinAddress: 'SHARED_COIN' } })).toBe(1);
  });

  it('reassign requires the target to be a seller', async () => {
    const notSeller = await makeUser('buyer');
    await expect(reassignCoin(notSeller.userId, 'ANY_COIN', prisma)).rejects.toThrow();
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
