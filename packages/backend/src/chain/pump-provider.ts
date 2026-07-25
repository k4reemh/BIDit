/**
 * Pump.fun coin-creation provider seam.
 *
 * BIDit auto-creates a seller's livestream coin ("<handle>'s BIDit Livestream")
 * with the SELLER as creator — pump.fun only offers "Start livestream" to the
 * coin's creator, so the coin must be theirs, not ours. Two shapes exist, and
 * they are different enough that the type is a union rather than one interface
 * with optional halves:
 *
 *  - kind 'offchain' (DEFAULT on mainnet) — mirrors what pump.fun's own /create
 *    page does for a 0-SOL launch: sign in with the wallet, upload metadata to
 *    their IPFS, POST the coin. No transaction, no chain, no fee, and the wallet
 *    prompt is a plain message signature, so no "this dApp may be malicious"
 *    warning. The coin lives on pump.fun until its first buyer pays to deploy it
 *    — which is all a stream-only coin ever needs.
 *
 *  - kind 'tx' — builds a real on-chain create transaction the seller signs.
 *    Costs dust in network fees and makes wallets show the third-party-tx
 *    warning, so it is NOT selected automatically any more; it stays available
 *    behind BIDIT_PUMP_PROVIDER=pumpportal as an escape hatch.
 *
 * Implementations: MockPumpCreateProvider / MockOffchainProvider (dev, test,
 * preview — no network), PumpOffchainProvider, PumpPortalProvider.
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
      | 'CREATE_FAILED'
      | 'PROVIDER_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'PumpCreateError';
  }
}

/** What the browser must put in front of the wallet, if anything.
 *  'message' is the cheap, warning-free prompt; 'transaction' is the on-chain one. */
export type SignMode = 'none' | 'message' | 'transaction';

export interface PreparedCreate {
  /** Base58 mint pubkey. Null for off-chain creates: pump.fun assigns it. */
  mint: string | null;
  /** Metadata URI uploaded to pump.fun's IPFS (null until create, or in mock). */
  metadataUri: string | null;
  /** Serialized create tx, partially signed by the mint key (base64; tx kind only). */
  txB64: string | null;
  /** Base58 of the tx message bytes — exactly what the creator wallet signs. */
  messageB58: string | null;
  /** Blockhash expiry height captured when the tx was (re)built. */
  lastValidBlockHeight: bigint | null;
  /** Plain text the wallet signs to prove wallet ownership to pump.fun. */
  loginMessage: string | null;
  /** The ms timestamp baked into loginMessage, so the server can rebuild it. */
  loginTimestamp: bigint | null;
  signMode: SignMode;
}

/** The creator's signature, in one of two shapes: the raw ed25519 signature over
 *  the tx message (primary — the browser never parses the tx), or a fully signed
 *  serialized tx (fallback lane for wallet APIs that only return whole txs). */
export type CreatorProof =
  | { publicKey: string; signatureB58: string }
  | { signedTxB64: string };

export interface CreateInput {
  /** Base58 wallet that signs — as creator/fee-payer (tx) or as the pump.fun
   *  account the coin is created under (off-chain). Null in mock mode. */
  creatorWallet: string | null;
  name: string;
  symbol: string;
  /** Built per-mint because the coin's description links to its own watch page.
   *  Off-chain creates don't know the mint yet, so they pass ''. */
  describe: (mint: string) => string;
  /** The metadata's website field — also per-mint (the coin's watch URL). */
  websiteFor?: (mint: string) => string;
  imagePng: Buffer | null;
}

interface BaseCreateProvider {
  prepareCreate(input: CreateInput): Promise<PreparedCreate>;
}

/** On-chain: the seller signs a real create transaction we build and vet. */
export interface TxCreateProvider extends BaseCreateProvider {
  readonly kind: 'tx';
  readonly mode: 'pumpportal' | 'mock';
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

/** The seller's proof that they hold the wallet: an ed25519 signature over
 *  pump.fun's sign-in text. It grants a pump.fun session for that wallet, so it
 *  is handled like a credential — used once, in memory, never stored or logged. */
export interface LoginProof {
  publicKey: string;
  signature: Uint8Array;
  timestamp: bigint;
}

/** Off-chain: no transaction at all — sign in as the seller and POST the coin. */
export interface OffchainCreateProvider extends BaseCreateProvider {
  readonly kind: 'offchain';
  readonly mode: 'offchain' | 'mock-offchain';
  /** Do the whole create in one shot. Throwing leaves nothing created (except in
   *  the rare ack-loss case, which surfaces to the seller as "check pump.fun"). */
  complete(input: CreateInput & { login: LoginProof }): Promise<{ mint: string; metadataUri: string | null }>;
}

export type PumpCreateProvider = TxCreateProvider | OffchainCreateProvider;

// ---------------------------------------------------------------------------
// Mock — dev/test/preview. No chain, no Phantom: prepare returns a deterministic
// fake mint and submit "confirms" immediately, so the whole onboarding flow is
// end-to-end testable with the embedded Postgres alone.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import bs58 from 'bs58';

/** Deterministic per (label, n): sha256 → 32 bytes → base58 (43-44 chars,
 *  alphanumeric) — passes the same shape checks as a real mint. */
function fakeMint(label: string, n: number): string {
  return bs58.encode(createHash('sha256').update(`pumpmock:${label}:${n}`).digest());
}

export class MockPumpCreateProvider implements TxCreateProvider {
  readonly kind = 'tx' as const;
  readonly mode = 'mock' as const;

  private failPrepare = false;
  private expirePrepare = false;
  private ambiguousSubmit = false;
  private fates = new Map<string, 'confirmed' | 'failed' | 'unknown'>();
  private counter = 0;
  /** How many times broadcast() actually ran — the duplicate-submit race test
   *  asserts this stays at 1 no matter how many submits race. */
  broadcasts = 0;

  async prepareCreate(input: CreateInput): Promise<PreparedCreate> {
    if (this.failPrepare) {
      this.failPrepare = false;
      throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Coin creation is temporarily unavailable — try again in a minute.');
    }
    this.counter += 1;
    const mint = fakeMint(`${input.name}:${input.creatorWallet ?? ''}`, this.counter);
    void input.describe(mint); // exercised so tests catch a broken template
    const expired = this.expirePrepare;
    this.expirePrepare = false;
    return {
      mint,
      metadataUri: null,
      txB64: null,
      messageB58: null,
      loginMessage: null,
      loginTimestamp: null,
      // 1n with a current height of 1_000n → the submit expiry pre-check trips.
      lastValidBlockHeight: expired ? 1n : null,
      signMode: 'none',
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

/** The exact text pump.fun's front-end asks a wallet to sign for /auth/login.
 *  Verified byte-for-byte against a real capture — the signature from a live
 *  pump.fun sign-in validates against this string and no variant of it. */
export const pumpLoginMessage = (timestampMs: bigint | number): string =>
  `Sign in to pump.fun: ${timestampMs}`;

/** Off-chain mock: exercises the real state machine (login proof → create →
 *  linked coin) with no network, so preview and the test suite cover the path
 *  that actually ships. */
export class MockOffchainProvider implements OffchainCreateProvider {
  readonly kind = 'offchain' as const;
  readonly mode = 'mock-offchain' as const;

  private failPrepare = false;
  private failComplete: string | null = null;
  private counter = 0;
  /** How many creates actually reached pump.fun — the duplicate-submit test
   *  asserts this stays at 1 however many submits race. */
  creates = 0;

  async prepareCreate(input: CreateInput): Promise<PreparedCreate> {
    if (this.failPrepare) {
      this.failPrepare = false;
      throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Coin creation is temporarily unavailable — try again in a minute.');
    }
    const timestamp = BigInt(Date.now());
    return {
      mint: null,
      metadataUri: null,
      txB64: null,
      messageB58: null,
      loginMessage: pumpLoginMessage(timestamp),
      loginTimestamp: timestamp,
      lastValidBlockHeight: null,
      signMode: input.creatorWallet ? 'message' : 'none',
    };
  }

  async complete(input: CreateInput & { login: LoginProof }): Promise<{ mint: string; metadataUri: string | null }> {
    if (this.failComplete) {
      const msg = this.failComplete;
      this.failComplete = null;
      throw new PumpCreateError(502, 'CREATE_FAILED', msg);
    }
    this.creates += 1;
    this.counter += 1;
    const mint = fakeMint(`${input.name}:${input.login.publicKey}`, this.counter);
    void input.describe(mint);
    return { mint, metadataUri: `https://ipfs.io/ipfs/mock-${this.counter}` };
  }

  // ---- test knobs ---------------------------------------------------------

  failNextPrepare(): void {
    this.failPrepare = true;
  }

  /** Next complete() throws CREATE_FAILED (pump.fun rejected / unreachable). */
  failNextComplete(message = 'pump.fun rejected the coin.'): void {
    this.failComplete = message;
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

export class PumpPortalProvider implements TxCreateProvider {
  readonly kind = 'tx' as const;
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

  async prepareCreate(input: CreateInput): Promise<PreparedCreate> {
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
      loginMessage: null,
      loginTimestamp: null,
      lastValidBlockHeight: BigInt(lastValidBlockHeight),
      signMode: 'transaction',
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

// ---------------------------------------------------------------------------
// Off-chain — the default. Replays exactly what pump.fun's own /create page does
// for a 0-SOL launch, on the seller's behalf:
//
//   1. POST  frontend-api-v3/auth/login  {address, signature, timestamp}
//            signature = ed25519 over `Sign in to pump.fun: <timestamp>`.
//            → session cookie(s), which we hold in memory for this call only.
//   2. POST  frontend-api-v3/users/register {address}   (no-op if known)
//   3. GET   pump.fun/api/ipfs-presign  ×2 → 60-second Pinata upload URLs
//   4. POST  each presigned URL (multipart `file`) → {data:{cid}}
//            image first, then the metadata JSON that references it.
//   5. POST  frontend-api-v3/coins/create-v2 {name, ticker, …, metadataUri,
//            image} → 201 {mint}
//
// No transaction, no gas, no wallet warning. The coin is listed on pump.fun and
// streamable immediately; it only touches the chain when a first buyer deploys
// it. Every call is server-side (Cloudflare-fronted, browser-shaped headers).
// ---------------------------------------------------------------------------

const PUMP_API = 'https://frontend-api-v3.pump.fun';
/** pump.fun serves its own IPFS gateway links from ipfs.io. */
const IPFS_GATEWAY = 'https://ipfs.io/ipfs';
const CALL_TIMEOUT_MS = 15_000;

/** Collect Set-Cookie from a response into a jar we replay on later calls.
 *  Deliberately opaque: we never parse, log, or persist the values — pump.fun's
 *  session cookie is a credential for the seller's account, alive only for the
 *  few seconds this create takes. */
class CookieJar {
  private jar = new Map<string, string>();

  absorb(res: Response): void {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const pair = line.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  get size(): number {
    return this.jar.size;
  }

  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export class PumpOffchainProvider implements OffchainCreateProvider {
  readonly kind = 'offchain' as const;
  readonly mode = 'offchain' as const;

  async prepareCreate(input: CreateInput): Promise<PreparedCreate> {
    if (!input.creatorWallet) {
      throw new PumpCreateError(400, 'BAD_WALLET', 'Connect a Solana wallet to create your coin.');
    }
    // Nothing to build yet: the seller signs a sign-in message, and the coin is
    // created in one shot at submit. Fresh timestamp per attempt — pump.fun
    // rejects stale sign-ins, and a fresh prepare precedes every signature.
    const timestamp = BigInt(Date.now());
    return {
      mint: null,
      metadataUri: null,
      txB64: null,
      messageB58: null,
      loginMessage: pumpLoginMessage(timestamp),
      loginTimestamp: timestamp,
      lastValidBlockHeight: null,
      signMode: 'message',
    };
  }

  private async call(url: string, init: RequestInit & { jar?: CookieJar; label: string }): Promise<Response> {
    const { jar, label, ...rest } = init;
    const headers: Record<string, string> = {
      ...PUMP_WEB_HEADERS,
      accept: 'application/json',
      ...((rest.headers as Record<string, string>) ?? {}),
    };
    if (jar && jar.size > 0) headers.cookie = jar.header();
    const res = await fetch(url, {
      ...rest,
      headers,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    }).catch((err: Error) => {
      console.warn(`[pump-create] ${label} request failed: ${err.message}`);
      return null;
    });
    if (!res) {
      throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Could not reach pump.fun — try again in a minute.');
    }
    return res;
  }

  /** Upload one blob through a fresh presigned Pinata URL; returns its CID. */
  private async uploadToIpfs(body: Blob, filename: string, jar: CookieJar): Promise<string> {
    const presignRes = await this.call('https://pump.fun/api/ipfs-presign', {
      label: 'ipfs-presign',
      headers: { referer: 'https://pump.fun/create' },
      jar,
    });
    if (!presignRes.ok) {
      console.warn(`[pump-create] ipfs-presign HTTP ${presignRes.status}`);
      throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Could not reach pump.fun — try again in a minute.');
    }
    const presign = (await presignRes.json().catch(() => ({}))) as { data?: string };
    // The presigned URL is short-lived (60s) and single-purpose — no secret of
    // ours, but no reason to log it either.
    if (!presign.data) {
      console.warn('[pump-create] ipfs-presign response had no upload URL');
      throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Could not reach pump.fun — try again in a minute.');
    }
    const form = new FormData();
    form.append('file', body, filename);
    const upRes = await this.call(presign.data, { method: 'POST', body: form, label: 'ipfs-upload' });
    if (!upRes.ok) {
      console.warn(`[pump-create] ipfs upload HTTP ${upRes.status}`);
      throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Could not upload your coin image — try again in a minute.');
    }
    const up = (await upRes.json().catch(() => ({}))) as { data?: { cid?: string } };
    if (!up.data?.cid) {
      console.warn('[pump-create] ipfs upload response had no cid');
      throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Could not upload your coin image — try again in a minute.');
    }
    return up.data.cid;
  }

  async complete(input: CreateInput & { login: LoginProof }): Promise<{ mint: string; metadataUri: string | null }> {
    const wallet = input.login.publicKey;
    if (!input.imagePng) {
      console.warn('[pump-create] assets/pump-coin.png missing — cannot build metadata');
      throw new PumpCreateError(502, 'PROVIDER_UNAVAILABLE', 'Coin creation is temporarily unavailable.');
    }
    const jar = new CookieJar();

    // 1. Sign in as the seller. The signature is theirs, single-use, and dies
    //    with this request — the session it buys never leaves this function.
    const loginRes = await this.call(`${PUMP_API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: wallet,
        signature: bs58.encode(input.login.signature),
        timestamp: Number(input.login.timestamp),
      }),
      label: 'auth/login',
      jar,
    });
    if (!loginRes.ok) {
      console.warn(`[pump-create] auth/login HTTP ${loginRes.status}`);
      throw new PumpCreateError(
        502,
        'CREATE_FAILED',
        'pump.fun would not accept the sign-in for this wallet — try again in a few minutes.',
      );
    }
    jar.absorb(loginRes);
    if (jar.size === 0) {
      // No cookie means every later call is anonymous and create-v2 will 401.
      console.warn('[pump-create] auth/login returned no session cookie');
      throw new PumpCreateError(
        502,
        'CREATE_FAILED',
        'pump.fun did not start a session for this wallet — try again in a few minutes.',
      );
    }

    // 2. Register the wallet as a pump.fun user (already-known wallets 4xx here;
    //    harmless either way, so failures are not fatal).
    const reg = await this.call(`${PUMP_API}/users/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: wallet }),
      label: 'users/register',
      jar,
    }).catch(() => null);
    if (reg) jar.absorb(reg);

    // 3-4. Image, then the metadata JSON that points at it.
    const imageCid = await this.uploadToIpfs(
      new Blob([new Uint8Array(input.imagePng)], { type: 'image/png' }),
      'pump-coin.png',
      jar,
    );
    const image = `${IPFS_GATEWAY}/${imageCid}`;
    const website = input.websiteFor?.('') ?? '';
    const metadata = {
      name: input.name,
      symbol: input.symbol,
      description: input.describe(''),
      image,
      showName: true,
      website,
      twitter: '',
      telegram: '',
      createdOn: 'https://pump.fun',
    };
    const metadataCid = await this.uploadToIpfs(
      new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
      'metadata.json',
      jar,
    );
    const metadataUri = `${IPFS_GATEWAY}/${metadataCid}`;

    // 5. Create the coin. 201 → it exists on pump.fun and is streamable now.
    const createRes = await this.call(`${PUMP_API}/coins/create-v2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: input.name,
        ticker: input.symbol,
        description: metadata.description,
        twitter: '',
        telegram: '',
        website,
        showName: true,
        metadataUri,
        image,
        cashback: false,
        tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      }),
      label: 'coins/create-v2',
      jar,
    });
    if (!createRes.ok) {
      const detail = await createRes.text().catch(() => '');
      console.warn(`[pump-create] create-v2 HTTP ${createRes.status}: ${detail.slice(0, 300)}`);
      throw new PumpCreateError(
        502,
        'CREATE_FAILED',
        createRes.status === 429
          ? 'pump.fun is rate-limiting new coins right now — try again in a few minutes.'
          : 'pump.fun would not create the coin right now — try again in a few minutes.',
      );
    }
    const created = (await createRes.json().catch(() => ({}))) as { mint?: string; address?: string };
    const mint = created.mint ?? created.address;
    if (!mint) {
      // Created but unreadable: say so honestly rather than silently retrying,
      // which would risk a duplicate coin.
      console.warn('[pump-create] create-v2 succeeded but returned no mint');
      throw new PumpCreateError(
        502,
        'CREATE_FAILED',
        'pump.fun created the coin but did not return its address — check your pump.fun profile and paste it in Settings.',
      );
    }
    return { mint, metadataUri };
  }
}

/** Pick the provider for this deployment.
 *
 *  Mainnet defaults to the off-chain path: free, no wallet warning, and the only
 *  one sellers should ever see. Everything else (mock cluster, devnet, tests,
 *  preview) gets a mock. `BIDIT_PUMP_PROVIDER` forces one for spikes —
 *  `pumpportal` is the on-chain escape hatch, kept only for that. */
export function getPumpCreateProvider(cluster: string): PumpCreateProvider {
  const forced = (process.env.BIDIT_PUMP_PROVIDER ?? '').trim().toLowerCase();
  if (forced === 'mock') return new MockPumpCreateProvider();
  if (forced === 'mock-offchain') return new MockOffchainProvider();
  if (forced === 'pumpportal') return new PumpPortalProvider();
  if (forced === 'offchain') return new PumpOffchainProvider();
  return cluster === 'mainnet-beta' ? new PumpOffchainProvider() : new MockOffchainProvider();
}
