/**
 * The "~$13.25 est. shipping" number on the bid panel.
 *
 * This is DISPLAY ONLY. What a buyer actually pays is a live carrier quote at
 * ship time; this exists so someone deciding whether to bid knows roughly what
 * the card will cost delivered. Being a few dollars off is fine. Being slow,
 * failing, or needing a network call is not: it renders for every viewer on
 * every item, and a live room can hold a thousand of them.
 *
 * So it is arithmetic:
 *
 *   BASE + DISTANCE[zone] + CROSS_BORDER + PER_KG[zone] x kg + PACKAGE[class]
 *
 * Purely additive, ~15 constants, no multiplier that can compound a small
 * modelling error into a wild number. It replaced a zone/per-pound model whose
 * cross-border multiplier quoted $22.67 to post a single card from Calgary to
 * Seattle, and $189 for a 5kg box, on lanes where the real prices are roughly
 * $10 and $60. Over-quoting shipping suppresses bids, so those errors were not
 * free.
 *
 * Error is deliberately one-sided: unknown inputs resolve to the more expensive
 * assumption and the total rounds UP. A buyer quoted ~$13.25 who pays $12.80 is
 * happy; the reverse writes to support.
 */
import type { ShipLocation } from './shipping.js';
import { countryCode } from './shipping.js';
import { packageClass, findParcelPreset, defaultParcel, type PackageClass, type ParcelDims } from '@bidit/shared';

const USDC = 1_000_000n;

// ---------------------------------------------------------------------------
// Constants. Reverse-fitted from published Canada Post / UPS prices on the lanes
// BIDit actually sells on. Tune them here; test/ship-estimate.test.ts pins the
// headline lanes so a change to these shows up as an intentional diff.
// ---------------------------------------------------------------------------

const BASE = 5.0;

/** Zone 1 same metro, 5 opposite corner. */
const DISTANCE: Record<number, number> = { 1: 0.5, 2: 2.0, 3: 3.5, 4: 4.5, 5: 5.5 };

/** Customs handling, paperwork and the international service step-up. Flat, and
 *  separate from distance: Calgary to Miami is far AND cross-border, and folding
 *  those into one axis makes that lane ambiguous. */
const CROSS_BORDER = 3.0;

/** Per kilogram, by zone: weight costs more the further it travels. Linear on
 *  purpose. Banded weight would put a $3 cliff between 499g and 501g. */
const PER_KG: Record<number, number> = { 1: 4.0, 2: 5.0, 3: 5.5, 4: 6.5, 5: 7.0 };

const PACKAGE: Record<PackageClass, number> = {
  polymailer: 0,
  small_box: 4.0,
  large_box: 8.0,
};

/** Distance bands in km. */
function zoneForKm(km: number): number {
  if (km <= 150) return 1;
  if (km <= 800) return 2;
  if (km <= 1800) return 3;
  if (km <= 3200) return 4;
  return 5;
}

/** Where an address we cannot place lands. Deliberately mid-far rather than
 *  zone 1: an unrecognised region must never quote as a local delivery. */
const UNKNOWN_ZONE = 4;

// ---------------------------------------------------------------------------
// Geography
//
// Approximate POPULATION centroids, one per state and province, weighted toward
// the metro that holds most of the people (Washington sits on Seattle, not on
// the geographic middle of the state).
//
// This replaces deriving distance from the first character of the postal code,
// which collapsed every US ZIP from 90000 to 99999 onto a single point in
// central California. Seattle priced identically to Dallas from Calgary, and
// Alaska priced as California.
// ---------------------------------------------------------------------------

interface LatLng { lat: number; lng: number }

const REGION_CENTROIDS: Record<string, LatLng> = {
  // Canada
  'CA:AB': { lat: 51.5, lng: -113.7 },
  'CA:BC': { lat: 49.3, lng: -123.0 },
  'CA:MB': { lat: 49.9, lng: -97.1 },
  'CA:NB': { lat: 45.9, lng: -66.0 },
  'CA:NL': { lat: 47.5, lng: -52.8 },
  'CA:NS': { lat: 44.7, lng: -63.6 },
  'CA:NT': { lat: 62.5, lng: -114.4 },
  'CA:NU': { lat: 63.7, lng: -68.5 },
  'CA:ON': { lat: 43.8, lng: -79.4 },
  'CA:PE': { lat: 46.2, lng: -63.1 },
  'CA:QC': { lat: 45.8, lng: -73.3 },
  'CA:SK': { lat: 51.5, lng: -105.5 },
  'CA:YT': { lat: 60.7, lng: -135.0 },
  // United States
  'US:AL': { lat: 32.8, lng: -86.8 },
  'US:AK': { lat: 61.4, lng: -149.0 },
  'US:AZ': { lat: 33.4, lng: -112.1 },
  'US:AR': { lat: 34.8, lng: -92.3 },
  'US:CA': { lat: 35.5, lng: -119.4 },
  'US:CO': { lat: 39.6, lng: -104.9 },
  'US:CT': { lat: 41.5, lng: -72.8 },
  'US:DC': { lat: 38.9, lng: -77.0 },
  'US:DE': { lat: 39.5, lng: -75.6 },
  'US:FL': { lat: 28.5, lng: -81.6 },
  'US:GA': { lat: 33.6, lng: -84.2 },
  'US:HI': { lat: 21.3, lng: -157.8 },
  'US:IA': { lat: 41.7, lng: -93.5 },
  'US:ID': { lat: 43.6, lng: -116.2 },
  'US:IL': { lat: 41.6, lng: -88.0 },
  'US:IN': { lat: 39.9, lng: -86.2 },
  'US:KS': { lat: 38.5, lng: -96.5 },
  'US:KY': { lat: 37.9, lng: -85.3 },
  'US:LA': { lat: 30.5, lng: -91.5 },
  'US:MA': { lat: 42.3, lng: -71.3 },
  'US:MD': { lat: 39.2, lng: -76.7 },
  'US:ME': { lat: 44.0, lng: -69.8 },
  'US:MI': { lat: 42.7, lng: -83.9 },
  'US:MN': { lat: 45.0, lng: -93.3 },
  'US:MO': { lat: 38.6, lng: -92.4 },
  'US:MS': { lat: 32.5, lng: -89.9 },
  'US:MT': { lat: 46.5, lng: -111.5 },
  'US:NC': { lat: 35.5, lng: -79.8 },
  'US:ND': { lat: 47.4, lng: -99.0 },
  'US:NE': { lat: 41.2, lng: -96.5 },
  'US:NH': { lat: 43.1, lng: -71.5 },
  'US:NJ': { lat: 40.4, lng: -74.4 },
  'US:NM': { lat: 35.1, lng: -106.6 },
  'US:NV': { lat: 36.5, lng: -115.3 },
  'US:NY': { lat: 41.0, lng: -73.9 },
  'US:OH': { lat: 40.2, lng: -82.8 },
  'US:OK': { lat: 35.5, lng: -97.5 },
  'US:OR': { lat: 45.3, lng: -122.8 },
  'US:PA': { lat: 40.4, lng: -76.5 },
  'US:PR': { lat: 18.2, lng: -66.4 },
  'US:RI': { lat: 41.7, lng: -71.5 },
  'US:SC': { lat: 33.9, lng: -80.9 },
  'US:SD': { lat: 44.0, lng: -98.5 },
  'US:TN': { lat: 35.8, lng: -86.5 },
  'US:TX': { lat: 31.0, lng: -97.5 },
  'US:UT': { lat: 40.6, lng: -111.9 },
  'US:VA': { lat: 38.5, lng: -78.0 },
  'US:VT': { lat: 44.1, lng: -72.7 },
  'US:WA': { lat: 47.4, lng: -122.2 },
  'US:WI': { lat: 43.5, lng: -88.5 },
  'US:WV': { lat: 38.7, lng: -80.6 },
  'US:WY': { lat: 42.9, lng: -106.5 },
};

/** Addresses are free text, so "Alberta", "alberta" and "AB" all have to land on
 *  the same centroid, or half the estimates silently fall back to zone 4. */
const REGION_ALIASES: Record<string, string> = {
  alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB',
  newfoundland: 'NL', 'newfoundland and labrador': 'NL', 'nova scotia': 'NS',
  'northwest territories': 'NT', nunavut: 'NU', ontario: 'ON',
  'prince edward island': 'PE', quebec: 'QC', 'québec': 'QC', saskatchewan: 'SK', yukon: 'YT',
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'puerto rico': 'PR', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

/** Canonical "US:TX" key for a location, or null when we cannot place it. */
export function regionKey(loc: ShipLocation): string | null {
  const country = countryCode(loc.country);
  const raw = (loc.region ?? '').trim().toLowerCase();
  if (!raw) return null;
  const code = (REGION_ALIASES[raw] ?? raw).toUpperCase();
  const key = `${country}:${code}`;
  return key in REGION_CENTROIDS ? key : null;
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

/** Region pairs are a small fixed set and this renders per viewer per item, so
 *  the trigonometry is worth doing once. */
const zoneCache = new Map<string, number>();

export function zoneForRegions(origin: ShipLocation, dest: ShipLocation): number {
  const a = regionKey(origin);
  const b = regionKey(dest);
  if (!a || !b) return UNKNOWN_ZONE;
  if (a === b) return 1;
  const cacheKey = a < b ? `${a}|${b}` : `${b}|${a}`; // distance is symmetric
  const hit = zoneCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const zone = zoneForKm(haversineKm(REGION_CENTROIDS[a]!, REGION_CENTROIDS[b]!));
  zoneCache.set(cacheKey, zone);
  return zone;
}

// ---------------------------------------------------------------------------
// Category defaults
//
// Most sellers leave weight blank, and a listing with no weight used to quote as
// a bare 60g card whatever it was. The category we already know (from the
// listing, else the seller's stream category) is a much better guess. Values sit
// deliberately on the heavy side of typical.
//
// Keys must track the category names in packages/web/src/data.ts.
// ---------------------------------------------------------------------------

export interface CategoryDefault {
  parcelPreset: string;
  weightGrams: number;
}

const CATEGORY_DEFAULTS: Record<string, CategoryDefault> = {
  'pokemon': { parcelPreset: 'poly_9x12', weightGrams: 100 },
  'one-piece': { parcelPreset: 'poly_9x12', weightGrams: 100 },
  'sports-cards': { parcelPreset: 'poly_9x12', weightGrams: 100 },
  'comics-manga': { parcelPreset: 'poly_9x12', weightGrams: 100 },
  'sealed-items': { parcelPreset: 'box_9x6x3', weightGrams: 700 },
  'video-games': { parcelPreset: 'box_6x4x2', weightGrams: 300 },
  'technology': { parcelPreset: 'box_6x4x2', weightGrams: 300 },
  'jewelry-watches': { parcelPreset: 'poly_6x9', weightGrams: 150 },
  'beauty': { parcelPreset: 'poly_6x9', weightGrams: 150 },
  'mens-fashion': { parcelPreset: 'poly_9x12', weightGrams: 350 },
  'womens-fashion': { parcelPreset: 'poly_9x12', weightGrams: 350 },
  'sneakers': { parcelPreset: 'box_12x9x4', weightGrams: 1200 },
  'bags-accessories': { parcelPreset: 'box_12x9x4', weightGrams: 1200 },
  'books': { parcelPreset: 'box_6x4x2', weightGrams: 400 },
  'toys-hobbies': { parcelPreset: 'box_6x4x2', weightGrams: 400 },
  'coins-money': { parcelPreset: 'box_6x4x2', weightGrams: 400 },
  'sporting-goods': { parcelPreset: 'box_12x9x4', weightGrams: 1500 },
  'home-garden': { parcelPreset: 'box_12x9x4', weightGrams: 1500 },
  'antiques-vintage': { parcelPreset: 'box_12x9x4', weightGrams: 1500 },
  'food-drink': { parcelPreset: 'box_9x6x3', weightGrams: 800 },
};

/** Used when we have no category at all: a card in a medium mailer. */
export const FALLBACK_DEFAULT: CategoryDefault = { parcelPreset: 'poly_9x12', weightGrams: 100 };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function categoryDefault(category?: string | null): CategoryDefault {
  if (!category) return FALLBACK_DEFAULT;
  return CATEGORY_DEFAULTS[slug(category)] ?? FALLBACK_DEFAULT;
}

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

/** Flat nudge on every estimate, in cents. If the number reads systematically
 *  low in week one, correct it from the Render dashboard rather than a deploy. */
export function estAdjustMicros(): bigint {
  const raw = process.env.BIDIT_SHIP_EST_ADJUST_CENTS;
  if (raw == null || raw.trim() === '') return 0n;
  const cents = Number(raw);
  if (!Number.isFinite(cents)) return 0n;
  return (BigInt(Math.round(cents)) * USDC) / 100n;
}

/** Round UP to the nearest $0.25. Keeps the error one-sided: an estimate that
 *  reads high and settles low is a pleasant surprise, the reverse is a ticket. */
function roundUpQuarter(micros: bigint): bigint {
  const step = USDC / 4n;
  return ((micros + step - 1n) / step) * step;
}

export interface EstimateInput {
  origin: ShipLocation;
  /** Null when the viewer has no saved address: quotes the local, cheapest lane
   *  and the caller labels it "from". */
  dest: ShipLocation | null;
  /** Listing category, else the seller's stream category. Only consulted for the
   *  fields the seller left blank. */
  category?: string | null;
  weightGrams?: number | null;
  parcelPreset?: string | null;
  parcelDims?: ParcelDims | null;
}

export interface EstimateResult {
  /** USDC micro-units, rounded up. */
  fee: bigint;
  zone: number;
  crossBorder: boolean;
  packageClass: PackageClass;
  weightGrams: number;
  /** True when dest was unknown, so this is a floor and not a quote. */
  isFrom: boolean;
}

export function estimateShipping(input: EstimateInput): EstimateResult {
  const fallback = categoryDefault(input.category);

  const weightGrams =
    Number.isFinite(input.weightGrams) && (input.weightGrams ?? 0) > 0
      ? Math.round(input.weightGrams as number)
      : fallback.weightGrams;

  // Prefer what the seller picked; fall back to the category's typical package.
  const dims: ParcelDims =
    input.parcelDims && input.parcelDims.lengthMm > 0
      ? input.parcelDims
      : (() => {
          const p = findParcelPreset(input.parcelPreset ?? fallback.parcelPreset);
          return p ? { lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm } : defaultParcel();
        })();
  const cls = packageClass(input.parcelPreset ?? fallback.parcelPreset, dims);

  const isFrom = !input.dest;
  // No address: quote the cheapest honest lane (local, domestic) and let the UI
  // present it as a starting point rather than a quote.
  const zone = isFrom ? 1 : zoneForRegions(input.origin, input.dest!);
  const crossBorder = isFrom ? false : countryCode(input.origin.country) !== countryCode(input.dest!.country);

  const usd =
    BASE +
    DISTANCE[zone]! +
    (crossBorder ? CROSS_BORDER : 0) +
    PER_KG[zone]! * (weightGrams / 1000) +
    PACKAGE[cls];

  const raw = BigInt(Math.round(usd * 1_000_000)) + estAdjustMicros();
  return {
    fee: roundUpQuarter(raw > 0n ? raw : 0n),
    zone,
    crossBorder,
    packageClass: cls,
    weightGrams,
    isFrom,
  };
}
