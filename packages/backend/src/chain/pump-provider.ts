/**
 * Pump.fun coin-creation provider seam.
 *
 * BIDit auto-creates a seller's livestream coin ("<handle>'s BIDit Livestream",
 * $0 initial buy) with the SELLER's wallet as the on-chain creator — pump.fun
 * only offers "Start livestream" to the creator's account, so the coin must be
 * theirs, not ours. The backend prepares and vets the transaction and signs with
 * the ephemeral MINT keypair only; the creator signature always comes from the
 * seller's wallet in the browser. The mint secret lives for the duration of one
 * prepare call and is never persisted or logged (pump's program takes mint
 * authority at create, so the key is worthless afterwards anyway).
 *
 * Implementations:
 *  - MockPumpCreateProvider — dev/test/preview: no chain, no signature, instant.
 *  - PumpPortalProvider     — mainnet: pump.fun IPFS metadata upload + PumpPortal
 *                             local-transaction build (implemented in a later
 *                             slice; selecting it before then 502s cleanly).
 */

export class PumpCreateError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'ALREADY_LINKED'
      | 'NOT_FOUND'
      | 'SUPERSEDED'
      | 'ATTEMPT_DEAD'
      | 'WALLET_MISMATCH'
      | 'TX_EXPIRED'
      | 'TX_FAILED'
      | 'BAD_SIGNATURE'
      | 'BAD_WALLET'
      | 'PROVIDER_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'PumpCreateError';
  }
}

export interface PreparedCreate {
  /** Base58 mint pubkey of the coin this attempt would create. */
  mint: string;
  /** Metadata URI uploaded to pump.fun's IPFS (null in mock mode). */
  metadataUri: string | null;
  /** Serialized create tx, partially signed by the mint key (base64; null in mock). */
  txB64: string | null;
  /** Base58 of the tx message bytes — exactly what the creator wallet signs. */
  messageB58: string | null;
  /** Blockhash expiry height captured when the tx was (re)built. */
  lastValidBlockHeight: bigint | null;
  /** False in mock mode: submit may proceed with no creator signature. */
  requiresSignature: boolean;
}

/** The creator's signature, in one of two shapes: the raw ed25519 signature over
 *  the tx message (primary — the browser never parses the tx), or a fully signed
 *  serialized tx (fallback lane for wallet APIs that only return whole txs). */
export type CreatorProof =
  | { publicKey: string; signatureB58: string }
  | { signedTxB64: string };

export interface PumpCreateProvider {
  readonly mode: 'pumpportal' | 'mock';
  prepareCreate(input: {
    /** Base58 wallet that will sign as creator/fee-payer (null in mock mode). */
    creatorWallet: string | null;
    name: string;
    symbol: string;
    /** Built per-mint because the coin's description links to its own watch page. */
    describe: (mint: string) => string;
    imagePng: Buffer | null;
  }): Promise<PreparedCreate>;
  /** Merge the creator's signature into the prepared tx and verify every
   *  signature. The tx signature (= first sig) is fixed here, BEFORE broadcast,
   *  so an ambiguous send can always be resolved later by signature. */
  assembleSigned(attempt: { txB64: string | null; mint: string }, proof: CreatorProof | null): {
    raw: Uint8Array;
    txSig: string;
  };
  /** Broadcast. Throwing means "definitely not sent" — after a successful return
   *  the tx may land even if we never hear back (ack-loss is not failure). */
  broadcast(raw: Uint8Array): Promise<void>;
  getTxStatus(txSig: string, lastValidBlockHeight: bigint | null): Promise<'confirmed' | 'failed' | 'unknown'>;
  /** Current chain block height, for the pre-broadcast expiry check (null = no
   *  expiry concept, e.g. mock). */
  currentBlockHeight(): Promise<bigint | null>;
}

// ---------------------------------------------------------------------------
// Mock — dev/test/preview. No chain, no Phantom: prepare returns a deterministic
// fake mint and submit "confirms" immediately, so the whole onboarding flow is
// end-to-end testable with the embedded Postgres alone.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import bs58 from 'bs58';

export class MockPumpCreateProvider implements PumpCreateProvider {
  readonly mode = 'mock' as const;

  private failPrepare = false;
  private expirePrepare = false;
  private ambiguousSubmit = false;
  private fates = new Map<string, 'confirmed' | 'failed' | 'unknown'>();
  private counter = 0;
  /** How many times broadcast() actually ran — the duplicate-submit race test
   *  asserts this stays at 1 no matter how many submits race. */
  broadcasts = 0;

  async prepareCreate(input: {
    creatorWallet: string | null;
    name: string;
    symbol: string;
    describe: (mint: string) => string;
    imagePng: Buffer | null;
  }): Promise<PreparedCreate> {
    if (this.failPrepare) {
      this.failPrepare = false;
      throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Coin creation is temporarily unavailable — try again in a minute.');
    }
    // Deterministic per (name, creator, n): sha256 → 32 bytes → base58 (43-44
    // chars, alphanumeric) — passes the same shape checks as a real mint.
    this.counter += 1;
    const digest = createHash('sha256')
      .update(`pumpmock:${input.name}:${input.creatorWallet ?? ''}:${this.counter}`)
      .digest();
    const mint = bs58.encode(digest);
    void input.describe(mint); // exercised so tests catch a broken template
    const expired = this.expirePrepare;
    this.expirePrepare = false;
    return {
      mint,
      metadataUri: null,
      txB64: null,
      messageB58: null,
      // 1n with a current height of 1_000n → the submit expiry pre-check trips.
      lastValidBlockHeight: expired ? 1n : null,
      requiresSignature: false,
    };
  }

  assembleSigned(attempt: { txB64: string | null; mint: string }): { raw: Uint8Array; txSig: string } {
    return { raw: new Uint8Array(0), txSig: `mockpumptx_${attempt.mint.slice(0, 12)}` };
  }

  async broadcast(): Promise<void> {
    this.broadcasts += 1;
  }

  async getTxStatus(txSig: string): Promise<'confirmed' | 'failed' | 'unknown'> {
    return this.fates.get(txSig) ?? (this.ambiguousSubmit ? 'unknown' : 'confirmed');
  }

  async currentBlockHeight(): Promise<bigint | null> {
    return 1_000n;
  }

  // ---- test knobs (mirror MockChain's) ------------------------------------

  /** Next prepareCreate throws PROVIDER_UNAVAILABLE (PumpPortal outage). */
  failNextPrepare(): void {
    this.failPrepare = true;
  }

  /** Next prepare returns an already-expired blockhash height, so the submit's
   *  expiry pre-check fires (the slow-signer case). */
  expireNextPrepare(): void {
    this.expirePrepare = true;
  }

  /** Submits stay 'unknown' (in-flight) until resolve() decides their fate. */
  ambiguousSubmits(): void {
    this.ambiguousSubmit = true;
  }

  /** Settle an ambiguous submit one way or the other. */
  resolve(txSig: string, fate: 'confirmed' | 'failed'): void {
    this.fates.set(txSig, fate);
  }
}

// ---------------------------------------------------------------------------
// PumpPortal — the real mainnet provider. Implemented in a follow-up slice;
// until then selecting it yields a clean 502 on prepare (the UI keeps the
// paste-an-existing-coin fallback), never a crash.
// ---------------------------------------------------------------------------

export class PumpPortalProvider implements PumpCreateProvider {
  readonly mode = 'pumpportal' as const;

  async prepareCreate(): Promise<PreparedCreate> {
    throw new PumpCreateError(
      502,
      'PROVIDER_UNAVAILABLE',
      'Automatic coin creation is not enabled on this deployment yet — paste an existing coin instead.',
    );
  }

  assembleSigned(): { raw: Uint8Array; txSig: string } {
    throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Coin creation is not enabled on this deployment.');
  }

  async broadcast(): Promise<void> {
    throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Coin creation is not enabled on this deployment.');
  }

  async getTxStatus(): Promise<'confirmed' | 'failed' | 'unknown'> {
    return 'unknown';
  }

  async currentBlockHeight(): Promise<bigint | null> {
    return null;
  }
}

/** Pick the provider for this deployment. Pump.fun's program only exists on
 *  mainnet, so everything else (mock cluster, devnet, tests, preview) gets the
 *  mock; `BIDIT_PUMP_PROVIDER` overrides for spikes. */
export function getPumpCreateProvider(cluster: string): PumpCreateProvider {
  const forced = (process.env.BIDIT_PUMP_PROVIDER ?? '').trim().toLowerCase();
  if (forced === 'mock') return new MockPumpCreateProvider();
  if (forced === 'pumpportal') return new PumpPortalProvider();
  return cluster === 'mainnet-beta' ? new PumpPortalProvider() : new MockPumpCreateProvider();
}
