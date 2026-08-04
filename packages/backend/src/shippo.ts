/**
 * Shippo HTTP client: carrier accounts and live rate quotes.
 *
 * Rating is free and read-only (buying a label is not, and does not live here),
 * so every call in this file is safe to run against production.
 *
 * Nothing here throws for the caller's benefit alone: callers are rate paths that
 * must degrade to the local model in shipping.ts rather than fail an auction, so
 * errors come back as a typed ShippoError they can catch and fall through on.
 */

import { usdPerCad } from './shipping.js';

const BASE = 'https://api.goshippo.com';
const TIMEOUT_MS = 8_000;

/** A Shippo call that did not produce usable rates. Callers fall back to the
 *  local rate model; they never surface this to a buyer. */
export class ShippoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ShippoError';
  }
}

/** The API key, or null when Shippo is not configured (local dev, tests). */
export function shippoKey(): string | null {
  const k = process.env.SHIPPO_API_KEY?.trim();
  return k ? k : null;
}

/** Whether the configured key is Shippo's TEST key. Test keys return fake rates
 *  and cannot buy real labels, so a production deploy running on one is a
 *  misconfiguration worth reporting loudly rather than discovering at ship time. */
export function isTestKey(key: string): boolean {
  return key.startsWith('shippo_test_');
}

async function shippoFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const key = shippoKey();
  if (!key) throw new ShippoError('SHIPPO_API_KEY is not set');
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `ShippoToken ${key}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ShippoError(`request failed: ${(err as Error)?.message ?? err}`);
  }
  if (!res.ok) {
    // Body is truncated on purpose: Shippo echoes the request back on some
    // errors, and the request contains a buyer's address.
    const body = await res.text().catch(() => '');
    throw new ShippoError(`${res.status}: ${body.slice(0, 300)}`, res.status);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Carrier accounts
// ---------------------------------------------------------------------------

export interface CarrierAccount {
  carrier: string;
  /** Last 4 of the carrier account number only. The full value is a real account
   *  credential (a UPS/FedEx number can be used to bill shipments), so it never
   *  leaves this function whole. */
  accountTail: string;
  active: boolean;
  test: boolean;
}

interface RawCarrierAccount {
  carrier?: string;
  account_id?: string;
  active?: boolean;
  test?: boolean;
}

export async function listCarrierAccounts(): Promise<CarrierAccount[]> {
  const data = await shippoFetch<{ results?: RawCarrierAccount[] }>('/carrier_accounts?results=100');
  return (data.results ?? []).map((a) => ({
    carrier: String(a.carrier ?? 'unknown'),
    accountTail: String(a.account_id ?? '').slice(-4),
    active: a.active === true,
    test: a.test === true,
  }));
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/** Address as Shippo wants it. For RATE-only calls we deliberately send no
 *  street: zip + country (+ state) is all a carrier needs to price a zone, and
 *  keeping street out means cached rate cells carry no PII. Label purchase is a
 *  separate path that does send the full address. */
export interface ShippoAddress {
  name?: string;
  street1?: string;
  city?: string;
  state?: string;
  zip?: string;
  country: string;
}

export interface ShippoParcel {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  weightGrams: number;
}

export interface ShippoRate {
  /** Shippo's rate object id. Buying a label later means referencing this exact
   *  rate, so the buyer is charged for and shipped on the same service. */
  rateId: string;
  carrier: string;
  service: string;
  serviceToken: string;
  /** Rate amount in its own currency, as a Number of major units. */
  amount: number;
  currency: string;
  estimatedDays: number | null;
}

interface RawRate {
  object_id?: string;
  amount?: string;
  currency?: string;
  provider?: string;
  estimated_days?: number | null;
  servicelevel?: { name?: string; token?: string };
}

export interface RateResult {
  rates: ShippoRate[];
  /** Carrier-side complaints (unsupported lane, address rejected, account not
   *  enabled). Empty rates + a message here is the signal that a carrier account
   *  is missing, which is the difference between "expensive" and "impossible". */
  messages: string[];
  /** Cross-border only: whether the customs declaration made it onto the rate
   *  call. A cross-border lane with zero rates has exactly two explanations,
   *  a declaration that failed to attach (ours to fix) or carrier accounts that
   *  refuse the lane (account admin, not code), and this is what separates them. */
  customs?: { attached: boolean; error?: string };
}

/** What the customs form says the parcel holds. Rating cross-border REQUIRES
 *  one: without it UPS answers "111549: Hard: Invalid Shipment Contents Value"
 *  and the lane returns zero rates, which is exactly what a Calgary → Dallas
 *  probe came back with. Domestic lanes ignore it. */
export interface RateCustoms {
  /** Total declared value of the contents, USD. */
  declaredValueUsd: number;
  /** One-line contents description. */
  description?: string;
}

const countryOf = (a: ShippoAddress) => a.country.trim().toUpperCase();

/**
 * A carrier rate in USD, or null when we have no exchange rate for its
 * currency. Shared by the charge path and the probe, so the number an admin
 * sees in a diagnosis is computed by the same code that will bill the buyer.
 * USD passes through; CAD uses BIDIT_CAD_USD; anything else needs
 * BIDIT_FX_<CUR>_USD set, and is otherwise SKIPPED, never guessed.
 */
export function rateAmountUsd(amount: number, currency: string, usdPerCadRate: number): number | null {
  const c = currency.toUpperCase();
  if (c === 'USD') return amount;
  if (c === 'CAD') return amount * usdPerCadRate;
  const fx = Number(process.env[`BIDIT_FX_${c}_USD`] ?? '');
  if (Number.isFinite(fx) && fx > 0 && fx < 1000) return amount * fx;
  return null;
}

/**
 * Live rates for one origin/destination/parcel. `async: false` makes Shippo
 * return the rates inline instead of making us poll.
 */
export async function getRates(
  from: ShippoAddress,
  to: ShippoAddress,
  parcel: ShippoParcel,
  customs?: RateCustoms,
): Promise<RateResult> {
  const parcelWeightG = Math.max(1, Math.round(parcel.weightGrams));
  const body: Record<string, unknown> = {
    address_from: from,
    address_to: to,
    parcels: [
      {
        // Millimetres are our canonical unit; Shippo takes cm happily and the
        // conversion is exact enough at the precision carriers actually bill on.
        length: (parcel.lengthMm / 10).toFixed(2),
        width: (parcel.widthMm / 10).toFixed(2),
        height: (parcel.heightMm / 10).toFixed(2),
        distance_unit: 'cm',
        weight: String(parcelWeightG),
        mass_unit: 'g',
      },
    ],
    async: false,
  };

  // Cross-border needs the customs declaration attached BEFORE rating, not just
  // at label time. Best effort: if the declaration cannot be created, rate
  // without it and let the caller's zero-rate fallback do its job.
  let customsStatus: { attached: boolean; error?: string } | undefined;
  if (customs && countryOf(from) !== countryOf(to)) {
    try {
      const decl = await shippoFetch<{ object_id?: string }>('/customs/declarations', {
        method: 'POST',
        body: JSON.stringify({
          contents_type: 'MERCHANDISE',
          // DDU per the locked shipping decision: the buyer pays any duties on
          // delivery rather than us prepaying them into the label price.
          incoterm: 'DDU',
          non_delivery_option: 'RETURN',
          certify: true,
          certify_signer: from.name?.trim() || 'BIDit Seller',
          items: [
            {
              description: (customs.description?.trim() || 'Collectible trading cards').slice(0, 100),
              quantity: 1,
              // Contents must weigh LESS than the packed parcel (the mailer and
              // padding are real grams), or carriers reject the declaration.
              net_weight: String(Math.max(1, Math.round(parcelWeightG * 0.8))),
              mass_unit: 'g',
              // Zero is the "Invalid Shipment Contents Value" error by another
              // route, so the declared value is floored at a dollar.
              value_amount: Math.max(1, customs.declaredValueUsd).toFixed(2),
              value_currency: 'USD',
              origin_country: countryOf(from),
            },
          ],
        }),
      });
      if (decl.object_id) {
        body.customs_declaration = decl.object_id;
        customsStatus = { attached: true };
      } else {
        customsStatus = { attached: false, error: 'created but no object_id returned' };
      }
    } catch (err) {
      customsStatus = { attached: false, error: (err as Error)?.message ?? String(err) };
      console.warn('[shippo] customs declaration failed; rating without one:', (err as Error)?.message ?? err);
    }
  }

  const data = await shippoFetch<{ rates?: RawRate[]; messages?: unknown[] }>('/shipments', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const rates: ShippoRate[] = [];
  for (const r of data.rates ?? []) {
    const amount = Number(r.amount);
    // A rate with no parseable amount is not a cheap rate, it is a broken one.
    // Silently treating it as 0 would hand the buyer a free label.
    if (!r.object_id || !Number.isFinite(amount) || amount <= 0) continue;
    rates.push({
      rateId: String(r.object_id),
      carrier: String(r.provider ?? 'unknown'),
      service: String(r.servicelevel?.name ?? ''),
      serviceToken: String(r.servicelevel?.token ?? ''),
      amount,
      currency: String(r.currency ?? 'USD').toUpperCase(),
      estimatedDays: typeof r.estimated_days === 'number' ? r.estimated_days : null,
    });
  }
  const messages = (data.messages ?? [])
    .map((m) => {
      const o = m as { source?: string; text?: string; code?: string };
      return [o?.source, o?.code, o?.text].filter(Boolean).join(': ');
    })
    .filter(Boolean)
    .slice(0, 20);

  return { rates, messages, customs: customsStatus };
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

export interface AddressCheck {
  /** `ok` the carrier recognises it, `warning` it does not, `unchecked` we could
   *  not ask. Never `invalid`: this only ever advises. */
  status: 'ok' | 'warning' | 'unchecked';
  messages: string[];
  /** The carrier's corrected version, when it differs from what was entered. */
  suggestion: {
    line1?: string;
    line2?: string;
    city?: string;
    region?: string;
    postal?: string;
    country?: string;
  } | null;
}

interface RawValidatedAddress {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  validation_results?: {
    is_valid?: boolean;
    messages?: { text?: string; code?: string }[];
  };
}

const differs = (a?: string, b?: string) =>
  (a ?? '').trim().toUpperCase() !== (b ?? '').trim().toUpperCase();

/**
 * Ask the carrier whether an address is deliverable, and what it should say.
 *
 * Advisory on purpose. Carrier databases are wrong about plenty of real
 * addresses (new builds, rural routes, anything outside the US), so a hard block
 * would lock people out of their own homes. A bad address instead fails at label
 * time, weeks later, which is far more expensive to unpick than a warning now.
 *
 * Never throws: an unreachable Shippo returns `unchecked`, and the caller saves
 * the address regardless.
 */
export async function validateAddress(a: ShippoAddress): Promise<AddressCheck> {
  if (!shippoKey()) return { status: 'unchecked', messages: [], suggestion: null };
  try {
    const data = await shippoFetch<RawValidatedAddress>('/addresses', {
      method: 'POST',
      body: JSON.stringify({ ...a, validate: true }),
    });
    const res = data.validation_results ?? {};
    const messages = (res.messages ?? [])
      .map((m) => String(m?.text ?? '').trim())
      .filter(Boolean)
      .slice(0, 5);

    if (res.is_valid !== true) {
      return {
        status: 'warning',
        messages: messages.length ? messages : ['We could not confirm this address with the carrier.'],
        suggestion: null,
      };
    }

    // Valid, but the carrier may have normalised it. Only offer a suggestion when
    // something actually changed, so nobody is asked to "correct" what they typed.
    const changed =
      differs(a.street1, data.street1) ||
      differs(a.city, data.city) ||
      differs(a.state, data.state) ||
      differs(a.zip, data.zip);
    return {
      status: 'ok',
      messages,
      suggestion: changed
        ? {
            line1: data.street1,
            line2: data.street2,
            city: data.city,
            region: data.state,
            postal: data.zip,
            country: data.country,
          }
        : null,
    };
  } catch (err) {
    // Deliberately quiet about the address itself: this runs on every save and
    // the input is someone's home.
    console.warn('[shippo] address validation unavailable:', (err as Error)?.message ?? err);
    return { status: 'unchecked', messages: [], suggestion: null };
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface LaneProbe {
  lane: string;
  from: ShippoAddress;
  to: ShippoAddress;
  rateCount: number;
  cheapest: ShippoRate | null;
  /** Every rate, cheapest first, compact. The cheapest alone hides whether a
   *  lane is served by one carrier or ten, which is the difference between
   *  "this works" and "this works until that one account has a bad day". */
  rates: string[];
  /** Cheapest rate CONVERTED to USD by the same code that bills buyers, or null
   *  when no rate on the lane has a known exchange rate. Native amounts answer
   *  "does the carrier serve this"; this answers "what would the buyer pay". */
  cheapestUsd: { usd: number; carrier: string; service: string; currency: string } | null;
  /** Currencies present on the lane that were skipped for lack of a
   *  BIDIT_FX_<CUR>_USD rate: rates the buyer cannot be charged yet. */
  skippedCurrencies: string[];
  /** Whether the customs declaration attached (cross-border lanes only). */
  customs?: { attached: boolean; error?: string };
  messages: string[];
  error: string | null;
}

export interface ShippingDiagnosis {
  configured: boolean;
  testKey: boolean;
  carrierAccounts: CarrierAccount[];
  carrierError: string | null;
  lanes: LaneProbe[];
}

/** A medium polymailer at 200g: representative of the common BIDit parcel, and
 *  heavy enough that every carrier will quote it. */
const PROBE_PARCEL: ShippoParcel = { lengthMm: 305, widthMm: 229, heightMm: 19, weightGrams: 200 };

/**
 * Read-only production probe. Answers the question the whole rate rebuild rests
 * on: does this Shippo account actually return rates for the lanes BIDit sells
 * on? A Canadian origin with no Canadian carrier account returns zero rates, and
 * no amount of caching fixes that.
 */
export async function diagnoseShipping(
  origin: ShippoAddress,
  extraDest?: ShippoAddress,
): Promise<ShippingDiagnosis> {
  const key = shippoKey();
  if (!key) {
    return { configured: false, testKey: false, carrierAccounts: [], carrierError: null, lanes: [] };
  }

  let carrierAccounts: CarrierAccount[] = [];
  let carrierError: string | null = null;
  try {
    carrierAccounts = await listCarrierAccounts();
  } catch (err) {
    carrierError = (err as Error)?.message ?? String(err);
  }

  const destinations: { lane: string; to: ShippoAddress }[] = [
    { lane: 'origin → US (Texas)', to: { city: 'Dallas', state: 'TX', zip: '75201', country: 'US' } },
    { lane: 'origin → US (New York)', to: { city: 'New York', state: 'NY', zip: '10001', country: 'US' } },
    { lane: 'origin → CA (Ontario)', to: { city: 'Toronto', state: 'ON', zip: 'M5V 2T6', country: 'CA' } },
    { lane: 'origin → CA (Alberta)', to: { city: 'Calgary', state: 'AB', zip: 'T2P 1J9', country: 'CA' } },
  ];
  if (extraDest) destinations.push({ lane: `origin → custom (${extraDest.country})`, to: extraDest });

  const lanes: LaneProbe[] = [];
  for (const d of destinations) {
    try {
      // A representative declared value, so cross-border lanes are tested the
      // way a real charge would rate them (without customs they return zero).
      const { rates, messages, customs } = await getRates(origin, d.to, PROBE_PARCEL, {
        declaredValueUsd: 20,
        description: 'Collectible trading card',
      });
      const sorted = [...rates].sort((a, b) => a.amount - b.amount);
      // Cheapest by converted USD, exactly as the charge path picks it: within
      // one lane the currencies can differ, and 10 GBP is not cheaper than 11 USD.
      const cad = usdPerCad();
      let best: { usd: number; carrier: string; service: string; currency: string } | null = null;
      const skipped = new Set<string>();
      for (const r of rates) {
        const usd = rateAmountUsd(r.amount, r.currency, cad);
        if (usd === null) {
          skipped.add(r.currency);
          continue;
        }
        if (!best || usd < best.usd) best = { usd, carrier: r.carrier, service: r.service, currency: r.currency };
      }
      lanes.push({
        lane: d.lane,
        from: origin,
        to: d.to,
        rateCount: rates.length,
        cheapest: sorted[0] ?? null,
        rates: sorted.map((r) => `${r.carrier} ${r.service}: ${r.amount.toFixed(2)} ${r.currency}${r.estimatedDays ? ` (${r.estimatedDays}d)` : ''}`),
        cheapestUsd: best,
        skippedCurrencies: [...skipped],
        customs,
        messages,
        error: null,
      });
    } catch (err) {
      lanes.push({
        lane: d.lane,
        from: origin,
        to: d.to,
        rateCount: 0,
        cheapest: null,
        rates: [],
        cheapestUsd: null,
        skippedCurrencies: [],
        messages: [],
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  return { configured: true, testKey: isTestKey(key), carrierAccounts, carrierError, lanes };
}
