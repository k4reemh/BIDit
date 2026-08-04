import { describe, it, expect } from 'vitest';
import {
  PARCEL_PRESETS,
  CUSTOM_PARCEL_ID,
  DEFAULT_PARCEL_ID,
  findParcelPreset,
  defaultParcel,
  resolveParcel,
  combineParcels,
  ParcelError,
  type ParcelDims,
} from '@bidit/shared';

const vol = (d: ParcelDims) => d.lengthMm * d.widthMm * d.heightMm;

describe('parcel preset table', () => {
  it('has stable unique ids and positive dimensions', () => {
    const ids = PARCEL_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PARCEL_PRESETS) {
      expect(p.lengthMm).toBeGreaterThan(0);
      expect(p.widthMm).toBeGreaterThan(0);
      // Polymailer heights are the LOADED thickness. A flat 0mm mailer would rate
      // as a letter, which is the wrong service the moment anything rigid is in it.
      expect(p.heightMm).toBeGreaterThan(0);
      expect(p.typicalGrams).toBeGreaterThan(0);
    }
  });

  it('converts inches to millimetres consistently', () => {
    for (const p of PARCEL_PRESETS) {
      expect(p.lengthMm).toBe(Math.round(p.inches.length * 25.4));
      expect(p.widthMm).toBe(Math.round(p.inches.width * 25.4));
      expect(p.heightMm).toBe(Math.round(p.inches.height * 25.4));
    }
  });

  it('keeps the ids that listings are already saved against', () => {
    // Renaming a label is safe. Changing an id orphans every listing holding it,
    // which silently reprices those items, so these are pinned deliberately.
    for (const id of ['poly_6x9', 'poly_9x12', 'poly_10x13', 'box_6x4x2', 'box_9x6x3', 'box_12x9x4', 'box_14x12x6']) {
      expect(findParcelPreset(id)).not.toBeNull();
    }
    expect(findParcelPreset(DEFAULT_PARCEL_ID)).not.toBeNull();
  });
});

describe('resolveParcel', () => {
  it('takes dimensions from the preset, never from the caller', () => {
    // A client claiming a small mailer cannot attach large numbers to it, which
    // would otherwise quote a freight parcel at polymailer prices.
    const r = resolveParcel('poly_6x9', { lengthMm: 2000, widthMm: 2000, heightMm: 2000 });
    const preset = findParcelPreset('poly_6x9')!;
    expect(r.presetId).toBe('poly_6x9');
    expect(r.dims).toEqual({ lengthMm: preset.lengthMm, widthMm: preset.widthMm, heightMm: preset.heightMm });
  });

  it('accepts custom dimensions inside the allowed range', () => {
    const r = resolveParcel(CUSTOM_PARCEL_ID, { lengthMm: 400, widthMm: 300, heightMm: 200 });
    expect(r.presetId).toBe(CUSTOM_PARCEL_ID);
    expect(r.dims).toEqual({ lengthMm: 400, widthMm: 300, heightMm: 200 });
  });

  it('rejects custom dimensions that are missing, tiny, or freight-sized', () => {
    expect(() => resolveParcel(CUSTOM_PARCEL_ID, { lengthMm: 400, widthMm: 300 })).toThrow(ParcelError);
    expect(() => resolveParcel(CUSTOM_PARCEL_ID, { lengthMm: 1, widthMm: 300, heightMm: 200 })).toThrow(ParcelError);
    expect(() => resolveParcel(CUSTOM_PARCEL_ID, { lengthMm: 9999, widthMm: 300, heightMm: 200 })).toThrow(ParcelError);
  });

  it('falls back to the default mailer for unknown or missing ids', () => {
    for (const id of [null, undefined, '', 'poly_nonsense']) {
      const r = resolveParcel(id);
      expect(r.presetId).toBe(DEFAULT_PARCEL_ID);
      expect(r.dims).toEqual(defaultParcel());
    }
  });

  it('defaults to a MEDIUM mailer, not the smallest one', () => {
    // An unknown parcel must never quote cheaper than it actually ships, or every
    // listing that skipped the step under-charges the buyer and BIDit eats it.
    const smallest = [...PARCEL_PRESETS].sort((a, b) => vol(a) - vol(b))[0]!;
    expect(DEFAULT_PARCEL_ID).not.toBe(smallest.id);
    expect(vol(defaultParcel())).toBeGreaterThan(vol(smallest));
  });
});

describe('combineParcels', () => {
  const mailer = defaultParcel();

  it('leaves a single item in its own package', () => {
    const r = combineParcels([mailer]);
    expect(r.dims).toEqual(mailer);
  });

  it('keeps a handful of flat items in the one mailer they fit in', () => {
    // A polymailer is mostly air. Summing the items' PACKAGE volumes used to put
    // two sleeved cards in a large box, which was an eight dollar overcharge on
    // the most common multi-item shipment there is.
    for (const n of [2, 3, 5, 8]) {
      const r = combineParcels(Array.from({ length: n }, () => mailer));
      expect(r.dims, `${n} cards`).toEqual(mailer);
    }
  });

  it('steps up once a mailer genuinely will not hold them', () => {
    const ten = combineParcels(Array.from({ length: 10 }, () => mailer));
    expect(vol(ten.dims)).toBeGreaterThan(vol(mailer));
    expect(findParcelPreset(ten.presetId)).not.toBeNull(); // a real preset, not an invented box
  });

  it('gives every extra BOX its own step, because boxes do not nest', () => {
    // Two booster boxes cannot share the box one of them came in, so unlike
    // mailers each additional one moves up a size.
    const box = { lengthMm: findParcelPreset('box_9x6x3')!.lengthMm, widthMm: findParcelPreset('box_9x6x3')!.widthMm, heightMm: findParcelPreset('box_9x6x3')!.heightMm };
    const one = combineParcels([box]);
    const two = combineParcels([box, box]);
    const three = combineParcels([box, box, box]);
    expect(vol(two.dims)).toBeGreaterThan(vol(one.dims));
    expect(vol(three.dims)).toBeGreaterThan(vol(two.dims));
  });

  it('never returns a package shorter than the longest item', () => {
    // Volume alone is not enough: a long card cannot be folded into a cube of
    // equal volume, so the chosen box has to be long enough to physically hold it.
    const long = findParcelPreset('poly_10x13')!;
    const longDims = { lengthMm: long.lengthMm, widthMm: long.widthMm, heightMm: long.heightMm };
    const r = combineParcels([longDims, longDims]);
    expect(Math.max(r.dims.lengthMm, r.dims.widthMm)).toBeGreaterThanOrEqual(
      Math.max(longDims.lengthMm, longDims.widthMm),
    );
  });

  it('builds a custom package when the table runs out, instead of under-quoting', () => {
    const biggest = [...PARCEL_PRESETS].sort((a, b) => vol(b) - vol(a))[0]!;
    const big = { lengthMm: biggest.lengthMm, widthMm: biggest.widthMm, heightMm: biggest.heightMm };
    const r = combineParcels(Array.from({ length: 8 }, () => big));
    expect(r.presetId).toBe(CUSTOM_PARCEL_ID);
    expect(vol(r.dims)).toBeGreaterThan(vol(big));
  });

  it('is monotonic: more items never produce a smaller package', () => {
    let previous = 0;
    for (let n = 1; n <= 6; n += 1) {
      const r = combineParcels(Array.from({ length: n }, () => mailer));
      expect(vol(r.dims)).toBeGreaterThanOrEqual(previous);
      previous = vol(r.dims);
    }
  });

  it('handles an empty set without throwing', () => {
    expect(combineParcels([]).dims).toEqual(defaultParcel());
  });
});
