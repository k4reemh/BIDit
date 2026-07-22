import { describe, it, expect } from 'vitest';
import {
  weightedPick,
  pickSlot,
  buildReel,
  seedFloat,
  normalizeWheelEntries,
  REEL_REPEATS,
  type WheelEntry,
} from '@bidit/shared';

const POOL: WheelEntry[] = [
  { label: 'Destined Rivals ETB', tier: 'Box' },
  { label: 'Sealed Booster Box', tier: 'Box' },
  { label: 'Charizard ex — Alt Art', tier: 'Chase' },
  { label: 'Single Booster Pack', tier: 'Pack' },
];

describe('randomizer: weightedPick', () => {
  it('maps the [0,1) range across all slots by position', () => {
    expect(weightedPick(POOL, 0)).toBe(0);
    expect(weightedPick(POOL, 0.24)).toBe(0);
    expect(weightedPick(POOL, 0.26)).toBe(1);
    expect(weightedPick(POOL, 0.51)).toBe(2);
    expect(weightedPick(POOL, 0.99)).toBe(3);
  });

  it('clamps out-of-range r into the valid slots', () => {
    expect(weightedPick(POOL, -5)).toBe(0);
    expect(weightedPick(POOL, 5)).toBe(POOL.length - 1);
  });

  it('respects weights — a heavier slot owns a larger share of the range', () => {
    const weighted: WheelEntry[] = [
      { label: 'common', weight: 8 },
      { label: 'rare', weight: 2 },
    ];
    let common = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) {
      if (weightedPick(weighted, i / N) === 0) common++;
    }
    // ~80% should land on the weight-8 slot.
    expect(common / N).toBeGreaterThan(0.78);
    expect(common / N).toBeLessThan(0.82);
  });

  it('treats missing/<=0 weight as 1', () => {
    const e: WheelEntry[] = [{ label: 'a' }, { label: 'b', weight: 0 }, { label: 'c', weight: -3 }];
    // three equal slots
    expect(weightedPick(e, 0.1)).toBe(0);
    expect(weightedPick(e, 0.5)).toBe(1);
    expect(weightedPick(e, 0.9)).toBe(2);
  });

  it('throws on an empty wheel', () => {
    expect(() => weightedPick([], 0.5)).toThrow();
  });
});

describe('randomizer: pickSlot is deterministic from a seed', () => {
  it('same seed -> same slot, every time', () => {
    const a = pickSlot(POOL, 'deadbeefcafe');
    const b = pickSlot(POOL, 'deadbeefcafe');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(POOL.length);
  });

  it('different seeds spread across the pool', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(pickSlot(POOL, `seed-${i}`));
    expect(seen.size).toBe(POOL.length);
  });
});

describe('randomizer: seedFloat', () => {
  it('is in [0,1) and reproducible', () => {
    for (const s of ['x', 'abc123', '00', 'ffffffff']) {
      const v = seedFloat(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(seedFloat(s)).toBe(v);
    }
  });
});

describe('randomizer: buildReel', () => {
  it('repeats the pool and lands the target on the chosen prize', () => {
    const prizeIndex = 2;
    const { reel, targetIndex } = buildReel(POOL, prizeIndex);
    expect(reel.length).toBe(REEL_REPEATS * POOL.length);
    // the row that lands in the centre IS the chosen prize
    expect(reel[targetIndex]!.label).toBe(POOL[prizeIndex]!.label);
    // and it sits deep enough in the strip for a long decelerating run
    expect(targetIndex).toBeGreaterThanOrEqual(POOL.length * 2);
  });

  it('carries the tier through to the reel slots', () => {
    const { reel } = buildReel(POOL, 0);
    expect(reel[0]!.tier).toBe('Box');
  });

  it('throws on an empty wheel', () => {
    expect(() => buildReel([], 0)).toThrow();
  });
});

describe('randomizer: normalizeWheelEntries', () => {
  it('keeps valid entries and trims labels', () => {
    const out = normalizeWheelEntries([{ label: '  ETB  ', tier: 'Box', weight: 3 }]);
    expect(out).toEqual([{ label: 'ETB', tier: 'Box', weight: 3 }]);
  });

  it('drops entries with no usable label', () => {
    const out = normalizeWheelEntries([{ label: '' }, { label: '   ' }, { weight: 2 }, 'nope', null, { label: 'Good' }]);
    expect(out).toEqual([{ label: 'Good' }]);
  });

  it('omits empty optional fields entirely (clean JSON for storage)', () => {
    const out = normalizeWheelEntries([{ label: 'X', tier: '', weight: 0, imageUrl: '   ' }]);
    expect(out).toEqual([{ label: 'X' }]);
    expect('weight' in out[0]!).toBe(false);
    expect('tier' in out[0]!).toBe(false);
  });

  it('caps the wheel size and clamps label length (M9 — realtime-DoS guard)', () => {
    const huge = Array.from({ length: 500 }, (_, i) => ({ label: `p${i}` }));
    expect(normalizeWheelEntries(huge).length).toBe(64); // MAX_WHEEL_ENTRIES
    const longLabel = normalizeWheelEntries([{ label: 'z'.repeat(1000) }]);
    expect(longLabel[0]!.label.length).toBe(120); // MAX_WHEEL_LABEL_LEN
  });

  it('ignores negative/zero weights and non-string tiers', () => {
    const out = normalizeWheelEntries([{ label: 'A', weight: -5 }, { label: 'B', weight: 2.5, tier: 'Chase' }]);
    expect(out).toEqual([{ label: 'A' }, { label: 'B', weight: 2.5, tier: 'Chase' }]);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeWheelEntries(null)).toEqual([]);
    expect(normalizeWheelEntries('x')).toEqual([]);
    expect(normalizeWheelEntries(undefined)).toEqual([]);
  });
});
