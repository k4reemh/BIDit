/**
 * The wheel-spin randomizer (deterministic core).
 *
 * A seller attaches a set of prize entries to a listing; the auction is "bid to
 * win a roll." When it closes the SERVER alone decides which slot the wheel
 * lands on — exactly like every other outcome in BIDit, the server decides and
 * the client only renders. The server then broadcasts the full reel + landing
 * index so the seller and every viewer replay the identical spin (see
 * RandomizerSpinMessage in protocol.ts).
 *
 * Nothing here touches wall-clock time or Math.random; given the same seed it
 * produces the same prize, which is what makes the spin verifiable.
 */

export interface WheelEntry {
  /** Display name of the prize, e.g. "Destined Rivals ETB". */
  label: string;
  /** Relative odds. Omitted/<=0 is treated as 1 (equal weight). */
  weight?: number;
  /** Optional rarity tier, drives the slot colour client-side. */
  tier?: string;
  /** Optional prize image, shown in the win celebration after the spin. */
  imageUrl?: string;
}

/** A single row on the scrolling reel sent to clients. */
export interface ReelSlot {
  label: string;
  tier?: string;
  imageUrl?: string;
}

/** How many times the entry list repeats to form the scrolling strip. */
export const REEL_REPEATS = 8;

// ---- seeded RNG --------------------------------------------------------------

/** Fold a hex seed string into a 32-bit integer. */
export function seedToInt(seedHex: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedHex.length; i++) {
    h ^= seedHex.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic float in [0,1) from a seed — mulberry32. */
export function seedFloat(seedHex: string): number {
  let a = seedToInt(seedHex);
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---- core --------------------------------------------------------------------

const w = (e: WheelEntry): number => (e.weight && e.weight > 0 ? e.weight : 1);

/** Pick the winning entry index from `r` in [0,1), respecting weights. */
export function weightedPick(entries: WheelEntry[], r: number): number {
  if (entries.length === 0) throw new Error('wheel has no entries');
  const total = entries.reduce((s, e) => s + w(e), 0);
  let acc = 0;
  const target = Math.min(0.999999, Math.max(0, r)) * total;
  for (let i = 0; i < entries.length; i++) {
    acc += w(entries[i]!);
    if (target < acc) return i;
  }
  return entries.length - 1;
}

/** Convenience: pick the winning entry index straight from a hex seed. */
export function pickSlot(entries: WheelEntry[], seedHex: string): number {
  return weightedPick(entries, seedFloat(seedHex));
}

/**
 * Build the scrolling reel for the chosen prize. The strip is the entry list
 * repeated `repeats` times (a uniform slot reel — weighting only biases the
 * *landing*, never the display), with the prize placed a few repeats deep so
 * the spin has a long, decelerating run before it settles.
 */
export function buildReel(
  entries: WheelEntry[],
  prizeIndex: number,
  repeats: number = REEL_REPEATS,
): { reel: ReelSlot[]; targetIndex: number } {
  if (entries.length === 0) throw new Error('wheel has no entries');
  const reps = Math.max(4, repeats);
  const reel: ReelSlot[] = [];
  for (let r = 0; r < reps; r++) {
    for (const e of entries) {
      const slot: ReelSlot = { label: e.label };
      if (e.tier) slot.tier = e.tier;
      if (e.imageUrl) slot.imageUrl = e.imageUrl;
      reel.push(slot);
    }
  }
  const targetIndex = (reps - 3) * entries.length + prizeIndex;
  return { reel, targetIndex };
}

/**
 * Validate untrusted input (a seller's wheel form / a stored JSON column) into
 * clean WheelEntry[]. Drops anything without a label and omits empty optional
 * fields entirely (no `undefined` keys) so the result is safe to store as JSON.
 */
/** Caps on a seller-controlled wheel — it's repeated REEL_REPEATS× and broadcast to
 *  every viewer, so an uncapped wheel is a realtime-DoS vector. */
export const MAX_WHEEL_ENTRIES = 64;
const MAX_WHEEL_LABEL_LEN = 120;
const MAX_WHEEL_TIER_LEN = 40;
const MAX_WHEEL_IMAGE_LEN = 2000;

export function normalizeWheelEntries(raw: unknown): WheelEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: WheelEntry[] = [];
  for (const item of raw) {
    if (out.length >= MAX_WHEEL_ENTRIES) break; // cap the wheel size
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const label = typeof e.label === 'string' ? e.label.trim().slice(0, MAX_WHEEL_LABEL_LEN) : '';
    if (!label) continue;
    const entry: WheelEntry = { label };
    if (typeof e.weight === 'number' && e.weight > 0) entry.weight = Math.min(e.weight, 1_000_000);
    if (typeof e.tier === 'string' && e.tier.trim()) entry.tier = e.tier.trim().slice(0, MAX_WHEEL_TIER_LEN);
    if (typeof e.imageUrl === 'string' && e.imageUrl.trim()) entry.imageUrl = e.imageUrl.trim().slice(0, MAX_WHEEL_IMAGE_LEN);
    out.push(entry);
  }
  return out;
}
