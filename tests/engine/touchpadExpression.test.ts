import { describe, it, expect } from 'vitest';
import {
  FULL_THROW_PX,
  applyMovement,
  clamp01,
  thin,
  toControllerValue,
  worthKeeping,
} from '@/engine/touchpadExpression';
import type { AutomationPoint } from '@/types/music';

const point = (beat: number, value: number): AutomationPoint => ({ beat, value });

describe('applyMovement', () => {
  it('raises the value when the finger moves up', () => {
    // `movementY` counts downward, so up is negative.
    expect(applyMovement(0.5, -FULL_THROW_PX / 2)).toBeCloseTo(1);
  });

  it('lowers it when the finger moves down', () => {
    expect(applyMovement(0.5, FULL_THROW_PX / 2)).toBeCloseTo(0);
  });

  it('scales a movement by the full throw', () => {
    expect(applyMovement(0, -32, 320)).toBeCloseTo(0.1);
    // Half the throw is twice as sensitive to the same finger travel.
    expect(applyMovement(0, -32, 160)).toBeCloseTo(0.2);
  });

  it('clamps at both ends rather than accumulating past them', () => {
    expect(applyMovement(0.9, -FULL_THROW_PX * 10)).toBe(1);
    expect(applyMovement(0.1, FULL_THROW_PX * 10)).toBe(0);
  });

  it('leaves the value alone on a non-finite movement', () => {
    // A latched NaN would never wash out: the value is accumulated, not measured.
    expect(applyMovement(0.4, NaN)).toBe(0.4);
    expect(applyMovement(0.4, Infinity)).toBe(0.4);
  });

  it('leaves it alone on a throw that could not scale anything', () => {
    expect(applyMovement(0.4, -100, 0)).toBe(0.4);
    expect(applyMovement(0.4, -100, -320)).toBe(0.4);
  });
});

describe('clamp01', () => {
  it('holds a value to 0-1', () => {
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.25)).toBe(0.25);
  });

  it('reads anything that is not a number as 0', () => {
    expect(clamp01(NaN)).toBe(0);
  });
});

describe('toControllerValue', () => {
  it('shows the ends as the controller numbers they are', () => {
    expect(toControllerValue(0)).toBe(0);
    expect(toControllerValue(1)).toBe(127);
  });

  it('rounds to the nearest controller step', () => {
    expect(toControllerValue(0.5)).toBe(64);
  });
});

describe('worthKeeping', () => {
  it('keeps the first sample of a gesture', () => {
    expect(worthKeeping(point(0, 0.5), null, 0.25)).toBe(true);
  });

  it('keeps a sample that lands on a different controller step', () => {
    // Exactly one step apart, which is the boundary case: 64 and 65.
    expect(worthKeeping(point(0.01, 65 / 127), point(0, 64 / 127), 0.25)).toBe(true);
  });

  it('drops a sub-controller-step repeat', () => {
    // A finger held still reports constantly; each report is a breakpoint the user
    // would otherwise have to delete. Both of these round to 64.
    expect(worthKeeping(point(0.01, 64.3 / 127), point(0, 64 / 127), 0.25)).toBe(false);
  });

  it('keeps one anyway once the gap has grown', () => {
    // A sweep played slowly is a run of sub-step samples; dropping all of them would
    // store the gesture as nothing.
    expect(worthKeeping(point(0.25, 0.5), point(0, 0.5), 0.25)).toBe(true);
  });
});

describe('thin', () => {
  it('keeps only what says something new', () => {
    const kept = thin(
      [point(0, 0.5), point(0.01, 0.5), point(0.02, 0.9), point(0.03, 0.9)],
      null,
      1000
    );
    expect(kept).toEqual([point(0, 0.5), point(0.02, 0.9)]);
  });

  it('carries the last kept point across a flush boundary', () => {
    // Restarting the thinning at every flush would let an unchanged value through
    // once every 100 ms for as long as the finger was held.
    expect(thin([point(0.01, 0.5)], point(0, 0.5), 1000)).toEqual([]);
  });

  it('measures the gap from the last point it kept, not the last it saw', () => {
    const kept = thin([point(0.1, 0.5), point(0.2, 0.5), point(0.3, 0.5)], point(0, 0.5), 0.25);
    expect(kept).toEqual([point(0.3, 0.5)]);
  });

  it('is empty for an empty batch', () => {
    expect(thin([], null, 0.25)).toEqual([]);
  });
});
