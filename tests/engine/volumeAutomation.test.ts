import { describe, it, expect } from 'vitest';
import {
  firstPointAtOrAfter,
  movePoint,
  normalizePoints,
  valueAtBeat,
  withPoint,
  withoutPoint,
} from '@/engine/volumeAutomation';
import type { AutomationPoint } from '@/types/music';

const fade: AutomationPoint[] = [
  { beat: 4, value: 1 },
  { beat: 8, value: 0 },
];

describe('valueAtBeat', () => {
  it('returns the fallback when there are no points', () => {
    expect(valueAtBeat([], 3, 0.6)).toBe(0.6);
  });

  it('holds the first point value before it', () => {
    expect(valueAtBeat(fade, 0, 0.2)).toBe(1);
    expect(valueAtBeat(fade, 3.99, 0.2)).toBe(1);
  });

  it('holds the last point value after it', () => {
    expect(valueAtBeat(fade, 8, 0.2)).toBe(0);
    expect(valueAtBeat(fade, 100, 0.2)).toBe(0);
  });

  it('interpolates linearly between two points', () => {
    expect(valueAtBeat(fade, 6, 0.2)).toBeCloseTo(0.5);
    expect(valueAtBeat(fade, 5, 0.2)).toBeCloseTo(0.75);
    expect(valueAtBeat(fade, 7, 0.2)).toBeCloseTo(0.25);
  });

  it('reads a single point as a flat line', () => {
    const one = [{ beat: 4, value: 0.3 }];
    expect(valueAtBeat(one, 0, 1)).toBe(0.3);
    expect(valueAtBeat(one, 4, 1)).toBe(0.3);
    expect(valueAtBeat(one, 40, 1)).toBe(0.3);
  });

  it('interpolates across a segment of zero width without dividing by zero', () => {
    // Not reachable through the store, which dedupes, but a hand-edited file could.
    const stacked = [
      { beat: 4, value: 1 },
      { beat: 4, value: 0 },
    ];
    expect(Number.isFinite(valueAtBeat(stacked, 4, 0.5))).toBe(true);
  });

  it('returns the fallback for a non-finite beat rather than NaN', () => {
    expect(valueAtBeat(fade, Number.NaN, 0.6)).toBe(0.6);
  });
});

describe('normalizePoints', () => {
  it('sorts by beat', () => {
    const sorted = normalizePoints([
      { beat: 8, value: 0 },
      { beat: 0, value: 1 },
      { beat: 4, value: 0.5 },
    ]);
    expect(sorted.map(p => p.beat)).toEqual([0, 4, 8]);
  });

  it('dedupes on beat, later winning', () => {
    const deduped = normalizePoints([
      { beat: 4, value: 1 },
      { beat: 4, value: 0.25 },
    ]);
    expect(deduped).toEqual([{ beat: 4, value: 0.25 }]);
  });

  it('drops non-finite entries', () => {
    const cleaned = normalizePoints([
      { beat: Number.NaN, value: 1 },
      { beat: 2, value: Number.POSITIVE_INFINITY },
      { beat: 4, value: 0.5 },
    ]);
    expect(cleaned).toEqual([{ beat: 4, value: 0.5 }]);
  });

  it('drops out-of-range entries', () => {
    const cleaned = normalizePoints([
      { beat: -1, value: 0.5 },
      { beat: 2, value: 1.5 },
      { beat: 3, value: -0.2 },
      { beat: 4, value: 0.5 },
    ]);
    expect(cleaned).toEqual([{ beat: 4, value: 0.5 }]);
  });

  it('ignores anything that is not an array of points', () => {
    expect(normalizePoints(undefined as never)).toEqual([]);
    expect(normalizePoints([null, 3, { beat: 1 }] as never)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [
      { beat: 8, value: 0 },
      { beat: 0, value: 1 },
    ];
    normalizePoints(input);
    expect(input[0].beat).toBe(8);
  });
});

describe('withPoint', () => {
  it('inserts in beat order', () => {
    expect(withPoint(fade, { beat: 6, value: 0.5 }).map(p => p.beat)).toEqual([4, 6, 8]);
  });

  it('replaces a point already on that beat', () => {
    expect(withPoint(fade, { beat: 4, value: 0.1 })).toEqual([
      { beat: 4, value: 0.1 },
      { beat: 8, value: 0 },
    ]);
  });

  it('clamps an out-of-range point rather than dropping it', () => {
    expect(withPoint([], { beat: -2, value: 3 })).toEqual([{ beat: 0, value: 1 }]);
  });
});

describe('movePoint', () => {
  it('moves a point and re-sorts', () => {
    expect(movePoint(fade, 0, { beat: 12, value: 0.5 })).toEqual([
      { beat: 8, value: 0 },
      { beat: 12, value: 0.5 },
    ]);
  });

  it('replaces the occupant when it lands on another point', () => {
    expect(movePoint(fade, 0, { beat: 8, value: 0.5 })).toEqual([{ beat: 8, value: 0.5 }]);
  });

  it('leaves the list alone for an index that is not there', () => {
    expect(movePoint(fade, 7, { beat: 1, value: 1 })).toEqual(fade);
  });
});

describe('withoutPoint', () => {
  it('removes by index', () => {
    expect(withoutPoint(fade, 0)).toEqual([{ beat: 8, value: 0 }]);
  });

  it('leaves the list alone for an index that is not there', () => {
    expect(withoutPoint(fade, 9)).toEqual(fade);
  });
});

describe('firstPointAtOrAfter', () => {
  it('finds the first point at or after a beat', () => {
    expect(firstPointAtOrAfter(fade, 0)).toBe(0);
    expect(firstPointAtOrAfter(fade, 4)).toBe(0);
    expect(firstPointAtOrAfter(fade, 4.5)).toBe(1);
    expect(firstPointAtOrAfter(fade, 8)).toBe(1);
  });

  it('returns the length when every point is behind the beat', () => {
    expect(firstPointAtOrAfter(fade, 9)).toBe(2);
    expect(firstPointAtOrAfter([], 0)).toBe(0);
  });
});
