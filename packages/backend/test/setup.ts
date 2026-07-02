import { prisma } from '../src/db.js';
import { ensureSystemAccounts } from '../src/bootstrap.js';
import { deposit, getOrCreateUserAccount } from '../src/ledger.js';
import { createAuction, startAuction } from '../src/auction.js';
import type { ManualClock } from '../src/clock.js';
import { usdc } from '@bidit/shared';

let counter = 0;

/** Wipe every table and re-seed the system accounts. */
export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "GiveawayEntry","Giveaway","Buyback","Withdrawal","Hold","LedgerEntry","Bid","Order","Auction","Listing","SellerProfile","Account","User" RESTART IDENTITY CASCADE',
  );
  await ensureSystemAccounts(prisma);
}

/** Create a user plus their USER account; returns both ids. */
export async function makeUser(
  role: 'buyer' | 'seller' | 'admin' = 'buyer',
): Promise<{ userId: string; accountId: string; handle: string }> {
  counter += 1;
  const handle = `u${Date.now()}_${counter}`;
  const user = await prisma.user.create({ data: { handle, role } });
  const accountId = await getOrCreateUserAccount(user.id, prisma);
  return { userId: user.id, accountId, handle };
}

/** A buyer with a deposited USDC balance. `amount` is a human string e.g. '100'. */
export async function makeFundedUser(
  amount: string,
): Promise<{ userId: string; accountId: string; handle: string }> {
  const user = await makeUser('buyer');
  await deposit({ accountId: user.accountId, amount: usdc(amount) }, prisma);
  return user;
}

export interface RunningAuction {
  auctionId: string;
  sellerId: string;
  listingId: string;
}

/** Create a seller + listing + auction and start it on the given clock. */
export async function makeRunningAuction(opts: {
  startingBid: string;
  clock: ManualClock;
  durationSeconds?: number;
  counterBidSeconds?: number;
  minIncrementBps?: number;
  minIncrementFloor?: bigint;
}): Promise<RunningAuction> {
  const seller = await makeUser('seller');
  const listing = await prisma.listing.create({
    data: {
      sellerId: seller.userId,
      title: 'Charizard Holo',
      photos: [],
      startingBid: usdc(opts.startingBid),
      status: 'QUEUED',
    },
  });
  const auctionId = await createAuction(
    {
      listingId: listing.id,
      startingBid: usdc(opts.startingBid),
      durationSeconds: opts.durationSeconds,
      counterBidSeconds: opts.counterBidSeconds,
      minIncrementBps: opts.minIncrementBps,
      minIncrementFloor: opts.minIncrementFloor,
    },
    prisma,
  );
  await startAuction(auctionId, opts.clock, prisma);
  return { auctionId, sellerId: seller.userId, listingId: listing.id };
}
