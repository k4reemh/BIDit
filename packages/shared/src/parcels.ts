/**
 * Parcel presets: the package a seller says an item ships in.
 *
 * Shipping is priced on billable weight AND size, so "estimated weight" alone
 * cannot produce a real carrier rate. Sellers pick one of these instead of
 * measuring, which makes the common case one click and gives the rate engine a
 * concrete parcel to quote.
 *
 * Ids are STABLE and stored on the listing. Renaming a label is safe; changing
 * an id orphans every listing that saved it. Dimensions are canonical in
 * millimetres (integers, no float drift) and displayed in inches, because North
 * American sellers buy mailers by the inch.
 *
 * The dimensions here are the mailer/box as sold. Listings snapshot the resolved
 * millimetres alongside the id, so editing this table later reprices new
 * listings without silently repricing old ones.
 */

export type ParcelKind = 'polymailer' | 'box' | 'custom';

export interface ParcelPreset {
  id: string;
  label: string;
  kind: ParcelKind;
  /** Inches, for display. The source of truth for the millimetres below. */
  inches: { length: number; width: number; height: number };
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  /** Typical loaded weight in grams. Prefills the weight field; the seller can
   *  always override, and this is never used in place of a real answer. */
  typicalGrams: number;
  /** One line under the label, so the seller can recognise their mailer. */
  hint: string;
}

const MM_PER_INCH = 25.4;
const mm = (inches: number) => Math.round(inches * MM_PER_INCH);

function preset(
  id: string,
  label: string,
  kind: ParcelKind,
  length: number,
  width: number,
  height: number,
  typicalGrams: number,
  hint: string,
): ParcelPreset {
  return {
    id,
    label,
    kind,
    inches: { length, width, height },
    lengthMm: mm(length),
    widthMm: mm(width),
    heightMm: mm(height),
    typicalGrams,
    hint,
  };
}

/**
 * Polymailer heights are the loaded thickness, not the flat height. A flat
 * mailer is 0mm thick and would quote as a letter, which is the wrong service
 * and the wrong price the moment anything rigid goes inside.
 */
export const PARCEL_PRESETS: ParcelPreset[] = [
  preset('poly_6x9', 'Small polymailer', 'polymailer', 6, 9, 0.5, 60, 'A few sleeved cards or one toploader'),
  preset('poly_9x12', 'Medium polymailer', 'polymailer', 9, 12, 0.75, 150, 'A stack of cards, a graded slab'),
  preset('poly_10x13', 'Large polymailer', 'polymailer', 10, 13, 1, 300, 'Several slabs, a small sealed pack'),
  preset('box_6x4x2', 'Small box', 'box', 6, 4, 2, 250, 'One or two slabs, boxed'),
  preset('box_9x6x3', 'Medium box', 'box', 9, 6, 3, 700, 'A booster box, a bundle'),
  preset('box_12x9x4', 'Large box', 'box', 12, 9, 4, 1500, 'Multiple sealed products'),
  preset('box_14x12x6', 'Extra large box', 'box', 14, 12, 6, 3500, 'A sealed case, bulk lots'),
];

/** The id stored when a seller enters their own dimensions. */
export const CUSTOM_PARCEL_ID = 'custom';

export function findParcelPreset(id: string | null | undefined): ParcelPreset | null {
  if (!id) return null;
  return PARCEL_PRESETS.find((p) => p.id === id) ?? null;
}

/** Resolved parcel: what actually gets quoted. */
export interface ParcelDims {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}

/** Fallback when a listing predates presets or a seller skipped the step: the
 *  medium polymailer, which is the modal BIDit package. Deliberately not the
 *  smallest, so an unknown parcel is never quoted cheaper than it ships. */
export const DEFAULT_PARCEL_ID = 'poly_9x12';

export function defaultParcel(): ParcelDims {
  const p = findParcelPreset(DEFAULT_PARCEL_ID)!;
  return { lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm };
}

/** Largest custom parcel we accept, per side. Beyond this every carrier is into
 *  freight, which BIDit does not sell. */
export const MAX_PARCEL_MM = 3000; // 3m
export const MIN_PARCEL_MM = 10; // 1cm

export class ParcelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParcelError';
  }
}

/**
 * Resolve what a seller submitted into concrete millimetres. A preset id wins
 * over supplied dimensions, so a client cannot claim `poly_6x9` and attach
 * freight-sized numbers.
 */
export function resolveParcel(
  presetId: string | null | undefined,
  custom?: Partial<ParcelDims> | null,
): { presetId: string; dims: ParcelDims } {
  const found = findParcelPreset(presetId);
  if (found) {
    return { presetId: found.id, dims: { lengthMm: found.lengthMm, widthMm: found.widthMm, heightMm: found.heightMm } };
  }
  if (presetId === CUSTOM_PARCEL_ID) {
    const dims = {
      lengthMm: Math.round(Number(custom?.lengthMm)),
      widthMm: Math.round(Number(custom?.widthMm)),
      heightMm: Math.round(Number(custom?.heightMm)),
    };
    for (const [name, v] of Object.entries(dims)) {
      if (!Number.isFinite(v) || v < MIN_PARCEL_MM || v > MAX_PARCEL_MM) {
        throw new ParcelError(`Enter a ${name.replace('Mm', '')} between 1cm and 3m.`);
      }
    }
    return { presetId: CUSTOM_PARCEL_ID, dims };
  }
  return { presetId: DEFAULT_PARCEL_ID, dims: defaultParcel() };
}

// ---------------------------------------------------------------------------
// Rate class
// ---------------------------------------------------------------------------

/** Carriers price a flat mailer, a small parcel and a bulky parcel differently,
 *  and that step is most of what package size costs. Three classes is enough
 *  resolution for an estimate. */
export type PackageClass = 'polymailer' | 'small_box' | 'large_box';

const CLASS_BY_PRESET: Record<string, PackageClass> = {
  poly_6x9: 'polymailer',
  poly_9x12: 'polymailer',
  poly_10x13: 'polymailer',
  box_6x4x2: 'small_box',
  box_9x6x3: 'small_box',
  box_12x9x4: 'large_box',
  box_14x12x6: 'large_box',
};

/** Thicker than this is a parcel however flat its footprint: a mailer that will
 *  not go through a sorting slot is not priced as a mailer. */
const MAILER_MAX_THICKNESS_MM = 40;

const presetVolume = (id: string) => {
  const p = findParcelPreset(id)!;
  return p.lengthMm * p.widthMm * p.heightMm;
};

/** Rate class for a parcel. A known preset answers directly; a custom size is
 *  classified by thickness and volume, erring upward so an odd package is never
 *  quoted as the cheapest class. */
export function packageClass(presetId: string | null | undefined, dims: ParcelDims): PackageClass {
  const known = presetId ? CLASS_BY_PRESET[presetId] : undefined;
  if (known) return known;
  const volume = dims.lengthMm * dims.widthMm * dims.heightMm;
  if (dims.heightMm <= MAILER_MAX_THICKNESS_MM && volume <= presetVolume('poly_10x13')) return 'polymailer';
  if (volume <= presetVolume('box_9x6x3')) return 'small_box';
  return 'large_box';
}

// ---------------------------------------------------------------------------
// Combining several won items into one package
// ---------------------------------------------------------------------------

/** Packing is never perfect: items do not tessellate and need padding. */
const PACKING_FACTOR = 1.15;

const volume = (d: ParcelDims) => d.lengthMm * d.widthMm * d.heightMm;

/**
 * The package a multi-item shipment actually needs.
 *
 * This replaces the old flat "+3% per extra item" surcharge, which had nothing
 * to do with what a carrier charges: two slabs in one mailer cost the same to
 * post as one, while ten of them need a box and a different rate entirely.
 *
 * Two constraints, both required. The result must hold the combined padded
 * volume, AND it must be at least as large as the biggest single item, since a
 * long card cannot be folded into a cube of equal volume.
 */
export function combineParcels(parcels: ParcelDims[]): { presetId: string; dims: ParcelDims } {
  if (parcels.length === 0) return { presetId: DEFAULT_PARCEL_ID, dims: defaultParcel() };
  if (parcels.length === 1) {
    const only = parcels[0]!;
    const exact = PARCEL_PRESETS.find(
      (p) => p.lengthMm === only.lengthMm && p.widthMm === only.widthMm && p.heightMm === only.heightMm,
    );
    return { presetId: exact?.id ?? CUSTOM_PARCEL_ID, dims: only };
  }

  const needed = parcels.reduce((v, p) => v + volume(p), 0) * PACKING_FACTOR;
  const longestSide = Math.max(...parcels.map((p) => Math.max(p.lengthMm, p.widthMm)));

  const ordered = [...PARCEL_PRESETS].sort((a, b) => volume(a) - volume(b));
  for (const p of ordered) {
    if (volume(p) >= needed && Math.max(p.lengthMm, p.widthMm) >= longestSide) {
      return { presetId: p.id, dims: { lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm } };
    }
  }

  // Nothing in the table fits. Build a custom parcel rather than quoting the
  // largest preset, which would under-quote a genuinely oversized shipment.
  const largest = ordered[ordered.length - 1]!;
  const base = { lengthMm: largest.lengthMm, widthMm: largest.widthMm, heightMm: largest.heightMm };
  const grow = Math.max(1, needed / volume(base));
  return {
    presetId: CUSTOM_PARCEL_ID,
    dims: {
      lengthMm: Math.min(MAX_PARCEL_MM, Math.max(base.lengthMm, longestSide)),
      widthMm: base.widthMm,
      // Height absorbs the overflow: stacking is how a taller box is made.
      heightMm: Math.min(MAX_PARCEL_MM, Math.round(base.heightMm * grow)),
    },
  };
}
