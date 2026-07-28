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

/**
 * The user's own deposit key, base58-encoded — the format Phantom and Solflare
 * accept on "import private key". Only ever returned to the authenticated owner
 * of that account, and never logged or persisted.
 *
 * Handing this out is safe for the platform's books: a deposit is credited only
 * after the sweep into treasury actually lands (see SolanaChain.pollDeposits),
 * so a user who moves funds out of their own deposit address first simply
 * doesn't get credited. It does mean the address has two spenders — them and
 * the sweeper — which is why the UI warns that funds sent there may be swept
 * into their BIDit balance at any moment.
 */
export function exportDepositSecretKey(userId: string): { address: string; secretKeyBase58: string } {
  const { address, secretKey } = deriveDepositKeypair(userId);
  return { address, secretKeyBase58: bs58.encode(Buffer.from(secretKey)) };
}
