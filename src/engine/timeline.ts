import type { Bar, ChordSegment, TimeSignature } from '@/types/music';
import { generateId } from '@/utils/id';

/**
 * Smallest editable segment length, in beats. Matches the piano roll's grid size
 * so resizing a chord and drawing a note snap to the same lattice.
 */
export const MIN_SEGMENT_BEATS = 0.25;

/** Snap a beat value to the editing grid, avoiding float drift (1.3 -> 1.25). */
function snapToGrid(beats: number): number {
  return Math.round(beats / MIN_SEGMENT_BEATS) * MIN_SEGMENT_BEATS;
}

/** Beat units the app understands: the powers of two from a half note to a sixteenth. */
const VALID_BEAT_UNITS = [2, 4, 8, 16];

/**
 * Single source of truth for time-signature validity, shared by the project-level
 * setter, the per-bar setter and file validation, which previously disagreed about
 * which beat units were legal.
 */
export function isValidTimeSignature(ts: TimeSignature | undefined | null): boolean {
  if (!ts) return false;
  if (typeof ts.beatsPerMeasure !== 'number' || !Number.isFinite(ts.beatsPerMeasure)) return false;
  // A one-beat bar is not a meter the editor can express, and the project-level
  // setter has always rejected it.
  if (ts.beatsPerMeasure < 2) return false;
  return VALID_BEAT_UNITS.includes(ts.beatUnit);
}

/**
 * Returns the number of beats a bar holds, preferring its own time signature
 * and falling back to the project's.
 */
export function getBarBeats(bar: Bar, projectTs: TimeSignature): number {
  return (bar.timeSignature ?? projectTs).beatsPerMeasure;
}

/**
 * Returns the absolute beat at which a bar starts, accumulating the lengths of
 * all preceding bars. Bars may have differing time signatures, so this cannot be
 * a simple multiplication.
 */
export function getBarStartBeat(
  bars: Bar[],
  barIndex: number,
  projectTs: TimeSignature
): number {
  let start = 0;
  for (let i = 0; i < barIndex && i < bars.length; i++) {
    start += getBarBeats(bars[i], projectTs);
  }
  return start;
}

/** Total length of the project in beats. */
export function getTotalBeats(bars: Bar[], projectTs: TimeSignature): number {
  return bars.reduce((sum, bar) => sum + getBarBeats(bar, projectTs), 0);
}

/** Concatenate every bar's segments into one ordered list. */
export function flattenSegments(bars: Bar[]): ChordSegment[] {
  return bars.flatMap(bar => bar.chords);
}

/**
 * Re-assign a flat segment list back onto bars.
 *
 * Each bar is filled to its capacity in order. A segment that does not fit in
 * the space remaining is moved *wholly* into the next bar rather than being split
 * across the bar line — the leftover space simply stays empty. Bars are appended
 * as needed so no segment is ever dropped.
 *
 * Every bar's `notes`, `scale`, `id` and `timeSignature` are preserved; only
 * `chords` and `barIndex` are rewritten.
 */
export function reflowSegments(
  segments: ChordSegment[],
  bars: Bar[],
  projectTs: TimeSignature
): Bar[] {
  // Always keep at least one bar to drop into.
  const source = bars.length > 0 ? bars : [createBar(0, bars)];

  const result: Bar[] = source.map(bar => ({ ...bar, chords: [] }));

  let barIndex = 0;
  let used = 0;

  for (const segment of segments) {
    // Grow the bar list on demand when we run past the last existing bar.
    if (barIndex >= result.length) {
      result.push(createBar(result.length, result));
      used = 0;
    }

    const capacity = getBarBeats(result[barIndex], projectTs);

    // A segment longer than a whole bar still has to live somewhere: give it its
    // own bar rather than looping forever looking for room it will never find.
    if (used > 0 && used + segment.duration > capacity) {
      barIndex++;
      used = 0;
      if (barIndex >= result.length) {
        result.push(createBar(result.length, result));
      }
    }

    result[barIndex].chords.push(segment);
    used += segment.duration;

    if (used >= getBarBeats(result[barIndex], projectTs)) {
      barIndex++;
      used = 0;
    }
  }

  return result.map((bar, i) => ({ ...bar, barIndex: i }));
}

/**
 * Build a fresh empty bar, inheriting the scale and meter of the bar before it so
 * that overflowing into new territory does not silently change key or metre.
 */
function createBar(index: number, existing: Bar[]): Bar {
  const previous = existing[existing.length - 1];
  return {
    id: generateId(),
    barIndex: index,
    timeSignature: previous?.timeSignature,
    scale: previous ? { ...previous.scale } : { root: 'C', type: 'major' },
    chords: [],
    notes: [],
  };
}

/** Insert a segment at `index`, appending when the index is past the end. */
export function insertSegmentAt(
  segments: ChordSegment[],
  segment: ChordSegment,
  index: number
): ChordSegment[] {
  const result = [...segments];
  const clamped = Math.max(0, Math.min(index, result.length));
  result.splice(clamped, 0, segment);
  return result;
}

/** Remove a segment by id. Unknown ids are a no-op. */
export function removeSegmentById(
  segments: ChordSegment[],
  id: string
): ChordSegment[] {
  return segments.filter(s => s.id !== id);
}

/**
 * Set a segment's duration, snapped to the grid and clamped to at least one grid
 * step. Pass `maxBeats` (usually the containing bar's capacity) to cap it.
 */
export function resizeSegment(
  segments: ChordSegment[],
  id: string,
  duration: number,
  maxBeats?: number
): ChordSegment[] {
  let next = Math.max(MIN_SEGMENT_BEATS, snapToGrid(duration));
  if (maxBeats !== undefined) {
    next = Math.min(next, maxBeats);
  }
  return segments.map(s => (s.id === id ? { ...s, duration: next } : s));
}

/**
 * Map an absolute beat offset to the index at which a dropped segment should be
 * inserted. Within a segment the nearer boundary wins, so dropping on the left
 * half inserts before it and the right half after it.
 */
export function beatToInsertIndex(segments: ChordSegment[], beat: number): number {
  if (segments.length === 0) return 0;

  let start = 0;
  for (let i = 0; i < segments.length; i++) {
    const { duration } = segments[i];
    if (beat < start + duration) {
      return beat < start + duration / 2 ? i : i + 1;
    }
    start += duration;
  }

  return segments.length;
}
