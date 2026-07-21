/**
 * Real auth (Chunk 6). Two ways in, one session token out:
 *  - Wallet signature (Pump-native): the client signs a challenge with their
 *    Solana wallet; we verify the ed25519 signature. No chain calls, pure crypto.
 *  - Dev login: a handle, no signature — for local demos without a wallet.
 *
 * Sessions are stateless HMAC tokens (no DB/Redis needed). They replace the old
 * `dev.<userId>` stub everywhere (WebSocket + REST).
 */
import { createHmac, timingSafeEqual, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Password hashing (email sign-up) — scrypt, no external deps.
// Stored as "scrypt$<saltHex>$<hashHex>".
// ---------------------------------------------------------------------------

const scrypt = promisify(scryptCb) as (password: string | Buffer, salt: string | Buffer, keylen: number) => Promise<Buffer>;

/** Max accepted password length. scrypt hashes on the event loop, so an unbounded
 *  password (the body cap is 4 MB) could stall all request handling — bound it. */
export const MAX_PASSWORD_LEN = 128;

/** Hash a password (async so scrypt yields the event loop instead of blocking it). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  // Never feed an over-long password into scrypt (event-loop DoS) — a legit
  // password is capped at registration, so a long one here is never valid.
  if (password.length > MAX_PASSWORD_LEN) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  let actual: Buffer;
  try {
    actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const SECRET = process.env.AUTH_SECRET ?? 'dev-insecure-secret-change-me';
const SESSION_TTL_MS = 30 * 86_400_000; // 30 days
const CHALLENGE_TTL_MS = 5 * 60_000; // 5 minutes

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function hmac(body: string): string {
  return b64url(createHmac('sha256', SECRET).update(body).digest());
}

// Revocation: userId -> epoch (ms). A token whose issued-at (iat) is before the
// user's epoch is rejected. Durably backed by User.sessionsValidFrom (persisted on
// logout/password-change and hydrated into this map at startup), so revocations
// survive restarts; the map keeps the auth-path check synchronous + O(1).
const revokedBefore = new Map<string, number>();

/** Mirror a user's revocation epoch into memory (call after persisting it). */
export function setRevokedEpoch(userId: string, epochMs: number): void {
  revokedBefore.set(userId, epochMs);
}

/** Mint a session token for a user. `iat` lets a later logout revoke it. */
export function issueSession(userId: string, ttlMs = SESSION_TTL_MS): string {
  const now = Date.now();
  const body = b64url(Buffer.from(JSON.stringify({ uid: userId, iat: now, exp: now + ttlMs })));
  return `${body}.${hmac(body)}`;
}

/** Returns the userId in a valid, unexpired, un-revoked token, else null. */
export function verifySession(token: string | null | undefined): string | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmac(body));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      uid?: unknown;
      iat?: unknown;
      exp?: unknown;
    };
    if (typeof payload.exp === 'number' && Date.now() > payload.exp) return null;
    const uid = typeof payload.uid === 'string' ? payload.uid : null;
    if (!uid) return null;
    // Revoked if the token predates the user's epoch. Pre-upgrade tokens (no iat)
    // count as iat=0, so a logout revokes them too — but nobody is logged out on
    // deploy, since no epoch is set until the first revocation.
    const iat = typeof payload.iat === 'number' ? payload.iat : 0;
    const revokedAt = revokedBefore.get(uid);
    if (revokedAt !== undefined && iat < revokedAt) return null;
    return uid;
  } catch {
    return null;
  }
}

export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// Wallet-signature login
// ---------------------------------------------------------------------------

const challenges = new Map<string, { message: string; exp: number }>();
// Hard cap so an attacker spamming /auth/challenge with distinct addresses can't
// grow this Map without bound (a single-instance in-memory store; Redis w/ TTL in
// a multi-instance deploy). Combined with per-IP rate limiting on the route.
const MAX_CHALLENGES = 10_000;

/** True if `addr` is a base58-encoded 32-byte ed25519 public key (a Solana address). */
export function isValidWalletAddress(addr: string): boolean {
  try {
    return bs58.decode(addr).length === 32;
  } catch {
    return false;
  }
}

/** Drop expired challenges, then evict oldest until under the hard cap. */
function pruneChallenges(now: number): void {
  for (const [k, v] of challenges) {
    if (v.exp <= now) challenges.delete(k);
  }
  while (challenges.size >= MAX_CHALLENGES) {
    const oldest = challenges.keys().next().value;
    if (oldest === undefined) break;
    challenges.delete(oldest);
  }
}

/** Issue a challenge for the wallet to sign. (In-memory; Redis in a real deploy.)
 *  Callers must pre-validate the address with isValidWalletAddress(). */
export function buildLoginChallenge(walletAddress: string): string {
  pruneChallenges(Date.now());
  const nonce = randomBytes(16).toString('hex');
  const message = `BIDit login\nwallet: ${walletAddress}\nnonce: ${nonce}\nissued: ${new Date().toISOString()}`;
  challenges.set(walletAddress, { message, exp: Date.now() + CHALLENGE_TTL_MS });
  return message;
}

/** Test/introspection helper: current number of outstanding challenges. */
export function outstandingChallengeCount(): number {
  return challenges.size;
}

// ---------------------------------------------------------------------------
// Short-lived WebSocket tickets
// ---------------------------------------------------------------------------
// The WebSocket auths via a query param, and URLs leak (proxy logs, history,
// monitoring). Instead of putting the long-lived session token there, the client
// trades it — over an authenticated POST — for a ONE-TIME ticket that's valid for
// ~60s. A leaked socket URL is then worthless: the ticket is already used/expired.

const WS_TICKET_TTL_MS = 60_000;
const MAX_WS_TICKETS = 20_000;
const wsTickets = new Map<string, { userId: string; exp: number }>();

function pruneWsTickets(now: number): void {
  for (const [k, v] of wsTickets) {
    if (v.exp <= now) wsTickets.delete(k);
  }
  while (wsTickets.size >= MAX_WS_TICKETS) {
    const oldest = wsTickets.keys().next().value;
    if (oldest === undefined) break;
    wsTickets.delete(oldest);
  }
}

/** Mint a one-time, ~60s WebSocket ticket for an already-authenticated user. */
export function issueWsTicket(userId: string): string {
  pruneWsTickets(Date.now());
  const ticket = randomBytes(24).toString('base64url');
  wsTickets.set(ticket, { userId, exp: Date.now() + WS_TICKET_TTL_MS });
  return ticket;
}

/** Validate + CONSUME a WS ticket (single use). Returns the userId, or null if
 *  unknown/expired/already used. */
export function consumeWsTicket(ticket: string | null | undefined): string | null {
  if (!ticket) return null;
  const t = wsTickets.get(ticket);
  if (!t) return null;
  wsTickets.delete(ticket); // one-time: consumed even if we then reject it as expired
  return Date.now() > t.exp ? null : t.userId;
}

/** Test/introspection helper: outstanding (unconsumed) WS tickets. */
export function outstandingWsTicketCount(): number {
  return wsTickets.size;
}

/** Verify a base58 ed25519 signature of the wallet's outstanding challenge. */
export function verifyWalletSignature(walletAddress: string, signatureBase58: string): boolean {
  const challenge = challenges.get(walletAddress);
  if (!challenge || Date.now() > challenge.exp) return false;
  let ok = false;
  try {
    const publicKey = bs58.decode(walletAddress);
    const signature = bs58.decode(signatureBase58);
    const message = new TextEncoder().encode(challenge.message);
    ok = nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    ok = false;
  }
  if (ok) challenges.delete(walletAddress); // consume the nonce (one-time use)
  return ok;
}
