/**
 * Canonical domain enums.
 *
 * These are the single source of truth for the values used across the wire
 * protocol AND the database. The Prisma schema mirrors these member names
 * exactly; `enums.drift.test.ts` in the backend fails the build if they ever
 * diverge. Keep the two in lockstep.
 *
 * Each enum is declared as a frozen const object plus a same-named type, so a
 * single import gives you both runtime values (`LedgerType.DEPOSIT`) and the
 * static union type (`function f(t: LedgerType)`).
 */

// `const T` preserves the literal value types (e.g. 'DEPOSIT' rather than
// widening to string) so the unions below match Prisma's generated enum types.
function asEnum<const T extends Record<string, string>>(o: T): Readonly<T> {
  return Object.freeze(o);
}

export const Role = asEnum({
  buyer: 'buyer',
  seller: 'seller',
  admin: 'admin',
});
export type Role = (typeof Role)[keyof typeof Role];

/** Distinguishes real user accounts from the singleton system accounts. */
export const AccountKind = asEnum({
  USER: 'USER',
  PLATFORM: 'PLATFORM',
  EXTERNAL: 'EXTERNAL',
  ESCROW: 'ESCROW',
});
export type AccountKind = (typeof AccountKind)[keyof typeof AccountKind];

/** What a ledger entry represents. Append-only; never mutated. */
export const LedgerType = asEnum({
  DEPOSIT: 'DEPOSIT',
  WITHDRAWAL: 'WITHDRAWAL',
  BID_HOLD: 'BID_HOLD',
  BID_HOLD_RELEASE: 'BID_HOLD_RELEASE',
  PURCHASE_DEBIT: 'PURCHASE_DEBIT',
  PAYOUT_CREDIT: 'PAYOUT_CREDIT',
  PLATFORM_FEE: 'PLATFORM_FEE',
  REFUND: 'REFUND',
  ESCROW_LOCK: 'ESCROW_LOCK',
  ESCROW_RELEASE: 'ESCROW_RELEASE',
});
export type LedgerType = (typeof LedgerType)[keyof typeof LedgerType];

/** What caused a ledger entry (the `refId` points at a row of this kind). */
export const LedgerRefType = asEnum({
  DEPOSIT: 'DEPOSIT',
  WITHDRAWAL: 'WITHDRAWAL',
  ORDER: 'ORDER',
  AUCTION: 'AUCTION',
  BID: 'BID',
  ADJUSTMENT: 'ADJUSTMENT',
  TRANSFER: 'TRANSFER',
  EXTERNAL: 'EXTERNAL',
});
export type LedgerRefType = (typeof LedgerRefType)[keyof typeof LedgerRefType];

export const ListingStatus = asEnum({
  DRAFT: 'DRAFT',
  QUEUED: 'QUEUED',
  LIVE: 'LIVE',
  SOLD: 'SOLD',
  UNSOLD: 'UNSOLD',
  CANCELED: 'CANCELED',
});
export type ListingStatus = (typeof ListingStatus)[keyof typeof ListingStatus];

export const AuctionStatus = asEnum({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SETTLING: 'SETTLING',
  CLOSED: 'CLOSED',
  CANCELED: 'CANCELED',
});
export type AuctionStatus = (typeof AuctionStatus)[keyof typeof AuctionStatus];

export const BidStatus = asEnum({
  ACTIVE: 'ACTIVE',
  OUTBID: 'OUTBID',
  WON: 'WON',
  LOST: 'LOST',
  VOID: 'VOID',
});
export type BidStatus = (typeof BidStatus)[keyof typeof BidStatus];

/**
 * Order lifecycle (Chunk 5 — delivery-gated escrow, Whatnot's model):
 *   PENDING_SETTLEMENT -> LOCKED -> SHIPPED -> DELIVERED -> DISPUTE_WINDOW -> RELEASED
 *                           |                                    |
 *                        CANCELED (no-ship timeout)          DISPUTED -> REFUNDED | RELEASED
 *                           v
 *                        REFUNDED
 */
export const OrderStatus = asEnum({
  PENDING_SETTLEMENT: 'PENDING_SETTLEMENT',
  LOCKED: 'LOCKED',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  DISPUTE_WINDOW: 'DISPUTE_WINDOW',
  DISPUTED: 'DISPUTED',
  RELEASED: 'RELEASED',
  REFUNDED: 'REFUNDED',
  CANCELED: 'CANCELED',
});
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/**
 * Lifecycle of a hold — funds locked because a user is the current high bidder.
 *   ACTIVE   -> currently locked (the leader's stake)
 *   RELEASED -> freed because the user was outbid (or the auction was canceled)
 *   CAPTURED -> converted into a real ledger movement at settlement (Chunk 5)
 */
export const HoldStatus = asEnum({
  ACTIVE: 'ACTIVE',
  RELEASED: 'RELEASED',
  CAPTURED: 'CAPTURED',
});
export type HoldStatus = (typeof HoldStatus)[keyof typeof HoldStatus];
