/**
 * Per-user deposit wallets.
 *
 * Each user gets their own Solana deposit address, but the backend NEVER stores
 * per-user private keys. Instead every keypair is DERIVED deterministically
 * from a single master seed that lives in an env var (gitignored, operator-
 * controlled): address = ed25519( HMAC-SHA256(masterSeed, "deposit:"+userId) ).
 *
 * Given the same userId + seed you always get the same address, and the spending
 * key can be re-derived on demand (for sweeping deposits into the treasury) —
 * nothing secret is ever written to the database.
 *
 * DEVNET ONLY. For mainnet the master seed must move into a KMS/HSM and the
 * whole custody model gets a security audit (tracked separately).
 */
import { createHmac } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const MASTER_SEED = process.env.BIDIT_WALLET_SEED ?? 'dev-insecure-wallet-seed-change-me';

function seedFor(userId: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', MASTER_SEED).update(`deposit:${userId}`).digest());
}

/** The user's Solana deposit address (base58 public key). Deterministic. */
export function deriveDepositAddress(userId: string): string {
  const kp = nacl.sign.keyPair.fromSeed(seedFor(userId));
  return bs58.encode(Buffer.from(kp.publicKey));
}

/**
 * Re-derive the full keypair (secret + public) for sweeping. Kept in-process
 * only, never persisted or returned over the wire. Not used yet — here so the
 * deposit-sweeper can find funds without a stored secret.
 */
export function deriveDepositKeypair(userId: string): { address: string; secretKey: Uint8Array } {
  const kp = nacl.sign.keyPair.fromSeed(seedFor(userId));
  return { address: bs58.encode(Buffer.from(kp.publicKey)), secretKey: kp.secretKey };
}
