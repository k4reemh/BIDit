/**
 * Shipping rate seam. Cost is a function of origin, destination and weight.
 * v1 ships a simple weight×zone STUB so the whole fulfillment flow works today;
 * swap in a real carrier (EasyPost / Shippo) later by implementing
 * ShippingRateProvider and setting `rateProvider` — nothing else changes.
 *
 * All amounts are USDC micro-units (bigint), consistent with the ledger.
 */

const USDC = 1_000_000n; // one dollar in micro-units

export interface ShipLocation {
  country?: string | null;
  region?: string | null;
  city?: string | null;
  postal?: string | null;
}

export interface RateQuery {
  origin: ShipLocation;
  dest: ShipLocation;
  /** Total parcel weight in grams. */
  weightGrams: number;
}

export interface ShippingRateProvider {
  /** Quote in USDC micro-units. Never throws — returns a sane default on bad input. */
  quote(q: RateQuery): bigint;
}

const norm = (s?: string | null) => (s ?? '').trim().toUpperCase();

/**
 * Zone/weight stub:
 *   base + perStepPer100g, ×domestic|regional|international multiplier.
 * Deliberately conservative so a live quote (added later) is rarely a nasty
 * surprise. Weight defaults to a light card parcel when unset.
 */
export class StubRateProvider implements ShippingRateProvider {
  constructor(
    private readonly base = 4n * USDC, // $4.00 handling + first 100g
    private readonly per100g = USDC / 2n, // $0.50 / 100g
  ) {}

  quote(q: RateQuery): bigint {
    const grams = Number.isFinite(q.weightGrams) && q.weightGrams > 0 ? q.weightGrams : 60; // ~a sleeved card + mailer
    const steps = BigInt(Math.ceil(grams / 100));
    const weightCost = this.per100g * steps;

    const oc = norm(q.origin.country) || 'US';
    const dc = norm(q.dest.country) || 'US';
    let mult = 100n; // basis: 1.00×
    if (oc !== dc) mult = 250n; // international ~2.5×
    else if (norm(q.origin.region) && norm(q.dest.region) && norm(q.origin.region) !== norm(q.dest.region)) {
      mult = 130n; // cross-region domestic ~1.3×
    }
    return ((this.base + weightCost) * mult) / 100n;
  }
}

/** The active provider. Reassign to plug in a real carrier later. */
export let rateProvider: ShippingRateProvider = new StubRateProvider();
export function setRateProvider(p: ShippingRateProvider): void {
  rateProvider = p;
}

/** Quote shipping for a parcel of items (weights summed). */
export function quoteShipping(origin: ShipLocation, dest: ShipLocation, weightGrams: number): bigint {
  return rateProvider.quote({ origin, dest, weightGrams });
}

/** Flat privacy premium for Private Secure Shipping (buyer pays shipping + this).
 *  Configurable via BIDIT_PRIVACY_FEE_CENTS; defaults to $4.00. */
export function privacyPremium(): bigint {
  const cents = Number(process.env.BIDIT_PRIVACY_FEE_CENTS ?? '');
  if (Number.isFinite(cents) && cents >= 0) return (BigInt(Math.round(cents)) * USDC) / 100n;
  return 4n * USDC;
}
