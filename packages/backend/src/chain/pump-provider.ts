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
    /** The metadata's website field — also per-mint (the coin's watch URL). */
    websiteFor?: (mint: string) => string;
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
// PumpPortal — the real mainnet provider.
//
// prepare:  mint keypair (ephemeral) → metadata to pump.fun IPFS → unsigned
//           create tx from PumpPortal's local API → VET → fresh blockhash →
//           mint partial-sign → hand the message to the browser.
// submit:   merge + verify the creator's signature (txSig fixed here),
//           broadcast on our own RPC, then poll the signature.
//
// pump.fun & PumpPortal sit behind Cloudflare: browser-shaped headers, same as
// the livestream proxy that's already proven from Render in production.
// ---------------------------------------------------------------------------

import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import nacl from 'tweetnacl';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
/** Programs a create-only transaction may touch. Anything else = reject. */
const ALLOWED_PROGRAMS = new Set<string>([
  PUMP_PROGRAM,
  '11111111111111111111111111111111', // System
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
  'ComputeBudget111111111111111111111111111111',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', // Metaplex token metadata
]);

const PUMP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PUMP_WEB_HEADERS = { 'user-agent': PUMP_UA, origin: 'https://pump.fun', referer: 'https://pump.fun/' };

/** Static safety line on the third-party-built tx BEFORE the mint key or the
 *  seller's wallet signs it: right fee payer, only whitelisted programs, and
 *  exactly one pump-program instruction (the create — a second one would be a
 *  smuggled buy). Throws PROVIDER_UNAVAILABLE with the details kept server-side. */
export function vetCreateTx(bytes: Uint8Array, creatorWallet: string): VersionedTransaction {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch {
    throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Coin creation is temporarily unavailable — try again in a minute.');
  }
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const problems: string[] = [];
  if (keys[0] !== creatorWallet) problems.push(`fee payer is ${keys[0] ?? '(none)'}, expected creator ${creatorWallet}`);
  let pumpIx = 0;
  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex] ?? '(out of range)';
    if (!ALLOWED_PROGRAMS.has(program)) problems.push(`instruction touches non-allowlisted program ${program}`);
    if (program === PUMP_PROGRAM) pumpIx += 1;
  }
  if (pumpIx !== 1) problems.push(`expected exactly 1 pump instruction (create), got ${pumpIx}`);
  if (problems.length > 0) {
    console.warn('[pump-create] vetting rejected provider tx:', problems.join('; '));
    throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Coin creation is temporarily unavailable — try again in a minute.');
  }
  return tx;
}

/** Merge the creator's proof into the mint-signed tx and verify EVERY required
 *  signature against the message bytes. The returned txSig (first signature) is
 *  final — it never changes across broadcast/retry. */
export function mergeCreatorSignature(
  txB64: string,
  proof: CreatorProof,
): { raw: Uint8Array; txSig: string } {
  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
  const message = tx.message.serialize();

  if ('signedTxB64' in proof) {
    // Fallback lane: the wallet returned a whole signed tx. It must be OUR tx —
    // identical message bytes — with the signatures filled in.
    const theirs = VersionedTransaction.deserialize(Buffer.from(proof.signedTxB64, 'base64'));
    if (!Buffer.from(theirs.message.serialize()).equals(Buffer.from(message))) {
      throw new PumpCreateError(400, 'BAD_SIGNATURE', 'That signature belongs to a different transaction.');
    }
    // Carry over any signature slots we were missing (the creator's); keep our
    // mint signature if theirs lacks it.
    for (let i = 0; i < tx.signatures.length; i++) {
      const ours = tx.signatures[i];
      const other = theirs.signatures[i];
      if (ours && other && ours.every((b) => b === 0) && !other.every((b) => b === 0)) {
        tx.signatures[i] = other;
      }
    }
  } else {
    let sig: Uint8Array;
    let pk: PublicKey;
    try {
      sig = bs58.decode(proof.signatureB58);
      pk = new PublicKey(proof.publicKey);
    } catch {
      throw new PumpCreateError(400, 'BAD_SIGNATURE', 'That signature could not be read — try signing again.');
    }
    tx.addSignature(pk, sig);
  }

  // Every required signer must have a valid signature over the message.
  const signers = tx.message.staticAccountKeys.slice(0, tx.signatures.length);
  for (let i = 0; i < tx.signatures.length; i++) {
    const sig = tx.signatures[i];
    const signer = signers[i];
    if (!sig || !signer || sig.every((b) => b === 0) || !nacl.sign.detached.verify(message, sig, signer.toBytes())) {
      throw new PumpCreateError(400, 'BAD_SIGNATURE', 'The transaction signature did not verify — try signing again.');
    }
  }
  const first = tx.signatures[0];
  if (!first) throw new PumpCreateError(400, 'BAD_SIGNATURE', 'The transaction has no signature.');
  return { raw: tx.serialize(), txSig: bs58.encode(first) };
}

export class PumpPortalProvider implements PumpCreateProvider {
  readonly mode = 'pumpportal' as const;
  private connLazy: Connection | null = null;

  private conn(): Connection {
    if (!this.connLazy) {
      const rpc = (process.env.SOLANA_RPC ?? '').trim();
      if (!rpc) {
        throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Coin creation is not configured on this deployment (no RPC).');
      }
      this.connLazy = new Connection(rpc, 'confirmed');
    }
    return this.connLazy;
  }

  async prepareCreate(input: {
    creatorWallet: string | null;
    name: string;
    symbol: string;
    describe: (mint: string) => string;
    websiteFor?: (mint: string) => string;
    imagePng: Buffer | null;
  }): Promise<PreparedCreate> {
    if (!input.creatorWallet) {
      throw new PumpCreateError(400, 'BAD_WALLET', 'Connect a Solana wallet to create your coin.');
    }
    if (!input.imagePng) {
      // The branded PNG ships in the repo; missing it is a deploy problem, not a user one.
      console.warn('[pump-create] assets/pump-coin.png missing — cannot build metadata');
      throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Coin creation is temporarily unavailable.');
    }

    // The mint keypair lives only inside this call: pump's program takes mint
    // authority at create, so after the partial-sign the secret is worthless.
    const mintKp = Keypair.generate();
    const mint = mintKp.publicKey.toBase58();

    // 1. Metadata (image + text) to pump.fun's IPFS.
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(input.imagePng)], { type: 'image/png' }), 'pump-coin.png');
    form.append('name', input.name);
    form.append('symbol', input.symbol);
    form.append('description', input.describe(mint));
    if (input.websiteFor) form.append('website', input.websiteFor(mint));
    form.append('showName', 'true');
    const ipfsRes = await fetch('https://pump.fun/api/ipfs', {
      method: 'POST',
      headers: PUMP_WEB_HEADERS, // no content-type: FormData sets the boundary
      body: form,
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => {
      console.warn('[pump-create] ipfs upload failed:', (err as Error).message);
      return null;
    });
    if (!ipfsRes?.ok) {
      if (ipfsRes) console.warn(`[pump-create] ipfs upload HTTP ${ipfsRes.status}`);
      throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Coin creation is temporarily unavailable — try again in a minute.');
    }
    const ipfs = (await ipfsRes.json()) as { metadataUri?: string };
    if (!ipfs.metadataUri) {
      console.warn('[pump-create] ipfs response had no metadataUri');
      throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Coin creation is temporarily unavailable — try again in a minute.');
    }

    // 2. Unsigned create tx from PumpPortal's local (self-custody) API. amount 0
    //    = no dev buy: creation is free since pump.fun moved the deploy cost to
    //    the coin's first buyer.
    const priorityFee = Number(process.env.BIDIT_PUMP_PRIORITY_FEE_SOL) || 0.0001;
    const portalRes = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...PUMP_WEB_HEADERS },
      body: JSON.stringify({
        publicKey: input.creatorWallet,
        action: 'create',
        tokenMetadata: { name: input.name, symbol: input.symbol, uri: ipfs.metadataUri },
        mint,
        denominatedInSol: 'true',
        amount: 0,
        slippage: 10,
        priorityFee,
        pool: 'pump',
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => {
      console.warn('[pump-create] pumpportal request failed:', (err as Error).message);
      return null;
    });
    if (!portalRes?.ok) {
      if (portalRes) console.warn(`[pump-create] pumpportal HTTP ${portalRes.status}: ${await portalRes.text().catch(() => '')}`);
      throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Coin creation is temporarily unavailable — try again in a minute.');
    }
    const txBytes = new Uint8Array(await portalRes.arrayBuffer());

    // 3. Vet, refresh the blockhash (the embedded one has been aging through two
    //    API round-trips — a fresh one gives the seller the full signing window),
    //    and partial-sign with the mint key.
    const tx = vetCreateTx(txBytes, input.creatorWallet);
    const { blockhash, lastValidBlockHeight } = await this.conn().getLatestBlockhash('confirmed');
    tx.message.recentBlockhash = blockhash;
    tx.sign([mintKp]);

    return {
      mint,
      metadataUri: ipfs.metadataUri,
      txB64: Buffer.from(tx.serialize()).toString('base64'),
      messageB58: bs58.encode(tx.message.serialize()),
      lastValidBlockHeight: BigInt(lastValidBlockHeight),
      requiresSignature: true,
    };
  }

  assembleSigned(attempt: { txB64: string | null; mint: string }, proof: CreatorProof | null): {
    raw: Uint8Array;
    txSig: string;
  } {
    if (!attempt.txB64 || !proof) {
      throw new PumpCreateError(400, 'BAD_SIGNATURE', 'Sign the request in your wallet first.');
    }
    return mergeCreatorSignature(attempt.txB64, proof);
  }

  async broadcast(raw: Uint8Array): Promise<void> {
    await this.conn().sendRawTransaction(Buffer.from(raw), { skipPreflight: false, maxRetries: 5 });
  }

  async getTxStatus(txSig: string, lastValidBlockHeight: bigint | null): Promise<'confirmed' | 'failed' | 'unknown'> {
    const conn = this.conn();
    const res = await conn.getSignatureStatuses([txSig], { searchTransactionHistory: true });
    const st = res.value[0];
    if (st) {
      if (st.err) return 'failed';
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'confirmed';
      return 'unknown';
    }
    // Not found: dead once the chain has moved past the blockhash's validity.
    if (lastValidBlockHeight !== null) {
      const height = await conn.getBlockHeight('confirmed');
      if (BigInt(height) > lastValidBlockHeight) return 'failed';
    }
    return 'unknown';
  }

  async currentBlockHeight(): Promise<bigint | null> {
    return BigInt(await this.conn().getBlockHeight('confirmed'));
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
