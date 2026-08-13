import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { ManualClock } from '../src/clock.js';
import { getChainClient } from '../src/chain/index.js';
import { MockNftChain } from '../src/chain/nft-chain.js';
import { DevWalletEscrow } from '../src/escrow.js';
import { closeDueAuctions } from '../src/auction.js';
import { settleAuction } from '../src/orders.js';
import { placeMarketBid } from '../src/market.js';
import {
  armNftDeposit,
  creditNftDeposits,
  listMyNfts,
  withdrawNft,
  processNftWithdrawals,
  createNftListing,
  unlistNftListing,
  NftError,
} from '../src/nft.js';
import { getSettledBalance } from '../src/ledger.js';
import { usdc, AuctionStatus, OrderStatus } from '@bidit/shared';
import { applyAsSeller } from '../src/authz.js';
import { resetDb, makeFundedUser, makeUser } from './setup.js';

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const escrow = new DevWalletEscrow(prisma);
const DEST = 'JCFRaPv7852ESRwJJGRy2mysUMydXpyTNWjWv5CFxEfs';

beforeEach(async () => { await resetDb(); });

async function chainPair() {
  const chain = await getChainClient();
  const nft = new MockNftChain();
  return { chain, nft };
}

/** Deposit `n` mock NFTs for a fresh seller; returns seller + asset ids. */
async function custodied(n = 1, clock = new ManualClock(T0)) {
  const { chain, nft } = await chainPair();
  const u = await makeUser('buyer');
  await applyAsSeller(u.userId, prisma);
  const { depositAddress } = await armNftDeposit(u.userId, chain, clock, prisma);
  for (let i = 0; i < n; i += 1) {
    nft.seedNft(depositAddress, `Mint${i}_${u.userId.slice(-5)}`, { name: `Ape #${i + 1}`, image: `https://img/${i}`, collection: 'Apes' });
  }
  await creditNftDeposits(chain, nft, clock, prisma);
  const assets = await prisma.nftAsset.findMany({ where: { ownerId: u.userId }, orderBy: { mint: 'asc' } });
  return { user: u, assets, chain, nft, clock };
}

describe('NFT custody', () => {
  it('credits an armed deposit once, with metadata, and dedups on later ticks', async () => {
    const { user, assets, chain, nft, clock } = await custodied(1);
    expect(assets).toHaveLength(1);
    expect(assets[0]!.name).toBe('Ape #1');
    expect(assets[0]!.collection).toBe('Apes');
    expect(assets[0]!.custodyUserId).toBe(user.userId);
    // Second tick: same mint still at the address, no duplicate row.
    await creditNftDeposits(chain, nft, clock, prisma);
    expect(await prisma.nftAsset.count()).toBe(1);
  });

  it('ignores users who are not armed', async () => {
    const { chain, nft } = await chainPair();
    const u = await makeUser('buyer');
    nft.seedNft(await chain.depositAddress(u.userId), 'MintUnarmed', {});
    await creditNftDeposits(chain, nft, new ManualClock(T0), prisma);
    expect(await prisma.nftAsset.count()).toBe(0);
  });

  it('withdraws: worker sends from the custody wallet, then a re-deposit reactivates', async () => {
    const { user, assets, chain, nft, clock } = await custodied(1);
    const a = assets[0]!;
    await withdrawNft(user.userId, a.id, DEST, nft, prisma);
    expect((await prisma.nftAsset.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('WITHDRAWING');
    await processNftWithdrawals(nft, prisma);
    const after = await prisma.nftAsset.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.status).toBe('WITHDRAWN');
    expect(after.withdrawTxSig).toMatch(/^nftsend_/);
    expect(nft.sent[0]).toMatchObject({ custodyUserId: user.userId, mint: a.mint, to: DEST });

    // They send it back: same mint row reactivates under the depositor.
    const { depositAddress } = await armNftDeposit(user.userId, chain, clock, prisma);
    nft.seedNft(depositAddress, a.mint);
    await creditNftDeposits(chain, nft, clock, prisma);
    expect((await prisma.nftAsset.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('HELD');
  });

  it('withdraw guards: wrong owner, bad address, transient send failure retries', async () => {
    const { user, assets, nft } = await custodied(1);
    const stranger = await makeUser('buyer');
    await expect(withdrawNft(stranger.userId, assets[0]!.id, DEST, nft, prisma)).rejects.toBeInstanceOf(NftError);
    await expect(withdrawNft(user.userId, assets[0]!.id, 'not-an-address', nft, prisma)).rejects.toBeInstanceOf(NftError);
    await withdrawNft(user.userId, assets[0]!.id, DEST, nft, prisma);
    nft.failNextSend = true;
    await processNftWithdrawals(nft, prisma);
    expect((await prisma.nftAsset.findUniqueOrThrow({ where: { id: assets[0]!.id } })).status).toBe('WITHDRAWING');
    await processNftWithdrawals(nft, prisma); // retry succeeds
    expect((await prisma.nftAsset.findUniqueOrThrow({ where: { id: assets[0]!.id } })).status).toBe('WITHDRAWN');
  });
});

describe('NFT auctions', () => {
  it('stream listing: queued, titled/photographed from the batch, assets locked', async () => {
    const { user, assets, clock } = await custodied(3);
    const created = await createNftListing(
      user.userId,
      { assetIds: assets.map((a) => a.id), startingBid: usdc('10'), mode: 'stream' },
      clock,
      prisma,
    );
    expect(created.auctionId).toBeNull();
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: created.listingId } });
    expect(listing.nft).toBe(true);
    expect(listing.status).toBe('QUEUED');
    expect(listing.title).toBe('Ape #1 + 2 more');
    expect(listing.photos).toHaveLength(3);
    const mine = await listMyNfts(user.userId, prisma);
    expect(mine.every((m) => m.locked)).toBe(true);
    // Locked assets can't be withdrawn or double-listed.
    await expect(withdrawNft(user.userId, assets[0]!.id, DEST, new MockNftChain(), prisma)).rejects.toThrow(/already on an auction/);
    await expect(
      createNftListing(user.userId, { assetIds: [assets[0]!.id], startingBid: usdc('5'), mode: 'stream' }, clock, prisma),
    ).rejects.toThrow(/already on an auction/);
    // Unlist frees them.
    await unlistNftListing(user.userId, created.listingId, prisma);
    expect((await listMyNfts(user.userId, prisma)).every((m) => !m.locked)).toBe(true);
  });

  it('marketplace NFT auction: bids need no address, win credits assets + pays seller 95% instantly', async () => {
    const { user: seller, assets, clock } = await custodied(2);
    const created = await createNftListing(
      seller.userId,
      { assetIds: assets.map((a) => a.id), startingBid: usdc('50'), mode: 'market', durationHours: 24 },
      clock,
      prisma,
    );
    expect(created.auctionId).not.toBeNull();

    const buyer = await makeFundedUser('200'); // deliberately NO shipping address
    const r = await placeMarketBid(buyer.userId, created.auctionId!, usdc('100'), clock, prisma);
    expect(r.ok).toBe(true);

    clock.advance(24 * 3600 * 1000 + 3 * 60 * 1000);
    const closed = await closeDueAuctions(clock, prisma);
    expect(closed[0]?.status).toBe(AuctionStatus.SETTLING);
    const order = await settleAuction(created.auctionId!, escrow, clock, prisma);

    // Instant payout: order RELEASED at settle, seller nets 95% immediately.
    expect(order!.status).toBe(OrderStatus.RELEASED);
    const sellerAcct = await prisma.account.findUniqueOrThrow({ where: { userId: seller.userId } });
    expect(await getSettledBalance(sellerAcct.id, prisma)).toBe(usdc('95'));
    expect(await getSettledBalance(buyer.accountId, prisma)).toBe(usdc('100'));

    // Both NFTs now belong to the winner, unlocked, withdrawable.
    const won = await prisma.nftAsset.findMany({ where: { ownerId: buyer.userId } });
    expect(won).toHaveLength(2);
    expect(won.every((w) => w.listingId === null && w.status === 'HELD')).toBe(true);
    // Custody wallet unchanged: the token still sits in the depositor's wallet.
    expect(won.every((w) => w.custodyUserId === seller.userId)).toBe(true);

    // Digital delivery: no shipment, no fulfillment item was created.
    expect(await prisma.fulfillmentItem.count()).toBe(0);
    expect(await prisma.shipment.count()).toBe(0);

    // The winner can withdraw straight to their wallet.
    const nft2 = new MockNftChain();
    await withdrawNft(buyer.userId, won[0]!.id, DEST, nft2, prisma);
    await processNftWithdrawals(nft2, prisma);
    expect(nft2.sent[0]).toMatchObject({ custodyUserId: seller.userId, to: DEST });
  });

  it('unsold marketplace NFT auction frees the assets after unlist', async () => {
    const { user: seller, assets, clock } = await custodied(1);
    const created = await createNftListing(
      seller.userId,
      { assetIds: [assets[0]!.id], startingBid: usdc('50'), mode: 'market', durationHours: 24 },
      clock,
      prisma,
    );
    // Running: cannot unlist yet.
    await expect(unlistNftListing(seller.userId, created.listingId, prisma)).rejects.toThrow(/running/);
    clock.advance(24 * 3600 * 1000 + 1000);
    const closed = await closeDueAuctions(clock, prisma);
    expect(closed[0]?.winnerUserId).toBeNull();
    // Closed with no winner: listing re-queued; seller unlists to free the NFT.
    await unlistNftListing(seller.userId, created.listingId, prisma);
    const mine = await listMyNfts(seller.userId, prisma);
    expect(mine[0]!.locked).toBe(false);
  });
});
