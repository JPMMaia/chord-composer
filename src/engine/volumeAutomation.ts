import type { AutomationPoint } from '@/types/music';

/**
 * A parameter's value over time, as breakpoints with linear ramps between them.
 *
 * Kept free of React and Web Audio so it can be tested with plain numbers, in the
 * spirit of `@/engine/scheduler`. Positions are in beats throughout: the caller
 * scales them to seconds, which is what lets a curve survive a tempo change.
 *
 * `normalizePoints` is the single gate every stored list passes through — the store
 * on every edit, the file loader on read, the exporter before it walks a curve — so
 * nothing downstream has to defend against an unsorted, duplicated or malformed
 * array.
 */

/** Clamp to the 0-1 range every level in this app is expressed in. */
function clampValue(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Whether a value off a file or a pointer is a usable point. */
function isPoint(point: unknown): point is AutomationPoint {
  if (typeof point !== 'object' || point === null) return false;
  const { beat, value } = point as AutomationPoint;
  return (
    typeof beat === 'number' &&
    typeof value === 'number' &&
    Number.isFinite(beat) &&
    Number.isFinite(value) &&
    beat >= 0 &&
    value >= 0 &&
    value <= 1
  );
}

/**
 * Sorted by beat, deduped, and stripped of anything unusable.
 *
 * A duplicated beat resolves to the *later* entry, so an edit that lands a point on
 * top of another reads as replacing it rather than as being silently refused.
 */
export function normalizePoints(points: AutomationPoint[]): AutomationPoint[] {
  if (!Array.isArray(points)) return [];

  const sorted = points
    .filter(isPoint)
    .map(p => ({ beat: p.beat, value: p.value }))
    .sort((a, b) => a.beat - b.beat);

  const deduped: AutomationPoint[] = [];
  for (const point of sorted) {
    if (deduped.length > 0 && deduped[deduped.length - 1].beat === point.beat) {
      deduped[deduped.length - 1] = point;
    } else {
      deduped.push(point);
    }
  }

  return deduped;
}

/**
 * The level at a beat.
 *
 * Holds the first point's value before it and the last point's after it, so a curve
 * never implies a fade to silence nobody asked for — a single point is a flat line,
 * not a ramp from zero. Between two points the value is interpolated linearly.
 *
 * @param fallback - The level when there are no points at all, i.e. `Track.volume`.
 */
export function valueAtBeat(
  points: AutomationPoint[],
  beat: number,
  fallback: number
): number {
  if (points.length === 0 || !Number.isFinite(beat)) return fallback;

  const first = points[0];
  if (beat <= first.beat) return first.value;

  const last = points[points.length - 1];
  if (beat >= last.beat) return last.value;

  for (let i = 1; i < points.length; i++) {
    const next = points[i];
    if (next.beat < beat) continue;

    const previous = points[i - 1];
    const span = next.beat - previous.beat;
    // Two points on one beat cannot come from the store, which dedupes, but a
    // hand-edited file can produce them; reading the later one is the same rule
    // `normalizePoints` applies.
    if (span <= 0) return next.value;

    const progress = (beat - previous.beat) / span;
    return previous.value + (next.value - previous.value) * progress;
  }

  return last.value;
}

/**
 * `points` with one added. A point already on that beat is replaced.
 *
 * The new point is clamped rather than dropped: it comes from a click in the lane,
 * where a value past the edge means the pointer left the lane, not a bad input.
 */
export function withPoint(
  points: AutomationPoint[],
  point: AutomationPoint
): AutomationPoint[] {
  const clamped = {
    beat: Math.max(0, Number.isFinite(point.beat) ? point.beat : 0),
    value: clampValue(Number.isFinite(point.value) ? point.value : 0),
  };
  return normalizePoints([...points.filter(p => p.beat !== clamped.beat), clamped]);
}

/**
 * `points` with the one at `index` moved to a new position.
 *
 * Re-sorts, so a point dragged past its neighbour ends up where it was dropped; a
 * move landing on another point replaces it, which is what makes dragging one point
 * onto another read as merging rather than as stacking two invisible ones.
 */
export function movePoint(
  points: AutomationPoint[],
  index: number,
  point: AutomationPoint
): AutomationPoint[] {
  if (index < 0 || index >= points.length) return points;
  return withPoint(
    points.filter((_, i) => i !== index),
    point
  );
}

/** `points` without the one at `index`. An index that is not there is a no-op. */
export function withoutPoint(points: AutomationPoint[], index: number): AutomationPoint[] {
  if (index < 0 || index >= points.length) return points;
  return points.filter((_, i) => i !== index);
}

/**
 * Whether two curves say the same thing, down to every breakpoint.
 *
 * Absent and empty read as the same curve, since both mean "nothing is driving this".
 * Used to leave a no-op edit off the undo stack, and to hand a recompile back the
 * object it was given when nothing about it changed.
 */
export function samePoints(
  a: AutomationPoint[] | undefined,
  b: AutomationPoint[] | undefined
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length &&
    left.every((p, i) => p.beat === right[i].beat && p.value === right[i].value)
  );
}

/**
 * Index of the first point at or after `beat`, or `points.length` when every point
 * is behind it. The scheduling cursor's seek, used to pick up a curve part-way
 * through after a Play from the middle or a loop wrap.
 */
export function firstPointAtOrAfter(points: AutomationPoint[], beat: number): number {
  for (let i = 0; i < points.length; i++) {
    if (points[i].beat >= beat) return i;
  }
  return points.length;
}
