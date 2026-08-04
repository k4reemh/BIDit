/**
 * What the buyer actually pays to ship a won item.
 *
 * Unlike the bid-panel estimate (ship-estimate.ts), this is real money against a
 * real parcel, so it asks a carrier. Shippo is given the seller's ship-from, the
 * buyer's delivery address, and the package the seller declared on the listing;
 * the cheapest rate that comes back, plus a flat handling markup, is the price.
 *
 * Two properties this has to hold:
 *
 *   It cannot fail the checkout. Shippo being slow, down, or returning nothing
 *   for a lane must not strand a buyer holding an item they cannot ship. Any
 *   failure falls through to the local rate model, which needs no network.
 *
 *   It cannot charge a number the buyer did not see. Quoting once at the
 *   estimate and again at the charge invites the two to disagree, so the
 *   estimate issues a ShipQuote and paying consumes it.
 */
import { createHash } from 'node:crypto';
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { systemClock, type Clock } from './clock.js';
import { getRates, shippoKey, type RateCustoms, type ShippoAddress, type ShippoRate } from './shippo.js';
import { usdPerCad, countryCode, type Dimensions, type ShipLocation } from './shipping.js';
import { estimateShipping } from './ship-estimate.js';

const USDC = 1_000_000n;

/** How long a quoted price stands. Long enough to read the page and decide,
 *  short enough that a carrier rate change cannot be held open all day. */
export const QUOTE_TTL_MS = 20 * 60_000;

/** Flat handling added to the carrier rate. Shippo's rates are already well
 *  under retail, and BIDit buys the label, so this covers the per-label fee and
 *  the packages that turn up heavier than declared. */
export function shipMarkupMicros(): bigint {
  const raw = process.env.BIDIT_SHIP_MARKUP_CENTS;
  if (raw == null || raw.trim() === '') return (150n * USDC) / 100n; // $1.50
  const cents = Number(raw);
  if (!Number.isFinite(cents) || cents < 0) return (150n * USDC) / 100n;
  return (BigInt(Math.round(cents)) * USDC) / 100n;
}

// ---------------------------------------------------------------------------
// Provider seam
// ---------------------------------------------------------------------------

export interface LiveRateProvider {
  /** Carrier rates for a parcel, cheapest-first is not required. Throws on any
   *  failure; callers fall back to the local model. `customs` is what the
   *  declaration will say: rating a cross-border parcel without one gets zero
   *  rates back, not an error. */
  rates(
    from: ShippoAddress,
    to: ShippoAddress,
    parcel: { lengthMm: number; widthMm: number; heightMm: number; weightGrams: number },
    customs?: RateCustoms,
  ): Promise<ShippoRate[]>;
}

class ShippoLiveRates implements LiveRateProvider {
  async rates(
    from: ShippoAddress,
    to: ShippoAddress,
    parcel: { lengthMm: number; widthMm: number; heightMm: number; weightGrams: number },
    customs?: RateCustoms,
  ) {
    const { rates, messages } = await getRates(from, to, parcel, customs);
    if (rates.length === 0) {
      // Carrier-side complaints are the difference between "expensive lane" and
      // "no carrier account for this country", and only the log will ever say so.
      console.warn(`[ship-charge] shippo returned no rates: ${messages.join(' | ').slice(0, 300)}`);
    }
    return rates;
  }
}

/** Deterministic rates for tests: no key, no network. */
export class MockLiveRates implements LiveRateProvider {
  constructor(private next: ShippoRate[] | Error = []) {}
  calls = 0;
  /** What the last rate call declared to customs, so tests can pin that the
   *  real item value reaches the declaration. */
  lastCustoms: RateCustoms | undefined;
  set(next: ShippoRate[] | Error): void {
    this.next = next;
  }
  async rates(
    _from?: ShippoAddress,
    _to?: ShippoAddress,
    _parcel?: { lengthMm: number; widthMm: number; heightMm: number; weightGrams: number },
    customs?: RateCustoms,
  ): Promise<ShippoRate[]> {
    this.calls += 1;
    this.lastCustoms = customs;
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

let provider: LiveRateProvider | null | undefined;

export function setLiveRateProvider(p: LiveRateProvider | null): void {
  provider = p;
}

/** The active provider, or null when Shippo is not configured (local dev, tests)
 *  and every quote should come from the model. */
export function getLiveRateProvider(): LiveRateProvider | null {
  if (provider !== undefined) return provider;
  provider = shippoKey() ? new ShippoLiveRates() : null;
  return provider;
}

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

/** A postal address as stored on a seller profile or a buyer's account. */
export interface FullAddress extends ShipLocation {
  name?: string | null;
  line1?: string | null;
  line2?: string | null;
}

function toShippoAddress(a: FullAddress): ShippoAddress {
  return {
    name: a.name ?? undefined,
    street1: a.line1 ?? undefined,
    city: a.city ?? undefined,
    state: a.region ?? undefined,
    zip: a.postal ?? undefined,
    country: countryCode(a.country),
  };
}

/**
 * Carrier rates come back in the carrier's own currency; the ledger is USD.
 * Returns null for a currency we have no rate for, which sends the caller to the
 * model rather than charging a number derived from a guessed exchange rate.
 */
function toUsd(amount: number, currency: string): number | null {
  const c = currency.toUpperCase();
  if (c === 'USD') return amount;
  if (c === 'CAD') return amount * usdPerCad();
  // Other currencies convert only when an operator has set a rate, e.g.
  // BIDIT_FX_GBP_USD=1.27 for UK lanes. No rate means the carrier rate is
  // SKIPPED, never guessed: a wrong exchange rate is a silently wrong charge.
  const fx = Number(process.env[`BIDIT_FX_${c}_USD`] ?? '');
  if (Number.isFinite(fx) && fx > 0 && fx < 1000) return amount * fx;
  return null;
}

export interface RealRate {
  /** What the buyer pays, micro-USDC, markup included. */
  amountMicros: bigint;
  rateObjectId: string | null;
  carrier: string;
  service: string;
  estDays: number | null;
  source: 'shippo' | 'model';
}

/** Cheapest rate we can actually charge for, or null if none qualify. */
function cheapestUsable(rates: ShippoRate[]): { rate: ShippoRate; usd: number } | null {
  let best: { rate: ShippoRate; usd: number } | null = null;
  for (const r of rates) {
    const usd = toUsd(r.amount, r.currency);
    if (usd === null || !(usd > 0)) continue;
    if (!best || usd < best.usd) best = { rate: r, usd };
  }
  return best;
}

/**
 * Price one real parcel. Asks the carrier; falls back to the local model on any
 * failure, empty rate set, or unconvertible currency.
 */
export async function rateShipment(
  origin: FullAddress,
  dest: FullAddress,
  parcel: { dims: Dimensions; weightGrams: number },
  customs?: RateCustoms,
): Promise<RealRate> {
  const markup = shipMarkupMicros();
  const live = getLiveRateProvider();

  if (live) {
    try {
      const rates = await live.rates(
        toShippoAddress(origin),
        toShippoAddress(dest),
        {
          lengthMm: Math.round(parcel.dims.lengthCm * 10),
          widthMm: Math.round(parcel.dims.widthCm * 10),
          heightMm: Math.round(parcel.dims.heightCm * 10),
          weightGrams: parcel.weightGrams,
        },
        customs,
      );
      const best = cheapestUsable(rates);
      if (best) {
        return {
          amountMicros: BigInt(Math.round(best.usd * 1_000_000)) + markup,
          rateObjectId: best.rate.rateId,
          carrier: best.rate.carrier,
          service: best.rate.service,
          estDays: best.rate.estimatedDays,
          source: 'shippo',
        };
      }
    } catch (err) {
      console.error('[ship-charge] live rate failed, using the local model:', (err as Error)?.message ?? err);
    }
  }

  // Fall back to the SAME formula the bid panel quoted from, not the old
  // zone/per-pound model. Those two disagree wildly on the lanes BIDit actually
  // sells: the panel said $10.50 to Seattle while the old model charged $24.17.
  // A buyer who is shown one number and charged another has been misled whether
  // or not a carrier was reachable, so the fallback has to be the same pricing
  // the estimate promised, plus the same handling markup a Shippo quote carries.
  return {
    amountMicros:
      estimateShipping({
        origin,
        dest,
        weightGrams: parcel.weightGrams,
        parcelDims: {
          lengthMm: Math.round(parcel.dims.lengthCm * 10),
          widthMm: Math.round(parcel.dims.widthCm * 10),
          heightMm: Math.round(parcel.dims.heightCm * 10),
        },
      }).fee + markup,
    rateObjectId: null,
    carrier: 'estimated',
    service: 'Standard',
    estDays: null,
    source: 'model',
  };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/** Binds a price to an exact set of items, order-independent. */
export function hashItemIds(ids: string[]): string {
  return createHash('sha256').update([...new Set(ids)].sort().join(',')).digest('hex');
}

/** A quote that cannot be charged: gone, expired, spent, or for other items. The
 *  caller re-quotes and asks the buyer to confirm the new number. */
export class QuoteStaleError extends Error {
  readonly status = 409;
  constructor(message = 'That shipping price expired. Check the new one and try again.') {
    super(message);
    this.name = 'QuoteStaleError';
  }
}

export async function issueQuote(
  params: {
    buyerId: string;
    itemIds: string[];
    rate: RealRate;
    isPrivate: boolean;
  },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  return prisma.shipQuote.create({
    data: {
      buyerId: params.buyerId,
      itemIdsHash: hashItemIds(params.itemIds),
      amountMicros: params.rate.amountMicros,
      rateObjectId: params.rate.rateObjectId,
      carrier: params.rate.carrier,
      service: params.rate.service,
      estDays: params.rate.estDays,
      source: params.rate.source,
      isPrivate: params.isPrivate,
      expiresAt: new Date(clock.now().getTime() + QUOTE_TTL_MS),
    },
  });
}

/**
 * Claim a quote for payment. Atomic: the conditional update means two concurrent
 * Pay clicks produce one charge and one QuoteStaleError, not two charges.
 *
 * Every mismatch throws the same error on purpose. A quote id is not a secret,
 * but distinguishing "wrong buyer" from "already spent" would confirm which ids
 * exist, and there is nothing useful the client could do differently anyway.
 */
export async function consumeQuote(
  params: { quoteId: string; buyerId: string; itemIds: string[]; isPrivate: boolean },
  clock: Clock = systemClock,
  prisma: PrismaClient = defaultPrisma,
) {
  const quote = await prisma.shipQuote.findUnique({ where: { id: params.quoteId } });
  if (
    !quote ||
    quote.buyerId !== params.buyerId ||
    quote.consumedAt !== null ||
    quote.expiresAt <= clock.now() ||
    quote.itemIdsHash !== hashItemIds(params.itemIds) ||
    quote.isPrivate !== params.isPrivate
  ) {
    throw new QuoteStaleError();
  }
  const claimed = await prisma.shipQuote.updateMany({
    where: { id: quote.id, consumedAt: null },
    data: { consumedAt: clock.now() },
  });
  if (claimed.count !== 1) throw new QuoteStaleError();
  return quote;
}
