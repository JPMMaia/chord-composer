import { describe, expect, it } from 'vitest';
import {
  MAX_RAMP_SECONDS,
  MIN_STEP_SECONDS,
  rampPoints,
} from '@/engine/controllerRamp';

/** A normalised value from a controller number, as a lane stores one. */
const step = (controller: number) => controller / 127;

/** The controller numbers a run of points says, in order. */
const numbers = (points: { value: number }[]) =>
  points.map(p => Math.round(p.value * 127));

describe('rampPoints', () => {
  // The contract the caller depends on: whatever the line does on the way, the
  // curve still states the value it states at the moment it states it.
  it('always arrives at the value it was asked for, at the moment it was due', () => {
    const points = rampPoints(step(0), step(100), 1.0, 1.02);
    const last = points[points.length - 1];

    expect(last.value).toBe(step(100));
    expect(last.when).toBe(1.02);
  });

  it('sends one point when the values are already neighbours', () => {
    expect(rampPoints(step(64), step(65), 1.0, 1.01)).toEqual([
      { value: step(65), when: 1.01 },
    ]);
  });

  // A big jump is the whole reason this exists: a harp plucks a string per step,
  // so the steps skipped are notes that never sound and the ones sent all land
  // together.
  it('walks every controller step across a jump', () => {
    const points = rampPoints(step(60), step(70), 1.0, 1.02);

    expect(numbers(points)).toEqual([61, 62, 63, 64, 65, 66, 67, 68, 69, 70]);
  });

  it('spreads the walk evenly over the time it was given', () => {
    const points = rampPoints(step(0), step(4), 1.0, 1.02);

    expect(points.map(p => Number(p.when.toFixed(4)))).toEqual([
      1.005, 1.01, 1.015, 1.02,
    ]);
  });

  it('walks downward the same way', () => {
    const points = rampPoints(step(70), step(65), 1.0, 1.01);

    expect(numbers(points)).toEqual([69, 68, 67, 66, 65]);
  });

  // The first move of a run walks too. Where it walks *from* is known — the value
  // the curve was pinned at — and only the moment it was pinned at is not, so the
  // line takes its full length rather than being refused.
  it('walks the first move after a pin, over the longest line it may draw', () => {
    const points = rampPoints(step(0), step(100), Number.NEGATIVE_INFINITY, 1.0);

    expect(points.length).toBeGreaterThan(10);
    // The first value of the walk is one increment in, not at the very start of
    // the line: the controller is already sitting at `from`.
    expect(points[0].when).toBeCloseTo(1.0 - MAX_RAMP_SECONDS, 2);
    expect(points[0].when).toBeGreaterThan(1.0 - MAX_RAMP_SECONDS);
    expect(points.at(-1)).toEqual({ value: step(100), when: 1.0 });
  });

  it('sends the value alone when there is no time between the two', () => {
    expect(rampPoints(step(0), step(100), 1.0, 1.0)).toEqual([
      { value: step(100), when: 1.0 },
    ]);
  });

  // The rate limit. A near-vertical edge cannot be walked one step at a time in
  // the time it has, and the answer is the smallest increments that fit rather
  // than the jump it would otherwise be.
  it('walks in bigger increments than a step when the edge is too steep', () => {
    const points = rampPoints(step(0), step(127), 1.0, 1.005);

    // Five milliseconds is five points at the closest two may be sent.
    expect(points).toHaveLength(5);
    expect(numbers(points)).toEqual([25, 51, 76, 102, 127]);

    const gaps = points.slice(1).map((p, i) => p.when - points[i].when);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(MIN_STEP_SECONDS - 1e-9);
    }
  });

  // Even at its steepest the point is to be *smaller* than the jump: each of
  // those increments is a fraction of the leap that popped. A grid sample is ten
  // milliseconds, so this is the worst a sampled curve can actually ask for.
  it('breaks a full-range jump between two samples into ten', () => {
    const points = rampPoints(step(0), step(127), 1.0, 1.01);
    const jumps = numbers(points).map((n, i, all) => n - (i === 0 ? 0 : all[i - 1]));

    expect(points).toHaveLength(10);
    expect(Math.max(...jumps)).toBeLessThanOrEqual(13);
  });

  // And where there is genuinely no room, it says so rather than pretending: one
  // point, the jump, on time. A sampled curve never asks this; a caller routing
  // everything through here can.
  it('sends the jump when there is not even room for two values', () => {
    expect(rampPoints(step(0), step(127), 1.0, 1.0 + MIN_STEP_SECONDS)).toEqual([
      { value: step(127), when: 1.0 + MIN_STEP_SECONDS },
    ]);
  });

  // A curve holds a value for bars at a time and then moves. The line has to be
  // short relative to the look-ahead window, not relative to the silence behind
  // it, or half of it would be scheduled in the past.
  it('draws no line longer than the maximum, however long the value was held', () => {
    const points = rampPoints(step(0), step(127), 1.0, 10.0);

    expect(points[0].when).toBeGreaterThanOrEqual(10.0 - MAX_RAMP_SECONDS);
  });

  // Two points saying the same controller number is a point that does nothing,
  // and on a plugin that acts on movement it is a string plucked twice.
  it('says every step once', () => {
    for (const distance of [2, 3, 5, 17, 64, 127]) {
      const points = rampPoints(step(0), step(distance), 1.0, 1.02);
      const said = numbers(points);

      expect(new Set(said).size).toBe(said.length);
    }
  });

  // The moments must only ever move forward: a point placed behind one already
  // queued for the same parameter is pulled onto it natively, which is how a
  // pile-up on one sample starts.
  it('places the walk in increasing time', () => {
    const points = rampPoints(step(10), step(90), 1.0, 1.03);

    for (let i = 1; i < points.length; i++) {
      expect(points[i].when).toBeGreaterThan(points[i - 1].when);
    }
  });

  // A smooth sweep is the common case, and it must not be paying for any of
  // this: a curve moving a step or two per sample already is the line.
  it('changes nothing about a curve that was already moving smoothly', () => {
    const points = rampPoints(step(40), step(41), 1.0, 1.01);

    expect(points).toHaveLength(1);
  });
});
