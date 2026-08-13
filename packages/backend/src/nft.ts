/**
 * NFT custody + NFT auctions.
 *
 * Custody: a user arms detection and sends an NFT to their BIDit deposit
 * address (the same derived wallet as USDC/SOL deposits). The watcher records it
 * as an NftAsset (HELD). The token never moves again until a withdrawal: auction
 * "delivery" is a ledger reassignment of `ownerId`, which is why the winner is
 * credited instantly and the seller can be paid instantly.
 *
 * Locking: an asset is locked (not withdrawable) while attached to a listing
 * that can still run (QUEUED / LIVE). Unlisting or an unsold close frees it.
 *
 * Auctions: an NFT listing is a normal Listing (nft=true) whose photos/title
 * come from the assets, so it can run on a livestream exactly like a card, or on
 * the marketplace as a timed auction (no shipping: delivery is digital). Batch
 * mode = several assets on one listing; the winner takes them all.
 */
import { AuctionStatus, ListingStatus } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { requireSeller } from './authz.js';
import { createAuction, startAuction } from './auction.js';
import { notify } from './notifications.js';
import { systemClock, type Clock } from './clock.js';
import type { ChainClient } from './chain/types.js';
import type { NftChain } from './chain/nft-chain.js';
import { MARKET_ANTI_SNIPE_MS } from './market.js';

export class NftError extends Error {}

/** How long one "I'm depositing an NFT" arm keeps the watcher polling. */
export const NFT_WATCH_MS = 30 * 60 * 1000;
const MAX_BATCH = 10;
const MIN_START_MICROS = 1_000_000n;
const MAX_START_MICROS = 100_000_000_000n;

// ---------------------------------------------------------------------------
// Deposit detection
// ---------------------------------------------------------------------------

/** Arm NFT-deposit detection for a user and hand back where to send the NFT. */
export async function armNftDeposit(
  userId: string,
  chain: ChainClient,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ depositAddress: string; watchUntil: number }> {
  const depositAddress = await chain.depositAddress(userId);
  const watchUntil = new Date(clock.now().getTime() + NFT_WATCH_MS);
  await prisma.user.update({ where: { id: userId }, data: { nftWatchUntil: watchUntil } });
  return { depositAddress, watchUntil: watchUntil.getTime() };
}

/**
 * One watcher tick: scan armed users' deposit wallets and record any NFT that
 * isn't in custody yet. Re-depositing a previously withdrawn mint reactivates
 * its row under the depositor. Never throws per-user; returns how many were
 * credited.
 */
export async function creditNftDeposits(
  chain: ChainClient,
  nftChain: NftChain,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<number> {
  const armed = await prisma.user.findMany({
    where: { nftWatchUntil: { gt: clock.now() } },
    select: { id: true },
  });
  let credited = 0;
  for (const { id: userId } of armed) {
    try {
      const depositAddress = await chain.depositAddress(userId);
      const found = await nftChain.listNfts(depositAddress);
      if (found.length === 0) continue;
      const mints = found.map((f) => f.mint);
      const existing = await prisma.nftAsset.findMany({ where: { mint: { in: mints } } });
      const byMint = new Map(existing.map((a) => [a.mint, a]));
      for (const { mint } of found) {
        const row = byMint.get(mint);
        if (row && row.status !== 'WITHDRAWN') continue; // already in custody
        const meta = await nftChain.metadata(mint).catch(() => null);
        await prisma.nftAsset.upsert({
          where: { mint },
          create: {
            mint,
            ownerId: userId,
            custodyUserId: userId,
            name: meta?.name ?? null,
            image: meta?.image ?? null,
            collection: meta?.collection ?? null,
            standard: meta?.standard ?? null,
          },
          update: {
            ownerId: userId,
            custodyUserId: userId,
            status: 'HELD',
            listingId: null,
            withdrawAddress: null,
            withdrawTxSig: null,
            name: meta?.name ?? undefined,
            image: meta?.image ?? undefined,
            collection: meta?.collection ?? undefined,
            standard: meta?.standard ?? undefined,
          },
        });
        credited += 1;
        await notify(
          {
            userId,
            kind: 'nft',
            title: `NFT received: ${meta?.name ?? mint.slice(0, 8)}`,
            body: 'It’s in your BIDit account. Auction it on stream or the marketplace, or withdraw it anytime.',
            href: '/nfts',
            email: false,
          },
          prisma,
        ).catch(() => {});
      }
    } catch (err) {
      console.error('[nft-watch] scan failed (will retry):', (err as Error)?.message ?? err);
    }
  }
  return credited;
}

// ---------------------------------------------------------------------------
// Holdings + locking
// ---------------------------------------------------------------------------

/** Listing states in which the attached assets must stay in custody. */
const LOCKING_LISTING_STATUSES: ListingStatus[] = [ListingStatus.QUEUED, ListingStatus.LIVE];

export async function listMyNfts(userId: string, prisma: PrismaClient = defaultPrisma) {
  const rows = await prisma.nftAsset.findMany({
    where: { ownerId: userId, status: { not: 'WITHDRAWN' } },
    orderBy: { createdAt: 'desc' },
    include: { listing: { select: { id: true, status: true, marketplace: true, auctions: { where: { status: { in: [AuctionStatus.RUNNING, AuctionStatus.SETTLING] } }, select: { id: true }, take: 1 } } } },
  });
  return rows.map((a) => {
    const locked =
      a.status === 'WITHDRAWING' ||
      (a.listing !== null &&
        (LOCKING_LISTING_STATUSES.includes(a.listing.status) || a.listing.auctions.length > 0));
    return {
      id: a.id,
      mint: a.mint,
      name: a.name,
      image: a.image,
      collection: a.collection,
      standard: a.standard,
      status: a.status,
      locked,
      listingId: a.listing && locked && a.status === 'HELD' ? a.listing.id : null,
      marketplace: a.listing?.marketplace ?? false,
      withdrawTxSig: a.withdrawTxSig,
    };
  });
}

/** The asset ids that are HELD, owned by `userId`, and not locked by a listing.
 *  Throws naming the first offender so callers surface a useful error. */
async function requireUnlockedOwned(
  userId: string,
  assetIds: string[],
  prisma: PrismaClient,
) {
  const ids = [...new Set(assetIds)].filter(Boolean);
  if (ids.length === 0) throw new NftError('Pick at least one NFT.');
  if (ids.length > MAX_BATCH) throw new NftError(`A batch can hold at most ${MAX_BATCH} NFTs.`);
  const assets = await prisma.nftAsset.findMany({
    where: { id: { in: ids } },
    include: { listing: { select: { status: true, auctions: { where: { status: { in: [AuctionStatus.RUNNING, AuctionStatus.SETTLING] } }, select: { id: true }, take: 1 } } } },
  });
  if (assets.length !== ids.length) throw new NftError('An NFT was not found.');
  for (const a of assets) {
    if (a.ownerId !== userId) throw new NftError('That NFT isn’t yours.');
    if (a.status !== 'HELD') throw new NftError(`${a.name ?? a.mint.slice(0, 8)} is being withdrawn.`);
    const locked = a.listing !== null && (LOCKING_LISTING_STATUSES.includes(a.listing.status) || a.listing.auctions.length > 0);
    if (locked) throw new NftError(`${a.name ?? a.mint.slice(0, 8)} is already on an auction. Unlist it first.`);
  }
  return assets;
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

export async function withdrawNft(
  userId: string,
  assetId: string,
  address: string,
  nftChain: NftChain,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  if (!nftChain.isValidAddress(address)) throw new NftError('That doesn’t look like a valid Solana address.');
  await requireUnlockedOwned(userId, [assetId], prisma);
  // Atomic claim: two concurrent withdraw clicks race on status.
  const claimed = await prisma.nftAsset.updateMany({
    where: { id: assetId, ownerId: userId, status: 'HELD' },
    data: { status: 'WITHDRAWING', withdrawAddress: address },
  });
  if (claimed.count === 0) throw new NftError('That NFT is not withdrawable right now.');
}

/** One withdraw-worker tick: send every WITHDRAWING asset. "Source no longer
 *  holds the token" counts as sent (an earlier ambiguous attempt landed). */
export async function processNftWithdrawals(
  nftChain: NftChain,
  prisma: PrismaClient = defaultPrisma,
): Promise<number> {
  const pending = await prisma.nftAsset.findMany({ where: { status: 'WITHDRAWING' } });
  let done = 0;
  for (const a of pending) {
    if (!a.withdrawAddress) continue;
    try {
      const sig = await nftChain.sendNft(a.custodyUserId, a.mint, a.withdrawAddress);
      await prisma.nftAsset.update({ where: { id: a.id }, data: { status: 'WITHDRAWN', withdrawTxSig: sig } });
      done += 1;
      await notify(
        { userId: a.ownerId, kind: 'nft', title: `NFT sent: ${a.name ?? a.mint.slice(0, 8)}`, body: 'Your NFT left BIDit for your wallet.', href: '/nfts', email: false },
        prisma,
      ).catch(() => {});
    } catch (err) {
      if ((err as Error)?.name === 'NftAlreadySentError') {
        await prisma.nftAsset.update({ where: { id: a.id }, data: { status: 'WITHDRAWN' } });
        done += 1;
        continue;
      }
      // Transient (RPC down, fee spike): stays WITHDRAWING, retried next tick.
      console.error(`[nft-withdraw] ${a.mint} failed (will retry):`, (err as Error)?.message ?? err);
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// Listing NFTs for auction (stream + marketplace, batch-capable)
// ---------------------------------------------------------------------------

export interface CreateNftListingInput {
  assetIds: string[];
  startingBid: bigint;
  title?: string;
  description?: string;
  /** 'stream': queued for the seller's live room. 'market': timed marketplace
   *  auction that starts immediately (durationHours applies). */
  mode: 'stream' | 'market';
  durationHours?: number;
}

export async function createNftListing(
  sellerId: string,
  input: CreateNftListingInput,
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
): Promise<{ listingId: string; auctionId: string | null; endsAt: number | null }> {
  await requireSeller(sellerId, prisma);
  if (input.startingBid < MIN_START_MICROS || input.startingBid > MAX_START_MICROS) {
    throw new NftError('Starting bid must be between $1 and $100,000.');
  }
  const assets = await requireUnlockedOwned(sellerId, input.assetIds, prisma);

  const first = assets[0]!;
  const defaultTitle =
    assets.length === 1
      ? (first.name ?? `NFT ${first.mint.slice(0, 6)}`)
      : `${first.name ?? `NFT ${first.mint.slice(0, 6)}`} + ${assets.length - 1} more`;
  const title = (input.title ?? '').trim() || defaultTitle;
  const photos = assets.map((a) => a.image).filter((p): p is string => !!p).slice(0, 12);

  const listing = await prisma.listing.create({
    data: {
      sellerId,
      title: title.slice(0, 90),
      description: input.description ? String(input.description).slice(0, 2000) : null,
      photos,
      startingBid: input.startingBid,
      category: 'NFTs',
      status: ListingStatus.QUEUED,
      nft: true,
      marketplace: input.mode === 'market',
    },
  });
  await prisma.nftAsset.updateMany({
    where: { id: { in: assets.map((a) => a.id) } },
    data: { listingId: listing.id },
  });

  if (input.mode === 'market') {
    const hours = Math.floor(input.durationHours ?? 24);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
      throw new NftError('Auction length must be between 1 hour and 7 days.');
    }
    const auctionId = await createAuction(
      {
        listingId: listing.id,
        startingBid: input.startingBid,
        durationSeconds: hours * 3600,
        counterBidSeconds: Math.floor(MARKET_ANTI_SNIPE_MS / 1000),
      },
      prisma,
    );
    const snapshot = await startAuction(auctionId, clock, prisma);
    return { listingId: listing.id, auctionId, endsAt: snapshot.endsAt!.getTime() };
  }
  // Stream mode: stays QUEUED; the seller runs it from their live room like any
  // other item.
  return { listingId: listing.id, auctionId: null, endsAt: null };
}

/** Take an NFT listing down (only while nothing is running) and free its assets. */
export async function unlistNftListing(
  sellerId: string,
  listingId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: { auctions: { where: { status: { in: [AuctionStatus.RUNNING, AuctionStatus.SETTLING] } }, select: { id: true }, take: 1 } },
  });
  if (!listing || !listing.nft || listing.sellerId !== sellerId) throw new NftError('Listing not found.');
  if (listing.auctions.length > 0) throw new NftError('That auction is running; it can’t be unlisted now.');
  await prisma.listing.update({ where: { id: listingId }, data: { status: ListingStatus.CANCELED } });
  await prisma.nftAsset.updateMany({ where: { listingId }, data: { listingId: null } });
}

// ---------------------------------------------------------------------------
// Settlement: the win credits the assets instantly
// ---------------------------------------------------------------------------

/**
 * Reassign every asset on a won NFT listing to the buyer. Ledger-only, so it is
 * instant; the caller then releases the escrow to the seller at once (the fee is
 * taken at release, so the seller nets their 95% immediately). Idempotent: a
 * second call finds no assets still attached.
 */
export async function creditNftWin(
  params: { listingId: string; buyerId: string; sellerId: string; title: string },
  prisma: PrismaClient = defaultPrisma,
): Promise<number> {
  const assets = await prisma.nftAsset.findMany({ where: { listingId: params.listingId } });
  if (assets.length === 0) return 0;
  await prisma.nftAsset.updateMany({
    where: { listingId: params.listingId },
    data: { ownerId: params.buyerId, listingId: null },
  });
  const n = assets.length;
  await notify(
    {
      userId: params.buyerId,
      kind: 'nft',
      title: `You won ${params.title}`,
      body: `${n === 1 ? 'The NFT is' : `All ${n} NFTs are`} in your BIDit account. Withdraw to your wallet anytime.`,
      href: '/nfts',
    },
    prisma,
  ).catch(() => {});
  return n;
}
