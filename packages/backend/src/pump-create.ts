/**
 * Auto-create a seller's pump.fun livestream coin.
 *
 * The lifecycle lives in PumpCoinCreateAttempt (PREPARED → SUBMITTED →
 * CONFIRMED | FAILED | SUPERSEDED — see schema.prisma), and two provider shapes
 * feed it (see chain/pump-provider.ts):
 *
 *  - off-chain (default): the seller signs pump.fun's sign-in message, we create
 *    the coin through pump.fun's own API. One round trip, settled or not — no
 *    chain, no fee, no wallet warning.
 *  - on-chain (escape hatch): the seller signs a create transaction. That path
 *    follows the withdrawals durable-settlement stance — the tx signature is
 *    fixed BEFORE broadcast, an ambiguous send is never treated as failure, and
 *    only the chain can declare an attempt dead.
 *
 * A per-seller advisory lock serializes prepare/finalize either way, so at most
 * one attempt is submittable and a confirmed create never clobbers a coin the
 * seller linked by other means in the meantime.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import type { PumpCoinCreateAttempt } from '@prisma/client';
import { corsAllowlist } from './http.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  PumpCreateError,
  pumpLoginMessage,
  type CreatorProof,
  type PumpCreateProvider,
  type SignMode,
} from './chain/pump-provider.js';

/** The seller's pump.fun sign-in signature, base64 from the browser (keeps bs58
 *  out of the web bundle). Never stored: it grants a pump.fun session. */
export interface LoginSignatureProof {
  publicKey: string;
  signatureB64: string;
}
export type SubmitProof = CreatorProof | LoginSignatureProof | null;

/** How long a pump.fun sign-in signature stays usable. Short on purpose: the
 *  seller signs seconds after preparing, and pump.fun rejects stale ones too. */
const LOGIN_TTL_MS = 5 * 60_000;
/** Tolerance for a server clock that runs slightly behind the prepare call. */
const CLOCK_SKEW_MS = 60_000;
/** An off-chain create is one HTTP call; a SUBMITTED row older than this was
 *  interrupted mid-flight (process restart) and will never settle itself. */
const OFFCHAIN_STUCK_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// Metadata builders
// ---------------------------------------------------------------------------

/** On-chain token-metadata name limit (bytes, not chars). */
const NAME_LIMIT_BYTES = 32;
const NAME_SUFFIX = "'s BIDit Livestream"; // ASCII apostrophe — 19 bytes

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Clip a string to at most `max` UTF-8 bytes without splitting a code point. */
function clipToBytes(s: string, max: number): string {
  if (utf8Bytes(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (utf8Bytes(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/** "<handle>'s BIDit Livestream", handle clipped so the whole name fits 32 bytes. */
export function pumpCoinName(handle: string): string {
  const room = NAME_LIMIT_BYTES - utf8Bytes(NAME_SUFFIX);
  return `${clipToBytes(handle, room)}${NAME_SUFFIX}`;
}

/** Uppercase alphanumeric ticker from the handle, ≤10 chars; BIDIT if nothing survives. */
export function pumpCoinSymbol(handle: string): string {
  const cleaned = handle.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return cleaned || 'BIDIT';
}

/** Where links inside the coin's metadata should point (the public web app). */
export function webOrigin(): string {
  const env = (process.env.BIDIT_WEB_ORIGIN ?? '').trim().replace(/\/$/, '');
  if (env) return env;
  const first = corsAllowlist()[0];
  return first ?? 'http://localhost:5174';
}

/** Coin description shown on pump.fun — sells the stream and links the watch
 *  page. Off-chain creates don't know their mint when the metadata is uploaded
 *  (pump.fun assigns it), so an empty mint links the site root instead. */
export function pumpCoinDescription(handle: string, mint: string): string {
  const where = mint ? `${webOrigin()}/live/${mint}` : webOrigin();
  return (
    `${handle} runs live card auctions on BIDit. ` +
    `Watch the stream and bid in real USDC at ${where} — bid it, win it, ship it.`
  );
}

const __dir = dirname(fileURLToPath(import.meta.url));

/** Branded coin image uploaded to pump.fun's IPFS. Null (mock mode / asset not
 *  yet shipped) is fine — the mock provider ignores it. */
export function loadCoinImage(): Buffer | null {
  try {
    return readFileSync(join(__dir, '..', 'assets', 'pump-coin.png'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export interface CoinCreateStatusDto {
  status: 'NONE' | 'PREPARED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
  attemptId?: string;
  mint?: string;
  txSig?: string | null;
  linkedCoin: string | null;
  error?: string | null;
}

const lockKey = (sellerId: string) => `pumpcreate:${sellerId}`;

async function takeSellerLock(tx: PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0], sellerId: string): Promise<void> {
  await (tx as PrismaClient).$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(sellerId)}, 0))`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build a signable create attempt for this seller. Guards: seller must not
 *  already have a linked coin; any older PREPARED attempt is superseded so
 *  exactly one attempt is ever submittable. `messageB58` (what the creator
 *  wallet signs) is returned alongside but never persisted — a reload just
 *  prepares again. */
export async function prepareCoinCreate(
  sellerId: string,
  creatorWallet: string | null,
  provider: PumpCreateProvider,
  prisma: PrismaClient = defaultPrisma,
): Promise<{
  attempt: PumpCoinCreateAttempt;
  messageB58: string | null;
  loginMessage: string | null;
  signMode: SignMode;
}> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: sellerId }, select: { handle: true } });

  // Pre-check under the seller lock (fast fail before any provider round-trip).
  await prisma.$transaction(async (tx) => {
    await takeSellerLock(tx, sellerId);
    const profile = await tx.sellerProfile.findUnique({ where: { userId: sellerId }, select: { pumpCoinAddress: true } });
    if (profile?.pumpCoinAddress) {
      throw new PumpCreateError(409, 'ALREADY_LINKED', 'You already have a linked coin. Manage it in Settings.');
    }
  });

  const name = pumpCoinName(user.handle);
  const symbol = pumpCoinSymbol(user.handle);
  const prepared = await provider.prepareCreate({
    creatorWallet,
    name,
    symbol,
    describe: (mint) => pumpCoinDescription(user.handle, mint),
    websiteFor: (mint) => `${webOrigin()}/live/${mint}`,
    imagePng: loadCoinImage(),
  });

  // Insert under the lock, re-checking the link and superseding any PREPARED
  // row that appeared while the provider round-trip ran — the last inserter is
  // the only submittable attempt.
  const attempt = await prisma.$transaction(async (tx) => {
    await takeSellerLock(tx, sellerId);
    const profile = await tx.sellerProfile.findUnique({ where: { userId: sellerId }, select: { pumpCoinAddress: true } });
    if (profile?.pumpCoinAddress) {
      throw new PumpCreateError(409, 'ALREADY_LINKED', 'You already have a linked coin. Manage it in Settings.');
    }
    await tx.pumpCoinCreateAttempt.updateMany({
      where: { sellerId, status: 'PREPARED' },
      data: { status: 'SUPERSEDED', lastError: 'superseded by a newer attempt' },
    });
    return tx.pumpCoinCreateAttempt.create({
      data: {
        sellerId,
        mint: prepared.mint,
        creatorWallet,
        name,
        symbol,
        metadataUri: prepared.metadataUri,
        txB64: prepared.txB64,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        loginTimestamp: prepared.loginTimestamp,
        status: 'PREPARED',
      },
    });
  });
  return {
    attempt,
    messageB58: prepared.messageB58,
    loginMessage: prepared.loginMessage,
    signMode: prepared.signMode,
  };
}

/** Mark CONFIRMED and link the mint as the seller's coin — idempotent, and it
 *  never overwrites a coin the seller linked some other way mid-flight. */
export async function finalizeConfirmed(
  attemptId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const attempt = await tx.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    await takeSellerLock(tx, attempt.sellerId);
    if (attempt.status === 'CONFIRMED') return;
    if (!attempt.mint) {
      // Callers set the mint before confirming; nothing to link without one.
      throw new PumpCreateError(502, 'CREATE_FAILED', 'The coin was created but its address is unknown.');
    }
    const profile = await tx.sellerProfile.findUnique({
      where: { userId: attempt.sellerId },
      select: { pumpCoinAddress: true },
    });
    let lastError: string | null = null;
    if (!profile?.pumpCoinAddress) {
      try {
        await tx.sellerProfile.upsert({
          where: { userId: attempt.sellerId },
          update: { pumpCoinAddress: attempt.mint },
          create: { userId: attempt.sellerId, pumpCoinAddress: attempt.mint },
        });
      } catch {
        // P2002 (another seller somehow holds this mint) — keep the confirm, flag it.
        lastError = 'confirmed on-chain but the mint could not be linked (already taken)';
      }
    } else if (profile.pumpCoinAddress !== attempt.mint) {
      lastError = 'confirmed on-chain but another coin was already linked';
    }
    await tx.pumpCoinCreateAttempt.update({
      where: { id: attempt.id },
      data: { status: 'CONFIRMED', lastError },
    });
  });
}

async function statusDto(
  attempt: PumpCoinCreateAttempt | null,
  prisma: PrismaClient,
): Promise<CoinCreateStatusDto> {
  const linked = attempt
    ? await prisma.sellerProfile.findUnique({ where: { userId: attempt.sellerId }, select: { pumpCoinAddress: true } })
    : null;
  if (!attempt) return { status: 'NONE', linkedCoin: null };
  const status = (['PREPARED', 'SUBMITTED', 'CONFIRMED', 'FAILED'] as const).includes(
    attempt.status as 'PREPARED',
  )
    ? (attempt.status as CoinCreateStatusDto['status'])
    : 'NONE'; // SUPERSEDED reads as "no active attempt"
  return {
    status,
    attemptId: attempt.id,
    mint: attempt.mint ?? undefined,
    txSig: attempt.txSig,
    linkedCoin: linked?.pumpCoinAddress ?? null,
    error: attempt.lastError,
  };
}

/** Off-chain submit: verify the seller's pump.fun sign-in signature ourselves,
 *  then create the coin through pump.fun in one call. There is no chain and no
 *  in-flight state to reconcile — it either comes back with a mint or it fails,
 *  and a failure leaves the seller exactly where they started. */
async function submitOffchain(
  attempt: PumpCoinCreateAttempt,
  proof: SubmitProof,
  provider: Extract<PumpCreateProvider, { kind: 'offchain' }>,
  prisma: PrismaClient,
): Promise<CoinCreateStatusDto> {
  if (attempt.loginTimestamp === null) {
    // An attempt prepared under the other provider shape can't be finished here.
    throw new PumpCreateError(409, 'SUPERSEDED', 'That attempt is out of date — start a fresh one.');
  }

  // The sign-in text is time-boxed by pump.fun and by us. Too old (or from a
  // clock ahead of ours) → dead attempt; the client silently prepares a new one.
  const age = Date.now() - Number(attempt.loginTimestamp);
  if (age > LOGIN_TTL_MS || age < -CLOCK_SKEW_MS) {
    await prisma.pumpCoinCreateAttempt.update({
      where: { id: attempt.id },
      data: { status: 'FAILED', lastError: 'sign-in message expired before submit' },
    });
    throw new PumpCreateError(410, 'TX_EXPIRED', 'That signature request expired — creating a fresh one.');
  }

  // Verify the signature here, before it is worth anything to anyone: a bad one
  // never reaches pump.fun, and the attempt stays signable.
  let signature = new Uint8Array(64);
  if (attempt.creatorWallet) {
    const login = proof && 'signatureB64' in proof ? proof : null;
    if (!login) {
      throw new PumpCreateError(400, 'BAD_SIGNATURE', 'Sign the pump.fun sign-in message to create your coin.');
    }
    let signer: Uint8Array;
    try {
      signature = new Uint8Array(Buffer.from(login.signatureB64, 'base64'));
      signer = bs58.decode(attempt.creatorWallet);
    } catch {
      throw new PumpCreateError(400, 'BAD_SIGNATURE', 'That signature could not be read — try signing again.');
    }
    const message = new TextEncoder().encode(pumpLoginMessage(attempt.loginTimestamp));
    if (signature.length !== 64 || !nacl.sign.detached.verify(message, signature, signer)) {
      throw new PumpCreateError(400, 'BAD_SIGNATURE', 'That signature did not verify — try signing again.');
    }
  }

  // Atomic claim: one submit calls pump.fun however many race; the losers read
  // back the winner's status instead of creating a second coin.
  const claimed = await prisma.pumpCoinCreateAttempt.updateMany({
    where: { id: attempt.id, status: 'PREPARED' },
    data: { status: 'SUBMITTED' },
  });
  if (claimed.count === 0) {
    return statusDto(await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: attempt.id } }), prisma);
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: attempt.sellerId }, select: { handle: true } });
  let created: { mint: string; metadataUri: string | null };
  try {
    created = await provider.complete({
      creatorWallet: attempt.creatorWallet,
      name: attempt.name,
      symbol: attempt.symbol,
      describe: (mint) => pumpCoinDescription(user.handle, mint),
      websiteFor: (mint) => (mint ? `${webOrigin()}/live/${mint}` : webOrigin()),
      imagePng: loadCoinImage(),
      login: {
        publicKey: attempt.creatorWallet ?? 'mock',
        signature,
        timestamp: attempt.loginTimestamp,
      },
    });
  } catch (err) {
    const message = err instanceof PumpCreateError ? err.message : 'pump.fun could not create the coin.';
    await prisma.pumpCoinCreateAttempt.update({
      where: { id: attempt.id },
      data: { status: 'FAILED', lastError: message },
    });
    throw err instanceof PumpCreateError ? err : new PumpCreateError(502, 'CREATE_FAILED', message);
  }

  await prisma.pumpCoinCreateAttempt.update({
    where: { id: attempt.id },
    data: { mint: created.mint, metadataUri: created.metadataUri },
  });
  await finalizeConfirmed(attempt.id, prisma);
  return statusDto(await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: attempt.id } }), prisma);
}

/** Take the seller's creator signature, broadcast, and (briefly) wait for the
 *  confirm. Every validation failure before the atomic PREPARED→SUBMITTED claim
 *  is non-destructive: the attempt stays signable. */
export async function submitCoinCreate(
  sellerId: string,
  attemptId: string,
  proof: SubmitProof,
  provider: PumpCreateProvider,
  prisma: PrismaClient = defaultPrisma,
): Promise<CoinCreateStatusDto> {
  const attempt = await prisma.pumpCoinCreateAttempt.findFirst({ where: { id: attemptId, sellerId } });
  if (!attempt) throw new PumpCreateError(404, 'NOT_FOUND', 'That coin-create attempt does not exist.');

  if (attempt.status === 'SUPERSEDED') {
    throw new PumpCreateError(409, 'SUPERSEDED', 'You started a newer attempt — use that one.');
  }
  if (attempt.status === 'SUBMITTED' || attempt.status === 'CONFIRMED') {
    return statusDto(attempt, prisma); // double-click friendly
  }
  if (attempt.status === 'FAILED') {
    throw new PumpCreateError(410, 'ATTEMPT_DEAD', 'That attempt already failed — start a fresh one.');
  }

  // Wallet mismatch: the attempt is bound to the wallet the seller connected —
  // for a tx it is the fee payer, for an off-chain create it is the pump.fun
  // account the coin lands in. Either way another wallet's signature is wrong.
  if (attempt.creatorWallet && proof && 'publicKey' in proof && proof.publicKey !== attempt.creatorWallet) {
    throw new PumpCreateError(
      409,
      'WALLET_MISMATCH',
      'Phantom signed with a different wallet than the one you connected. Switch back, or restart to use this wallet.',
    );
  }

  if (provider.kind === 'offchain') {
    return submitOffchain(attempt, proof, provider, prisma);
  }

  // Expiry pre-check — don't waste a broadcast on a provably dead blockhash.
  if (attempt.lastValidBlockHeight !== null) {
    const height = await provider.currentBlockHeight();
    if (height !== null && height > attempt.lastValidBlockHeight) {
      await prisma.pumpCoinCreateAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', lastError: 'blockhash expired before submit' },
      });
      throw new PumpCreateError(410, 'TX_EXPIRED', 'That signature request expired — creating a fresh one.');
    }
  }

  // Assemble + verify signatures; the tx signature is fixed here, pre-broadcast.
  const txProof = proof && !('signatureB64' in proof) ? proof : null;
  const { raw, txSig } = provider.assembleSigned({ txB64: attempt.txB64, mint: attempt.mint ?? '' }, txProof);

  // Atomic claim: exactly one submit broadcasts; racers get the winner's status.
  const claimed = await prisma.pumpCoinCreateAttempt.updateMany({
    where: { id: attempt.id, status: 'PREPARED' },
    data: { status: 'SUBMITTED', txSig },
  });
  if (claimed.count === 0) {
    const current = await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    return statusDto(current, prisma);
  }

  try {
    await provider.broadcast(raw);
  } catch (err) {
    // broadcast() throwing means "definitely not sent" — safe to declare dead.
    await prisma.pumpCoinCreateAttempt.update({
      where: { id: attempt.id },
      data: { status: 'FAILED', lastError: `broadcast failed: ${(err as Error).message}` },
    });
    throw new PumpCreateError(502, 'TX_FAILED', 'Could not send the create transaction — nothing was charged. Try again.');
  }

  // Short inline confirm so the happy path returns CONFIRMED in one request;
  // otherwise the row stays SUBMITTED and the status poll finishes the job.
  for (let i = 0; i < 3; i++) {
    const fate = await provider.getTxStatus(txSig, attempt.lastValidBlockHeight);
    if (fate === 'confirmed') {
      await finalizeConfirmed(attempt.id, prisma);
      return statusDto(await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: attempt.id } }), prisma);
    }
    if (fate === 'failed') {
      await prisma.pumpCoinCreateAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', lastError: 'create transaction failed on-chain' },
      });
      throw new PumpCreateError(502, 'TX_FAILED', 'The create transaction failed on-chain — nothing was charged. Try again.');
    }
    if (i < 2) await sleep(400);
  }
  return statusDto(await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: attempt.id } }), prisma);
}

/** Latest attempt + lazy reconcile: a SUBMITTED row left behind by a closed tab
 *  is resolved against the chain right here, on the next page view — no
 *  background worker. */
export async function getCoinCreateStatus(
  sellerId: string,
  provider: PumpCreateProvider,
  prisma: PrismaClient = defaultPrisma,
): Promise<CoinCreateStatusDto> {
  const attempt = await prisma.pumpCoinCreateAttempt.findFirst({
    where: { sellerId, NOT: { status: 'SUPERSEDED' } },
    orderBy: { createdAt: 'desc' },
  });
  if (!attempt) {
    const profile = await prisma.sellerProfile.findUnique({ where: { userId: sellerId }, select: { pumpCoinAddress: true } });
    return { status: 'NONE', linkedCoin: profile?.pumpCoinAddress ?? null };
  }
  // An off-chain create settles inside its own request. A SUBMITTED row that
  // outlived it means the process died mid-call — mark it dead so the card
  // offers a retry instead of spinning forever. (If pump.fun did create the
  // coin, it shows on their profile and can be pasted in Settings.)
  if (provider.kind === 'offchain' && attempt.status === 'SUBMITTED') {
    if (Date.now() - attempt.updatedAt.getTime() > OFFCHAIN_STUCK_MS) {
      await prisma.pumpCoinCreateAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'FAILED',
          lastError:
            'the create was interrupted — check your pump.fun profile before trying again, in case the coin was made',
        },
      });
      return statusDto(await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: attempt.id } }), prisma);
    }
    return statusDto(attempt, prisma);
  }

  if (provider.kind === 'tx' && attempt.status === 'SUBMITTED' && attempt.txSig) {
    const fate = await provider.getTxStatus(attempt.txSig, attempt.lastValidBlockHeight);
    if (fate === 'confirmed') {
      await finalizeConfirmed(attempt.id, prisma);
    } else if (fate === 'failed') {
      await prisma.pumpCoinCreateAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', lastError: 'create transaction failed on-chain' },
      });
    }
    return statusDto(await prisma.pumpCoinCreateAttempt.findUniqueOrThrow({ where: { id: attempt.id } }), prisma);
  }
  return statusDto(attempt, prisma);
}
