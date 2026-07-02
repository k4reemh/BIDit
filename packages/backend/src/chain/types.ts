/**
 * The chain boundary. Everything that touches real USDC goes through this one
 * interface, so the rest of the system never knows whether it's talking to a
 * simulated chain (tests / local) or real Solana devnet.
 *
 * v1 is custodial: the backend controls pooled wallets (treasury / escrow /
 * buyback); the ledger remains the source of truth for who owns what. Amounts
 * are USDC micro-units (6dp) — same integers as the ledger, never floats.
 */
export type WalletName = 'treasury' | 'escrow' | 'buyback';

export interface DepositEvent {
  userId: string;
  amountMicros: bigint;
  /** On-chain signature — used as the idempotency key when crediting the ledger. */
  txSig: string;
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
  /** Transfer USDC from a backend wallet to an address. Returns the tx signature. */
  transfer(from: WalletName, to: string, amountMicros: bigint, memo?: string): Promise<string>;
  /** USDC balance (micro-units) of a named wallet or a raw address. */
  balance(target: WalletName | string): Promise<bigint>;
}
