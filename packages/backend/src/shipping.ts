/**
 * Shipping rate estimator. Cost is a function of origin, destination, weight and
 * parcel size. We model UPS Ground *published* rates locally — a distance→zone
 * lookup (from the two postal codes) × a zone/weight rate table — then charge a
 * configurable fraction of that (default 80%, roughly a negotiated rate) as the
 * buyer's shipping fee. No external API, no keys, and it can never fail while an
 * auction is settling.
 *
 * Swap in a live carrier later by implementing ShippingRateProvider and calling
 * setRateProvider() — quoteShipping()/quoteShippingBreakdown() are unchanged.
 *
 * The rate table models UPS Ground published rates in the ORIGIN country's
 * currency (Canada quotes in CAD, US in USD). The site settles in USD, so a
 * Canadian-origin quote is converted CAD→USD (BIDIT_CAD_USD, default 0.73)
 * before anything is charged. All returned amounts are USD, as USDC micro-units
 * (bigint), consistent with the ledger.
 */

const USDC = 1_000_000n; // one dollar in micro-units

export interface ShipLocation {
  country?: string | null;
  region?: string | null;
  city?: string | null;
  postal?: string | null;
}

/** Parcel size in centimetres. Defaults to a padded card mailer. */
export interface Dimensions {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}
export const DEFAULT_DIMS: Dimensions = { lengthCm: 10, widthCm: 10, heightCm: 2 };

export interface RateQuery {
  origin: ShipLocation;
  dest: ShipLocation;
  /** Total parcel weight in grams. */
  weightGrams: number;
  dims?: Dimensions;
}

export interface ShippingRateProvider {
  /** Carrier's published (retail) quote in USDC micro-units, before our discount.
   *  Never throws — returns a sane default on bad input. */
  quote(q: RateQuery): bigint;
}

const norm = (s?: string | null) => (s ?? '').trim().toUpperCase();
const clampNum = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ---------------------------------------------------------------------------
// Geography: coarse postal-code centroids → distance → UPS-style zone.
// We only need enough resolution to pick a zone band, so a first-character
// (Canada) / first-digit (US) centroid is plenty and needs no dataset.
// ---------------------------------------------------------------------------

interface LatLng { lat: number; lng: number }

// Canadian postal districts keyed by the first letter of the postal code.
const CA_CENTROIDS: Record<string, LatLng> = {
  A: { lat: 47.56, lng: -52.71 }, // NL
  B: { lat: 44.65, lng: -63.57 }, // NS
  C: { lat: 46.24, lng: -63.13 }, // PE
  E: { lat: 45.96, lng: -66.64 }, // NB
  G: { lat: 46.81, lng: -71.21 }, // QC east
  H: { lat: 45.5, lng: -73.57 }, // QC (Montreal)
  J: { lat: 45.4, lng: -72.73 }, // QC west
  K: { lat: 45.42, lng: -75.7 }, // ON east (Ottawa)
  L: { lat: 43.65, lng: -79.68 }, // ON (GTA outer)
  M: { lat: 43.65, lng: -79.38 }, // ON (Toronto)
  N: { lat: 43.0, lng: -81.25 }, // ON southwest
  P: { lat: 46.49, lng: -81.0 }, // ON north
  R: { lat: 49.9, lng: -97.14 }, // MB
  S: { lat: 52.13, lng: -106.67 }, // SK
  T: { lat: 51.05, lng: -114.07 }, // AB (Calgary)
  V: { lat: 49.28, lng: -123.12 }, // BC (Vancouver)
  X: { lat: 62.45, lng: -114.37 }, // NT/NU
  Y: { lat: 60.72, lng: -135.06 }, // YT
};

// US ZIP regions keyed by the leading digit (national area centroids).
const US_CENTROIDS: Record<string, LatLng> = {
  '0': { lat: 42.36, lng: -71.06 }, // New England / NJ / PR
  '1': { lat: 40.44, lng: -76.5 }, // NY / PA
  '2': { lat: 38.9, lng: -77.04 }, // DC / VA / NC
  '3': { lat: 30.33, lng: -83.5 }, // SE / FL
  '4': { lat: 41.5, lng: -84.5 }, // Great Lakes
  '5': { lat: 44.9, lng: -93.2 }, // Upper Midwest
  '6': { lat: 39.1, lng: -94.6 }, // Central Plains
  '7': { lat: 32.78, lng: -96.8 }, // South Central / TX
  '8': { lat: 39.74, lng: -104.99 }, // Mountain
  '9': { lat: 37.0, lng: -120.0 }, // West / CA / Pacific
};

const COUNTRY_FALLBACK: Record<string, LatLng> = {
  CA: { lat: 51.05, lng: -114.07 }, // Calgary — the app's home base
  US: { lat: 39.83, lng: -98.58 }, // geographic center of the US
};

function centroid(loc: ShipLocation): LatLng | null {
  const country = countryCode(loc.country);
  const postal = norm(loc.postal).replace(/\s+/g, '');
  if (country === 'CA' && postal) {
    const c = CA_CENTROIDS[postal[0]!];
    if (c) return c;
  }
  if (country === 'US' && postal) {
    const c = US_CENTROIDS[postal[0]!];
    if (c) return c;
  }
  return COUNTRY_FALLBACK[country] ?? null;
}

function countryCode(country?: string | null): string {
  const c = norm(country);
  if (!c) return 'US';
  if (c === 'CANADA' || c === 'CA' || c === 'CAN') return 'CA';
  if (c === 'UNITED STATES' || c === 'USA' || c === 'US' || c === 'UNITED STATES OF AMERICA') return 'US';
  return c.slice(0, 2); // best-effort ISO-ish
}

function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** UPS-style ground zone (2 = local … 8 = coast-to-coast) from parcel distance. */
export function zoneForKm(km: number): number {
  if (km <= 80) return 2;
  if (km <= 240) return 3;
  if (km <= 480) return 4;
  if (km <= 960) return 5;
  if (km <= 1600) return 6;
  if (km <= 2800) return 7;
  return 8;
}

// ---------------------------------------------------------------------------
// Weight: billable grams scale continuously — a light card is cheaper than a
// heavy slab, with no pound floor. Dimensional weight (metric /5000 divisor)
// only applies to genuinely large parcels, which UPS bills by size; the default
// card mailer is tiny, so its actual weight is used as-is.
// ---------------------------------------------------------------------------

const G_PER_LB = 453.592;
const DIM_THRESHOLD_CM3 = 5000; // below this, bill actual weight (small parcels)

export function billableGrams(weightGrams: number, dims: Dimensions = DEFAULT_DIMS): number {
  const actual = Number.isFinite(weightGrams) && weightGrams > 0 ? weightGrams : 30; // ~a bare card
  const volCm3 = Math.max(0, dims.lengthCm) * Math.max(0, dims.widthCm) * Math.max(0, dims.heightCm);
  if (volCm3 > DIM_THRESHOLD_CM3) {
    const dimGrams = (volCm3 / 5000) * 1000; // metric dimensional weight
    return Math.max(actual, dimGrams);
  }
  return actual;
}

// ---------------------------------------------------------------------------
// UPS Ground published-rate model (approximate, in dollars). A per-zone handling
// base for a near-weightless parcel, plus a per-pound rate applied to the actual
// (continuous) weight — so at ~1 lb it lands near UPS's published 1 lb rate, and
// lighter parcels cost proportionally less. Cross-border adds an international
// multiplier + floor. Monotonic in both distance and weight.
// ---------------------------------------------------------------------------

const ZONE_BASE: Record<number, number> = { 2: 6.5, 3: 7.5, 4: 9.0, 5: 10.5, 6: 12.5, 7: 15.0, 8: 18.0 };
const ZONE_PER_LB: Record<number, number> = { 2: 5.0, 3: 6.0, 4: 7.0, 5: 8.5, 6: 10.0, 7: 12.0, 8: 14.0 };

function dollarsToMicros(d: number): bigint {
  return BigInt(Math.round(d * 1_000_000));
}

// Currency: UPS quotes in the origin country's currency. The site settles in USD,
// so convert a Canadian-origin (CAD) quote to USD. US origins are already USD.
type Currency = 'CAD' | 'USD';
function originCurrency(country?: string | null): Currency {
  return countryCode(country) === 'CA' ? 'CAD' : 'USD';
}
/** USD per 1 CAD. Override with BIDIT_CAD_USD; defaults to ~0.73. */
export function usdPerCad(): number {
  const raw = Number(process.env.BIDIT_CAD_USD ?? '');
  if (Number.isFinite(raw) && raw > 0 && raw < 5) return raw;
  return 0.73;
}
function toUsd(amount: number, cur: Currency): number {
  return cur === 'CAD' ? amount * usdPerCad() : amount;
}

export class UpsGroundRateProvider implements ShippingRateProvider {
  quote(q: RateQuery): bigint {
    const oc = countryCode(q.origin.country);
    const dc = countryCode(q.dest.country);
    const oCentroid = centroid(q.origin);
    const dCentroid = centroid(q.dest);

    const km = oCentroid && dCentroid ? haversineKm(oCentroid, dCentroid) : 1200; // unknown → mid-country
    const zone = zoneForKm(km);
    const lb = billableGrams(q.weightGrams, q.dims) / G_PER_LB;

    // Rate in the origin country's native currency (CAD for Canada, USD for US).
    let native = ZONE_BASE[zone]! + ZONE_PER_LB[zone]! * lb;
    if (oc !== dc) {
      native = Math.max(19, native * 2.2); // cross-border ≈ 2.2× with a floor
    }
    // Settle in USD: convert a Canadian-origin quote CAD→USD.
    const usd = toUsd(native, originCurrency(q.origin.country));
    return dollarsToMicros(usd);
  }
}

/**
 * Legacy zone/weight stub kept for reference/fallback. base + per-100g × a coarse
 * domestic/regional/international multiplier.
 */
export class StubRateProvider implements ShippingRateProvider {
  constructor(
    private readonly base = 4n * USDC,
    private readonly per100g = USDC / 2n,
  ) {}

  quote(q: RateQuery): bigint {
    const grams = Number.isFinite(q.weightGrams) && q.weightGrams > 0 ? q.weightGrams : 60;
    const steps = BigInt(Math.ceil(grams / 100));
    const weightCost = this.per100g * steps;
    const oc = norm(q.origin.country) || 'US';
    const dc = norm(q.dest.country) || 'US';
    let mult = 100n;
    if (oc !== dc) mult = 250n;
    else if (norm(q.origin.region) && norm(q.dest.region) && norm(q.origin.region) !== norm(q.dest.region)) mult = 130n;
    return ((this.base + weightCost) * mult) / 100n;
  }
}

/** The active provider. Reassign to plug in a real carrier later. */
export let rateProvider: ShippingRateProvider = new UpsGroundRateProvider();
export function setRateProvider(p: ShippingRateProvider): void {
  rateProvider = p;
}

/** Fraction of the carrier's published rate we actually charge (default 80%),
 *  overridable via BIDIT_SHIP_DISCOUNT_PCT. */
export function shipDiscountPct(): number {
  const raw = Number(process.env.BIDIT_SHIP_DISCOUNT_PCT ?? '');
  if (Number.isFinite(raw) && raw > 0 && raw <= 100) return raw;
  return 80;
}

function applyDiscount(retail: bigint): bigint {
  const pct = BigInt(Math.round(shipDiscountPct()));
  return (retail * pct) / 100n;
}

/** Extra handling charged per additional item in one shipment (default 3%),
 *  overridable via BIDIT_MULTI_ITEM_PCT. */
export function multiItemPct(): number {
  const s = process.env.BIDIT_MULTI_ITEM_PCT;
  if (s != null && s.trim() !== '') {
    const raw = Number(s);
    if (Number.isFinite(raw) && raw >= 0 && raw <= 100) return raw; // 0 explicitly disables it
  }
  return 3;
}

/** Bump a shipping fee by multiItemPct% for each item beyond the first. */
export function multiItemSurcharge(shippingFee: bigint, itemCount: number): bigint {
  const extra = Math.max(0, Math.floor(itemCount) - 1);
  if (extra === 0) return shippingFee;
  const bps = 10_000n + BigInt(Math.round(extra * multiItemPct() * 100)); // e.g. +3% → +300 bps each
  return (shippingFee * bps) / 10_000n;
}

export interface ShippingBreakdown {
  /** Carrier's published (retail) quote, USDC micro-units. */
  carrierRetail: bigint;
  /** Fraction of retail charged, e.g. 80. */
  discountPct: number;
  /** What the buyer is charged, USDC micro-units. */
  final: bigint;
  zone: number;
  billableGrams: number;
}

/** Full estimate for display: retail, discount and the final charged fee. */
export function quoteShippingBreakdown(
  origin: ShipLocation,
  dest: ShipLocation,
  weightGrams: number,
  dims: Dimensions = DEFAULT_DIMS,
): ShippingBreakdown {
  const retail = rateProvider.quote({ origin, dest, weightGrams, dims });
  const oCentroid = centroid(origin);
  const dCentroid = centroid(dest);
  const km = oCentroid && dCentroid ? haversineKm(oCentroid, dCentroid) : 1200;
  return {
    carrierRetail: retail,
    discountPct: shipDiscountPct(),
    final: applyDiscount(retail),
    zone: zoneForKm(km),
    billableGrams: billableGrams(weightGrams, dims),
  };
}

/** Quote shipping for a parcel of items (weights summed) — the fee we charge. */
export function quoteShipping(origin: ShipLocation, dest: ShipLocation, weightGrams: number, dims?: Dimensions): bigint {
  return applyDiscount(rateProvider.quote({ origin, dest, weightGrams, dims }));
}

/** Flat privacy premium for Private Secure Shipping (buyer pays shipping + this).
 *  Configurable via BIDIT_PRIVACY_FEE_CENTS; defaults to $4.00. */
export function privacyPremium(): bigint {
  const s = process.env.BIDIT_PRIVACY_FEE_CENTS;
  if (s != null && s.trim() !== '') {
    const cents = Number(s);
    if (Number.isFinite(cents) && cents >= 0) return (BigInt(Math.round(cents)) * USDC) / 100n;
  }
  return 4n * USDC; // default $4.00
}
