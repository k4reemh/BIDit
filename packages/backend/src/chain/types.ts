/**
 * The chain boundary. Everything that touches real USDC goes through this one
 * interface, so the rest of the system never knows whether it's talking to a
 * simulated chain (tests / local) or real Solana devnet.
 *
 * v1 is custodial: the backend controls pooled wallets (treasury / escrow /
 * buyback); the ledger remains the source of truth for who owns what. Amounts
 * are USDC micro-units (6dp) — same integers as the ledger, never floats.
 */
export type WalletName = 'treasury' | 'escrow' | 'buyback' | 'fee';

export interface DepositEvent {
  userId: string;
  amountMicros: bigint;
  /** On-chain signature — used as the idempotency key when crediting the ledger. */
  txSig: string;
}

/**
 * The fate of a broadcast transfer, as the chain currently sees it:
 *  - `confirmed`: finalized on-chain — the funds moved.
 *  - `failed`: the transaction is permanently dead (it erred on-chain, or its
 *    blockhash expired without it landing). The funds did NOT move — it is safe
 *    to reverse the corresponding ledger debit.
 *  - `unknown`: still in flight / indeterminate. It may yet confirm. Callers must
 *    NOT reverse on this — doing so is exactly the double-spend bug we prevent.
 */
export type TransferStatus = 'confirmed' | 'failed' | 'unknown';

/** Result of broadcasting a transfer (before it is confirmed). */
export interface SendResult {
  /** The transaction signature — known as soon as the tx is signed, so it is
   *  returned even if the network send ack is lost (the tx may still land). */
  sig: string;
  /** Block height after which the signature can never land (Solana blockhash
   *  expiry). Null for chains without the concept; the caller stores it to later
   *  decide, via getTransferStatus, whether a not-yet-seen tx is dead or pending. */
  lastValidBlockHeight: bigint | null;
}

export interface ChainClient {
  /** Network label. Used for display + a guard against accidental mainnet. */
  readonly cluster: 'mock' | 'devnet' | 'mainnet-beta';
  /** Address of a backend-controlled wallet. */
  walletAddress(name: WalletName): string;
  /** Stable per-user USDC deposit address (derived; the caller persists it). */
  depositAddress(userId: string): Promise<string>;
  /** Confirmed inbound USDC since `cursor`. Returns events + the next cursor. */
  pollDeposits(cursor: string | null): Promise<{ events: DepositEvent[]; cursor: string | null }>;
  /** Transfer USDC from a backend wallet to an address. Returns the tx signature
   *  only after it confirms. Fine for internal moves (sweeps, escrow) where an
   *  ambiguous timeout is recoverable; the WITHDRAWAL path uses the split
   *  sendTransfer + getTransferStatus below so it can settle durably instead. */
  transfer(from: WalletName, to: string, amountMicros: bigint, memo?: string): Promise<string>;
  /**
   * Broadcast a transfer and return its signature WITHOUT waiting for
   * confirmation. Contract: throws ONLY on pre-broadcast failures (fetching the
   * blockhash, building or signing the tx) — in which case the funds definitively
   * did NOT move. Once the tx is signed the signature is known, so it is returned
   * even if the network send itself times out (the tx may still land). The caller
   * persists `sig`/`lastValidBlockHeight`, then resolves the fate via
   * getTransferStatus — never by assuming a thrown/timed-out send means failure.
   */
  sendTransfer(from: WalletName, to: string, amountMicros: bigint, memo?: string): Promise<SendResult>;
  /** The current fate of a previously-broadcast signature. `lastValidBlockHeight`
   *  (from the SendResult) lets a not-yet-seen tx be judged dead vs still-pending. */
  getTransferStatus(sig: string, lastValidBlockHeight?: bigint | null): Promise<TransferStatus>;
  /** True if `address` is a well-formed destination for this chain (checked before
   *  any withdrawal is recorded, so funds never target a malformed address). */
  isValidAddress(address: string): boolean;
  /** USDC balance (micro-units) of a named wallet or a raw address. */
  balance(target: WalletName | string): Promise<bigint>;
}
