/**
 * The realtime wire protocol (Chunk 3).
 *
 * Conventions on the wire:
 *  - Money is a human USDC decimal string ("11.5"), produced by formatUsdc and
 *    parsed by usdc. No bigints cross the wire.
 *  - Timestamps are epoch milliseconds (numbers). Every state-changing server
 *    message carries `serverNow` so a client can correct for clock skew:
 *      offset    = serverNow - Date.now()        // measured once per message
 *      remaining = endsAt - (Date.now() + offset)
 *  - All server messages are authoritative. The client renders; it never decides.
 */
import { BidRejectReason } from './auction.js';
import type { ReelSlot, WheelEntry } from './randomizer.js';
import type { GiveawayKind, GiveawayEntrant } from './giveaway.js';

// --------------------------------------------------------------------------
// Client -> server
// --------------------------------------------------------------------------

export const ClientMessageType = {
  SUBSCRIBE: 'SUBSCRIBE',
  UNSUBSCRIBE: 'UNSUBSCRIBE',
  BID_INTENT: 'BID_INTENT',
  GIVEAWAY_ENTER: 'GIVEAWAY_ENTER',
} as const;
export type ClientMessageType = (typeof ClientMessageType)[keyof typeof ClientMessageType];

export interface SubscribeMessage {
  type: 'SUBSCRIBE';
  room: string;
}
export interface UnsubscribeMessage {
  type: 'UNSUBSCRIBE';
  room: string;
}
export interface BidIntentMessage {
  type: 'BID_INTENT';
  auctionId: string;
  /** Human USDC decimal string, e.g. "12.5". */
  amount: string;
  /** Opaque client id echoed back in BID_REJECTED so the client can match it. */
  clientNonce: string;
}
/** A viewer taps "Enter" on a live giveaway. Eligibility is checked server-side. */
export interface GiveawayEnterMessage {
  type: 'GIVEAWAY_ENTER';
  giveawayId: string;
}
export type ClientMessage =
  | SubscribeMessage
  | UnsubscribeMessage
  | BidIntentMessage
  | GiveawayEnterMessage;

// --------------------------------------------------------------------------
// Server -> client (all authoritative)
// --------------------------------------------------------------------------

export const ServerMessageType = {
  AUCTION_STATE: 'AUCTION_STATE',
  BID_ACCEPTED: 'BID_ACCEPTED',
  BID_REJECTED: 'BID_REJECTED',
  AUCTION_CLOSED: 'AUCTION_CLOSED',
  RANDOMIZER_SPIN: 'RANDOMIZER_SPIN',
  GIVEAWAY_OPEN: 'GIVEAWAY_OPEN',
  GIVEAWAY_ENTRIES: 'GIVEAWAY_ENTRIES',
  GIVEAWAY_REJECTED: 'GIVEAWAY_REJECTED',
  GIVEAWAY_WINNER: 'GIVEAWAY_WINNER',
  BALANCE_UPDATE: 'BALANCE_UPDATE',
  ERROR: 'ERROR',
} as const;
export type ServerMessageType = (typeof ServerMessageType)[keyof typeof ServerMessageType];

/** Reasons a bid can be turned down — drives client UX. Superset of the Chunk 2
 *  pipeline reasons plus transport-level ones. */
export const RealtimeRejectReason = {
  ...BidRejectReason,
  RATE_LIMITED: 'RATE_LIMITED',
} as const;
export type RealtimeRejectReason =
  (typeof RealtimeRejectReason)[keyof typeof RealtimeRejectReason];

/** Full snapshot. Sent on join and on every change. */
export interface AuctionStateMessage {
  type: 'AUCTION_STATE';
  room: string;
  auctionId: string;
  /** The listing behind this auction — lets the client fetch a shipping estimate. */
  listingId: string;
  /** The item being auctioned, for the panel's current-item card. */
  title: string;
  imageUrl: string | null;
  status: string;
  currentBid: string | null;
  leaderHandle: string | null;
  minNextBid: string;
  /** Nominal auction length (seconds) — lets the client draw a countdown bar. */
  durationSeconds: number;
  endsAt: number | null;
  /** When this is a randomizer, the prize pool (label + quantity), so bidders can
   *  see what's on the wheel before bidding. Absent for a normal auction. */
  wheel?: WheelEntry[];
  serverNow: number;
}
/** Broadcast to the room when a bid is accepted. */
export interface BidAcceptedMessage {
  type: 'BID_ACCEPTED';
  room: string;
  auctionId: string;
  amount: string;
  leaderHandle: string;
  /** True when this bid pushed the deadline forward (anti-snipe) — drives the "EXTENDED!" flash. */
  extended: boolean;
  endsAt: number | null;
  serverNow: number;
}
/** Sent only to the bidder whose intent failed. */
export interface BidRejectedMessage {
  type: 'BID_REJECTED';
  auctionId: string;
  clientNonce: string;
  reason: RealtimeRejectReason;
}
export interface AuctionClosedMessage {
  type: 'AUCTION_CLOSED';
  room: string;
  auctionId: string;
  winnerHandle: string | null;
  amount: string | null;
  /** True when a wheel spin will decide the prize — the client should defer the
   *  win celebration and wait for the RANDOMIZER_SPIN that follows. */
  wheel?: boolean;
  /** True when this is a catch-up replay sent to a (re)subscribing client that
   *  missed the live close (e.g. a dropped socket). The client should sync the
   *  result quietly — surface the winner, but skip the full-screen celebration. */
  replay?: boolean;
  serverNow: number;
}
/**
 * Fired right after an auction with a wheel closes. Carries the entire reel and
 * the landing index the server picked, so every client renders the identical
 * decelerating spin and lands on the same prize. The animation is a pure
 * function of (reel, targetIndex, durationMs, startsAt) — a late joiner computes
 * its position from `startsAt` and still lands together with everyone else.
 */
export interface RandomizerSpinMessage {
  type: 'RANDOMIZER_SPIN';
  room: string;
  auctionId: string;
  /** Who won the roll (the auction's winning bidder). */
  winnerHandle: string;
  /** Winning bid amount, for the celebration that follows the spin. */
  amount: string;
  /** The full scrolling strip the client renders. */
  reel: ReelSlot[];
  /** Which reel index lands in the centre band — i.e. the prize. */
  targetIndex: number;
  /** How long the spin animation runs. */
  durationMs: number;
  /** Epoch ms the spin starts; clients sync their position to this. */
  startsAt: number;
  /** sha256 of the server seed, published for provable fairness. */
  seedHash: string;
  serverNow: number;
}
// ---- giveaways -----------------------------------------------------------

/**
 * Broadcast to the room when a seller opens a giveaway. Viewers see the entry
 * card with a live countdown to `closesAt`; those eligible can tap to enter.
 * `seedHash` is committed here and the raw seed is revealed in GIVEAWAY_WINNER.
 */
export interface GiveawayOpenMessage {
  type: 'GIVEAWAY_OPEN';
  room: string;
  giveawayId: string;
  kind: GiveawayKind;
  /** Human name of the prize being given away. */
  prize: string;
  /** Optional prize photo (data URL or https). */
  image?: string | null;
  sellerHandle: string;
  opensAt: number;
  closesAt: number;
  entrantCount: number;
  seedHash: string;
  serverNow: number;
}
/** Live entrant tally + a sample of recent entrants for the avatar pile. */
export interface GiveawayEntriesMessage {
  type: 'GIVEAWAY_ENTRIES';
  room: string;
  giveawayId: string;
  count: number;
  /** Most-recent entrants (capped), newest first — drives the flying avatars. */
  recent: GiveawayEntrant[];
  serverNow: number;
}
/** Sent only to the entrant whose GIVEAWAY_ENTER could not be accepted. */
export interface GiveawayRejectedMessage {
  type: 'GIVEAWAY_REJECTED';
  giveawayId: string;
  reason: 'NOT_ELIGIBLE' | 'CLOSED' | 'NOT_OPEN';
}
/**
 * The draw result. Like RANDOMIZER_SPIN, it carries the full reveal roll + the
 * landing index + timing so every client replays the identical decelerating hop
 * and lands on the same winner. `seed` is revealed here so anyone can verify it
 * hashes to the `seedHash` committed at open and reproduces `winnerUserId`.
 */
export interface GiveawayWinnerMessage {
  type: 'GIVEAWAY_WINNER';
  room: string;
  giveawayId: string;
  kind: GiveawayKind;
  prize: string;
  image?: string | null;
  winnerHandle: string;
  winnerUserId: string;
  entrantCount: number;
  /** The full roll strip the client hops through. */
  roll: GiveawayEntrant[];
  /** Which roll index settles under the spotlight — i.e. the winner. */
  targetIndex: number;
  durationMs: number;
  /** Epoch ms the reveal starts; clients sync their position to this. */
  startsAt: number;
  /** Revealed server seed + its committed hash, for provable fairness. */
  seed: string;
  seedHash: string;
  serverNow: number;
}

/** Sent to a user when their holds/balance change. */
export interface BalanceUpdateMessage {
  type: 'BALANCE_UPDATE';
  available: string;
  settled: string;
}
export interface ErrorMessage {
  type: 'ERROR';
  message: string;
}
export type ServerMessage =
  | AuctionStateMessage
  | BidAcceptedMessage
  | BidRejectedMessage
  | AuctionClosedMessage
  | RandomizerSpinMessage
  | GiveawayOpenMessage
  | GiveawayEntriesMessage
  | GiveawayRejectedMessage
  | GiveawayWinnerMessage
  | BalanceUpdateMessage
  | ErrorMessage;

// --------------------------------------------------------------------------
// Channel helpers (bus fan-out keys) — shared so server instances agree.
// --------------------------------------------------------------------------

export const roomChannel = (room: string): string => `room:${room}`;
export const userChannel = (userId: string): string => `user:${userId}`;

/** Minimal structural validation of an inbound client message. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case ClientMessageType.SUBSCRIBE:
    case ClientMessageType.UNSUBSCRIBE:
      return typeof m.room === 'string' ? ({ type: m.type, room: m.room } as ClientMessage) : null;
    case ClientMessageType.BID_INTENT:
      return typeof m.auctionId === 'string' &&
        typeof m.amount === 'string' &&
        typeof m.clientNonce === 'string'
        ? { type: 'BID_INTENT', auctionId: m.auctionId, amount: m.amount, clientNonce: m.clientNonce }
        : null;
    case ClientMessageType.GIVEAWAY_ENTER:
      return typeof m.giveawayId === 'string'
        ? { type: 'GIVEAWAY_ENTER', giveawayId: m.giveawayId }
        : null;
    default:
      return null;
  }
}
