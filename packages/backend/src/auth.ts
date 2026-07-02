/**
 * Real auth (Chunk 6). Two ways in, one session token out:
 *  - Wallet signature (Pump-native): the client signs a challenge with their
 *    Solana wallet; we verify the ed25519 signature. No chain calls, pure crypto.
 *  - Dev login: a handle, no signature — for local demos without a wallet.
 *
 * Sessions are stateless HMAC tokens (no DB/Redis needed). They replace the old
 * `dev.<userId>` stub everywhere (WebSocket + REST).
 */
import { createHmac, timingSafeEqual, randomBytes, scryptSync } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Password hashing (email sign-up) — scrypt, no external deps.
// Stored as "scrypt$<saltHex>$<hashHex>".
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  let actual: Buffer;
  try {
    actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
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

/** Mint a session token for a user. */
export function issueSession(userId: string, ttlMs = SESSION_TTL_MS): string {
  const body = b64url(Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + ttlMs })));
  return `${body}.${hmac(body)}`;
}

/** Returns the userId in a valid, unexpired token, else null. */
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
      exp?: unknown;
    };
    if (typeof payload.exp === 'number' && Date.now() > payload.exp) return null;
    return typeof payload.uid === 'string' ? payload.uid : null;
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

/** Issue a challenge for the wallet to sign. (In-memory; Redis in a real deploy.) */
export function buildLoginChallenge(walletAddress: string): string {
  const nonce = randomBytes(16).toString('hex');
  const message = `BIDit login\nwallet: ${walletAddress}\nnonce: ${nonce}\nissued: ${new Date().toISOString()}`;
  challenges.set(walletAddress, { message, exp: Date.now() + CHALLENGE_TTL_MS });
  return message;
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
