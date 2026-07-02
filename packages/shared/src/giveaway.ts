/**
 * Giveaways (Whatnot-style) — the deterministic winner-selection core.
 *
 * During a live stream a seller opens a giveaway; viewers enter with one tap.
 * Two kinds gate who may enter:
 *   - PUBLIC       any viewer watching the stream
 *   - BUYER_ONLY   only people who have purchased from this seller
 * When the entry window closes the SERVER alone draws the winner from a committed
 * random seed — the client only replays the reveal. Given the same seed and the
 * same ordered entrant list it always picks the same winner, which is what makes
 * the draw verifiable: the server commits `seedHash` when the giveaway opens and
 * reveals the raw `seed` at the draw (see the giveaway messages in protocol.ts).
 *
 * Nothing here touches wall-clock time or Math.random.
 */
import { seedFloat } from './randomizer.js';

export type GiveawayKind = 'PUBLIC' | 'BUYER_ONLY';
export type GiveawayStatus = 'OPEN' | 'DRAWING' | 'CLOSED';

/** A single entrant, as broadcast to clients for the reveal roll. */
export interface GiveawayEntrant {
  userId: string;
  handle: string;
}

/** Coerce arbitrary input into a valid giveaway kind (defaults to PUBLIC). */
export function normalizeGiveawayKind(raw: unknown): GiveawayKind {
  return raw === 'BUYER_ONLY' ? 'BUYER_ONLY' : 'PUBLIC';
}

/**
 * Pick the winning entrant index in [0, count) from a hex seed. Uniform over the
 * ordered entrant list — every entrant has exactly one slot, so odds are equal.
 */
export function pickWinnerIndex(count: number, seedHex: string): number {
  if (count <= 0) throw new Error('giveaway has no entrants');
  const i = Math.floor(seedFloat(seedHex) * count);
  return i >= count ? count - 1 : i < 0 ? 0 : i;
}

/** How many times the entrant list repeats to form the reveal roll strip. */
export const ROLL_REPEATS = 6;

/**
 * Build the reveal roll — the sequence of entrant avatars the spotlight hops
 * through before landing on the winner. The strip is the entrant list repeated
 * `repeats` times (so the hop has a long, decelerating run) with the winner
 * placed a couple of repeats deep. A pure function of (entrants, winnerIndex):
 * every client renders the identical hop and settles on the identical winner.
 */
export function buildRollOrder(
  entrants: GiveawayEntrant[],
  winnerIndex: number,
  repeats: number = ROLL_REPEATS,
): { roll: GiveawayEntrant[]; targetIndex: number } {
  if (entrants.length === 0) throw new Error('giveaway has no entrants');
  const reps = Math.max(3, repeats);
  const roll: GiveawayEntrant[] = [];
  for (let r = 0; r < reps; r++) roll.push(...entrants);
  const targetIndex = (reps - 2) * entrants.length + winnerIndex;
  return { roll, targetIndex };
}
