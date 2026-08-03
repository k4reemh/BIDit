import { describe, it, expect, afterEach } from 'vitest';
import {
  estimateShipping,
  zoneForRegions,
  regionKey,
  categoryDefault,
  FALLBACK_DEFAULT,
} from '../src/ship-estimate.js';
import { findParcelPreset, type ParcelDims } from '@bidit/shared';
import type { ShipLocation } from '../src/shipping.js';

const AB: ShipLocation = { country: 'Canada', region: 'AB', city: 'Calgary', postal: 'T2P 1J9' };
const dest = (country: string, region: string): ShipLocation => ({ country, region });

const P = (id: string): ParcelDims => {
  const p = findParcelPreset(id)!;
  return { lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm };
};

/** Dollars, for readable assertions. */
const $ = (micros: bigint) => Number(micros) / 1e6;

const quote = (to: ShipLocation | null, grams: number, parcel: string) =>
  $(estimateShipping({ origin: AB, dest: to, weightGrams: grams, parcelPreset: parcel, parcelDims: P(parcel) }).fee);

afterEach(() => {
  delete process.env.BIDIT_SHIP_EST_ADJUST_CENTS;
});

describe('headline lanes', () => {
  // Pinned so that a change to the constants shows up as a deliberate diff
  // rather than quietly moving every price on the site.
  it('quotes the lanes BIDit actually sells on', () => {
    expect(quote(dest('Canada', 'AB'), 100, 'poly_9x12')).toBe(9.0);
    expect(quote(dest('Canada', 'ON'), 100, 'poly_9x12')).toBe(13.25);
    expect(quote(dest('Canada', 'NS'), 100, 'poly_9x12')).toBe(14.25);
    expect(quote(dest('US', 'WA'), 100, 'poly_9x12')).toBe(13.5);
    expect(quote(dest('US', 'TX'), 100, 'poly_9x12')).toBe(16.25);
    expect(quote(dest('US', 'FL'), 100, 'poly_9x12')).toBe(17.25);
    expect(quote(dest('US', 'TX'), 900, 'box_9x6x3')).toBe(25.5);
    expect(quote(dest('US', 'TX'), 5000, 'box_14x12x6')).toBe(56.0);
  });

  it('no longer prices Seattle the same as Dallas', () => {
    // The old model derived distance from the first ZIP digit, so every ZIP from
    // 90000 to 99999 collapsed onto one point in central California: Seattle and
    // Dallas both quoted $22.67 from Calgary, and Alaska priced as California.
    const seattle = quote(dest('US', 'WA'), 100, 'poly_9x12');
    const dallas = quote(dest('US', 'TX'), 100, 'poly_9x12');
    const anchorage = quote(dest('US', 'AK'), 100, 'poly_9x12');
    expect(seattle).toBeLessThan(dallas);
    expect(anchorage).toBeGreaterThan(seattle);
  });
});

describe('zones', () => {
  it('rises with distance and never falls', () => {
    const lanes = ['AB', 'SK', 'ON', 'NS'].map((r) => zoneForRegions(AB, dest('Canada', r)));
    expect(lanes).toEqual([...lanes].sort((a, b) => a - b));
    expect(lanes[0]).toBe(1); // same province
    expect(lanes[lanes.length - 1]).toBe(5); // opposite coast
  });

  it('reads full region names as well as codes', () => {
    expect(regionKey(dest('Canada', 'Alberta'))).toBe('CA:AB');
    expect(regionKey(dest('Canada', 'alberta'))).toBe('CA:AB');
    expect(regionKey(dest('United States', 'Texas'))).toBe('US:TX');
    expect(regionKey(dest('US', 'tx'))).toBe('US:TX');
  });

  it('sends an unplaceable region to a mid-far zone, not a local one', () => {
    // Quoting an address we cannot resolve as a local delivery would under-price
    // every typo and every region we have no centroid for.
    expect(zoneForRegions(AB, dest('Canada', 'Atlantis'))).toBe(4);
    expect(zoneForRegions(AB, dest('Canada', ''))).toBe(4);
    expect(zoneForRegions(AB, dest('FR', 'Île-de-France'))).toBe(4);
  });

  it('is symmetric', () => {
    expect(zoneForRegions(AB, dest('US', 'TX'))).toBe(zoneForRegions(dest('US', 'TX'), AB));
  });
});

describe('the fee moves the way shipping does', () => {
  it('rises with distance', () => {
    const fees = ['AB', 'SK', 'ON', 'NS'].map((r) => quote(dest('Canada', r), 100, 'poly_9x12'));
    for (let i = 1; i < fees.length; i += 1) expect(fees[i]!).toBeGreaterThan(fees[i - 1]!);
  });

  it('rises with weight, smoothly', () => {
    const fees = [50, 100, 500, 1000, 5000].map((g) => quote(dest('US', 'TX'), g, 'poly_9x12'));
    for (let i = 1; i < fees.length; i += 1) expect(fees[i]!).toBeGreaterThan(fees[i - 1]!);
    // Banded weight would put a cliff either side of 500g. Two grams must not
    // cost three dollars.
    const under = quote(dest('US', 'TX'), 499, 'poly_9x12');
    const over = quote(dest('US', 'TX'), 501, 'poly_9x12');
    expect(over - under).toBeLessThanOrEqual(0.25);
  });

  it('rises with package class', () => {
    const mailer = quote(dest('US', 'TX'), 500, 'poly_9x12');
    const small = quote(dest('US', 'TX'), 500, 'box_6x4x2');
    const large = quote(dest('US', 'TX'), 500, 'box_12x9x4');
    expect(small).toBeGreaterThan(mailer);
    expect(large).toBeGreaterThan(small);
  });

  it('charges more to cross the border than to stay home at the same distance', () => {
    // Vancouver and Seattle are both a short hop from Calgary; only one needs
    // customs.
    const domestic = quote(dest('Canada', 'BC'), 100, 'poly_9x12');
    const crossed = quote(dest('US', 'WA'), 100, 'poly_9x12');
    expect(crossed).toBeGreaterThan(domestic);
    expect(estimateShipping({ origin: AB, dest: dest('US', 'WA'), weightGrams: 100 }).crossBorder).toBe(true);
    expect(estimateShipping({ origin: AB, dest: dest('Canada', 'BC'), weightGrams: 100 }).crossBorder).toBe(false);
  });
});

describe('category defaults', () => {
  it('fills in weight and package when the seller left them blank', () => {
    const sealed = estimateShipping({ origin: AB, dest: dest('US', 'TX'), category: 'Sealed Items' });
    const card = estimateShipping({ origin: AB, dest: dest('US', 'TX'), category: 'Pokémon' });
    expect(sealed.weightGrams).toBe(700);
    expect(card.weightGrams).toBe(100);
    expect(sealed.fee).toBeGreaterThan(card.fee);
  });

  it('never overrides what the seller actually entered', () => {
    const e = estimateShipping({
      origin: AB,
      dest: dest('US', 'TX'),
      category: 'Sneakers', // would default to 1200g in a large box
      weightGrams: 30,
      parcelPreset: 'poly_6x9',
      parcelDims: P('poly_6x9'),
    });
    expect(e.weightGrams).toBe(30);
    expect(e.packageClass).toBe('polymailer');
  });

  it('falls back to a card in a mailer for unknown or missing categories', () => {
    expect(categoryDefault(null)).toEqual(FALLBACK_DEFAULT);
    expect(categoryDefault('Interpretive Dance')).toEqual(FALLBACK_DEFAULT);
    // Slugged, so display casing and punctuation still match.
    expect(categoryDefault('Comics & Manga')).toEqual(categoryDefault('comics-manga'));
    expect(categoryDefault('One Piece').weightGrams).toBe(100);
  });

  it('points every default at a preset that exists', () => {
    for (const name of [
      'Pokémon', 'One Piece', 'Sports Cards', 'Sealed Items', 'Comics & Manga', 'Video Games',
      'Toys & Hobbies', 'Coins & Money', 'Mens Fashion', 'Womens Fashion', 'Sneakers',
      'Bags & Accessories', 'Jewelry & Watches', 'Beauty', 'Technology', 'Sporting Goods',
      'Books', 'Food & Drink', 'Home & Garden', 'Antiques & Vintage',
    ]) {
      const d = categoryDefault(name);
      expect(findParcelPreset(d.parcelPreset), `${name} -> ${d.parcelPreset}`).not.toBeNull();
      expect(d.weightGrams).toBeGreaterThan(0);
    }
  });
});

describe('viewers with no saved address', () => {
  it('returns the cheapest honest lane, flagged as a floor', () => {
    const e = estimateShipping({ origin: AB, dest: null, weightGrams: 100, parcelPreset: 'poly_9x12' });
    expect(e.isFrom).toBe(true);
    expect(e.zone).toBe(1);
    expect(e.crossBorder).toBe(false);
    // It is a floor, so no real destination may come out cheaper.
    for (const r of ['AB', 'BC', 'ON', 'NS']) {
      expect(quote(dest('Canada', r), 100, 'poly_9x12')).toBeGreaterThanOrEqual($(e.fee));
    }
    expect(quote(dest('US', 'TX'), 100, 'poly_9x12')).toBeGreaterThan($(e.fee));
  });
});

describe('presentation', () => {
  it('always rounds up, never down', () => {
    // An estimate that reads high and settles low is a pleasant surprise. The
    // reverse is a support ticket, so rounding may only ever go one way.
    for (const g of [10, 33, 57, 101, 249, 733, 1001, 2500]) {
      for (const r of ['AB', 'ON', 'NS']) {
        const cents = Math.round(quote(dest('Canada', r), g, 'poly_9x12') * 100);
        expect(cents % 25).toBe(0);
      }
    }
  });

  it('honours the flat adjustment knob', () => {
    const before = quote(dest('US', 'TX'), 100, 'poly_9x12');
    process.env.BIDIT_SHIP_EST_ADJUST_CENTS = '200';
    expect(quote(dest('US', 'TX'), 100, 'poly_9x12')).toBe(before + 2);
    process.env.BIDIT_SHIP_EST_ADJUST_CENTS = 'nonsense';
    expect(quote(dest('US', 'TX'), 100, 'poly_9x12')).toBe(before);
  });

  it('never returns a negative or zero fee', () => {
    process.env.BIDIT_SHIP_EST_ADJUST_CENTS = '-100000';
    expect(quote(dest('Canada', 'AB'), 1, 'poly_6x9')).toBe(0);
  });
});
