/**
 * Auction rules shared by the backend (authoritative) and, later, the extension
 * (which shows the user the minimum next bid and renders reject reasons).
 */
import { BPS_DENOMINATOR, type Micros } from './money.js';

/** Why a bid was rejected. Sent to the client so it can show a precise message. */
export const BidRejectReason = {
  AUCTION_NOT_FOUND: 'AUCTION_NOT_FOUND',
  AUCTION_ENDED: 'AUCTION_ENDED',
  BID_TOO_LOW: 'BID_TOO_LOW',
  ALREADY_LEADING: 'ALREADY_LEADING',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
} as const;
export type BidRejectReason = (typeof BidRejectReason)[keyof typeof BidRejectReason];

/** Minimum bid increment config. Default: max($1, 5% of current bid). */
export interface IncrementConfig {
  /** Absolute floor in micro-units. */
  floor: Micros;
  /** Percentage of the current bid, in basis points. */
  bps: bigint;
}

export const DEFAULT_MIN_INCREMENT_FLOOR: Micros = 1_000_000n; // $1
export const DEFAULT_MIN_INCREMENT_BPS = 500n; // 5%
export const DEFAULT_INCREMENT_CONFIG: IncrementConfig = {
  floor: DEFAULT_MIN_INCREMENT_FLOOR,
  bps: DEFAULT_MIN_INCREMENT_BPS,
};

/** Price tiers where the minimum increment steps up to a flat amount. */
export const INCREMENT_TIER_50: Micros = 50_000_000n; // >= $50
export const INCREMENT_TIER_150: Micros = 150_000_000n; // >= $150
const INCREMENT_AT_50: Micros = 2_000_000n; // $2
const INCREMENT_AT_150: Micros = 5_000_000n; // $5

/**
 * The increment required on top of the current bid. A flat ladder kicks in as
 * the price climbs so late bidding moves in meaningful steps:
 *   >= $150 -> $5,  >= $50 -> $2,  below $50 -> max($1 floor, 5%).
 */
export function minIncrement(
  currentBid: Micros,
  cfg: IncrementConfig = DEFAULT_INCREMENT_CONFIG,
): Micros {
  if (currentBid >= INCREMENT_TIER_150) return INCREMENT_AT_150;
  if (currentBid >= INCREMENT_TIER_50) return INCREMENT_AT_50;
  const pct = (currentBid * cfg.bps) / BPS_DENOMINATOR; // floor
  return pct > cfg.floor ? pct : cfg.floor;
}

/**
 * The smallest amount a new bid may be. If there are no bids yet, it's the
 * starting bid; otherwise current + increment.
 */
export function minNextBid(
  currentBid: Micros | null,
  startingBid: Micros,
  cfg: IncrementConfig = DEFAULT_INCREMENT_CONFIG,
): Micros {
  if (currentBid === null || currentBid <= 0n) return startingBid;
  return currentBid + minIncrement(currentBid, cfg);
}

/**
 * Anti-snipe (Whatnot-style, tense ending): a bid in the final 5s nudges the
 * clock but never lets it exceed 5s — so the auction is perpetually about to end.
 *   3–5s left -> +1s   ·   under 3s left -> +2s   ·   over 5s left -> no extension
 * Always capped at ANTISNIPE_MAX_MS. Returns the new remaining ms (unchanged if
 * no extension). The server is authoritative for this; the client only renders it.
 */
export const ANTISNIPE_WINDOW_MS = 5000;
export const ANTISNIPE_URGENT_MS = 3000;
export const ANTISNIPE_BUMP_MS = 1000;
export const ANTISNIPE_URGENT_BUMP_MS = 2000;
export const ANTISNIPE_MAX_MS = 5000;

export function antiSnipeRemaining(remainingMs: number): number {
  if (remainingMs > ANTISNIPE_WINDOW_MS) return remainingMs;
  const bump = remainingMs < ANTISNIPE_URGENT_MS ? ANTISNIPE_URGENT_BUMP_MS : ANTISNIPE_BUMP_MS;
  return Math.min(remainingMs + bump, ANTISNIPE_MAX_MS);
}
