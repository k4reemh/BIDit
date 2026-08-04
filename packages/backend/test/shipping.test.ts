import { describe, it, expect } from 'vitest';
import {
  countryCode,
  quoteShipping,
  quoteShippingBreakdown,
  zoneForKm,
  billableGrams,
  shipDiscountPct,
  usdPerCad,
  DEFAULT_DIMS,
  type ShipLocation,
} from '../src/shipping.js';

const AB: ShipLocation = { country: 'Canada', region: 'AB', city: 'Calgary', postal: 'T2P 1J9' };
const AB2: ShipLocation = { country: 'Canada', region: 'AB', postal: 'T3A 0A1' }; // local
const BC: ShipLocation = { country: 'Canada', region: 'BC', postal: 'V6B 1A1' }; // Vancouver
const ON: ShipLocation = { country: 'Canada', region: 'ON', postal: 'M5V 1J1' }; // Toronto
const NS: ShipLocation = { country: 'Canada', region: 'NS', postal: 'B3J 1A1' }; // Halifax
const US: ShipLocation = { country: 'USA', postal: '10001' }; // NYC

const CARD_G = 57; // ~2 oz sleeved card + mailer

describe('UPS Ground estimator', () => {
  it('charges the configured fraction (default 80%) of the carrier retail', () => {
    const b = quoteShippingBreakdown(AB, ON, CARD_G, DEFAULT_DIMS);
    expect(b.discountPct).toBe(shipDiscountPct());
    expect(b.final).toBe((b.carrierRetail * BigInt(shipDiscountPct())) / 100n);
    expect(quoteShipping(AB, ON, CARD_G)).toBe(b.final);
  });

  it('costs more the farther the parcel travels', () => {
    const local = quoteShipping(AB, AB2, CARD_G);
    const vancouver = quoteShipping(AB, BC, CARD_G);
    const toronto = quoteShipping(AB, ON, CARD_G);
    const halifax = quoteShipping(AB, NS, CARD_G);
    expect(local).toBeLessThan(vancouver);
    expect(vancouver).toBeLessThan(toronto);
    expect(toronto).toBeLessThan(halifax);
  });

  it('costs more as weight rises', () => {
    const card = quoteShipping(AB, ON, CARD_G);
    const slab = quoteShipping(AB, ON, 907); // ~2 lb graded slab
    expect(slab).toBeGreaterThan(card);
  });

  it('cross-border costs more than the farthest domestic route', () => {
    expect(quoteShipping(AB, US, CARD_G)).toBeGreaterThan(quoteShipping(AB, NS, CARD_G));
  });

  it('settles Canadian-origin quotes in USD via the CAD→USD rate', () => {
    const atDefault = quoteShipping(AB, ON, 30);
    process.env.BIDIT_CAD_USD = '1';
    const atParity = quoteShipping(AB, ON, 30);
    delete process.env.BIDIT_CAD_USD;
    // At parity (1 CAD = 1 USD) the USD charge is higher than at the ~0.73 default.
    expect(atParity).toBeGreaterThan(atDefault);
    expect(Number(atDefault) / Number(atParity)).toBeCloseTo(usdPerCad(), 2);
  });

  it('always returns a positive fee, even with unknown addresses', () => {
    expect(quoteShipping({}, {}, CARD_G)).toBeGreaterThan(0n);
    expect(quoteShipping(AB, ON, 0)).toBeGreaterThan(0n); // bad weight → light-parcel default
  });

  it('maps distance to sane zones and bills actual grams for small parcels (no pound floor)', () => {
    expect(zoneForKm(10)).toBe(2);
    expect(zoneForKm(5000)).toBe(8);
    expect(billableGrams(30, DEFAULT_DIMS)).toBe(30); // a light card bills as 30g, not 1 lb
    expect(billableGrams(907, DEFAULT_DIMS)).toBe(907); // heavier slab bills its real weight
  });

  it('charges a light 30g card less than a heavier 200g one on the same route', () => {
    expect(quoteShipping(AB, ON, 30)).toBeLessThan(quoteShipping(AB, ON, 200));
  });

  it('prices a bigger parcel higher than a small one at the same weight', () => {
    // Dimensional weight only kicks in above the small-parcel threshold, which is
    // exactly the behaviour a combined multi-item shipment relies on.
    const mailer = quoteShipping(AB, ON, 500, { lengthCm: 23, widthCm: 30, heightCm: 2 });
    const box = quoteShipping(AB, ON, 500, { lengthCm: 36, widthCm: 30, heightCm: 15 });
    expect(box).toBeGreaterThan(mailer);
  });
});

describe('countryCode', () => {
  it('maps the names people actually type to ISO codes', () => {
    expect(countryCode('United Kingdom')).toBe('GB');
    expect(countryCode('UK')).toBe('GB');
    expect(countryCode('england')).toBe('GB');
    expect(countryCode('Germany')).toBe('DE');
    expect(countryCode('Canada')).toBe('CA');
    expect(countryCode('united states')).toBe('US');
    expect(countryCode('Australia')).toBe('AU');
  });

  it('passes two-letter codes through untouched', () => {
    expect(countryCode('gb')).toBe('GB');
    expect(countryCode('JP')).toBe('JP');
  });

  it('refuses to truncate an unknown name into a WRONG code', () => {
    // "Germany".slice(0, 2) is GE, which is Georgia: a parcel silently priced to
    // the wrong country. Unknowns become XX, which no carrier accepts, so the
    // charge lands on the formula fallback instead of on a wrong lane.
    expect(countryCode('Deutschland')).toBe('XX');
    expect(countryCode('Republic of Elbonia')).toBe('XX');
  });
});
