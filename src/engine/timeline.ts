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

/**
 * Snap resolutions offered in the timeline toolbar, labelled as note values.
 *
 * The beat figures assume a quarter-note beat: a whole note is four beats, a
 * sixteenth is a quarter of one — which is also `MIN_SEGMENT_BEATS`, so no option
 * can ask for a position finer than a segment can be.
 */
export const SNAP_OPTIONS = [
  { label: '1/1', beats: 4 },
  { label: '1/2', beats: 2 },
  { label: '1/4', beats: 1 },
  { label: '1/8', beats: 0.5 },
  { label: '1/16', beats: 0.25 },
] as const;

/** Quarter notes: the resolution most progressions are written at. */
export const DEFAULT_SNAP_BEATS = 1;

/**
 * Snap a beat to the chosen grid. The second rounding is not redundant: it pulls
 * the result back onto the 0.25 lattice so a chain of snapped edits cannot
 * accumulate float error.
 */
export function snapBeat(beat: number, snapBeats: number): number {
  if (!Number.isFinite(beat) || snapBeats <= 0) return 0;
  return Math.max(0, snapToGrid(Math.round(beat / snapBeats) * snapBeats));
}

/**
 * Keep a block wholly inside its bar. A block longer than the bar itself cannot be
 * made to fit, so it starts at 0 and simply overhangs — `refitBars` leaves it there
 * rather than looping looking for a bar it will never fit in.
 */
export function clampToBar(startBeat: number, duration: number, capacity: number): number {
  return Math.max(0, Math.min(startBeat, capacity - duration));
}

/** A segment's position, treating an absent one as "wherever the packing left off". */
function startOf(segment: ChordSegment, fallback: number): number {
  return typeof segment.startBeat === 'number' && Number.isFinite(segment.startBeat)
    ? segment.startBeat
    : fallback;
}

/**
 * Fill in any missing `startBeat` by packing segments in order.
 *
 * That packing is exactly what a position-less list used to mean — durations
 * accumulated from the start of the bar — so this is what lets projects saved before
 * free placement open with the positions they always had.
 */
export function withStartBeats(segments: ChordSegment[]): ChordSegment[] {
  let cursor = 0;
  return segments.map(segment => {
    const startBeat = startOf(segment, cursor);
    cursor = startBeat + segment.duration;
    return segment.startBeat === startBeat ? segment : { ...segment, startBeat };
  });
}

/** Order segments by position. */
function byStart(segments: ChordSegment[]): ChordSegment[] {
  return [...segments].sort((a, b) => startOf(a, 0) - startOf(b, 0));
}

/**
 * Place `segment` at `startBeat` within one bar, rippling whatever it lands on to
 * the right.
 *
 * A block is only moved if it actually overlaps the placed one, or overlaps a block
 * that was itself pushed — so the cascade stops at the first gap wide enough to
 * absorb the shift, and empty space elsewhere in the bar survives untouched. A block
 * pushed past `capacity` comes back in `overflow` for the caller to hand to the next
 * bar; nothing is ever dropped.
 *
 * Passing a segment already present moves it, rather than duplicating it.
 */
export function placeSegmentInBar(
  segments: ChordSegment[],
  segment: ChordSegment,
  startBeat: number,
  capacity: number
): { kept: ChordSegment[]; overflow: ChordSegment[] } {
  const placed = { ...segment, startBeat };
  const others = byStart(withStartBeats(segments.filter(s => s.id !== placed.id)));

  const kept: ChordSegment[] = [placed];
  const overflow: ChordSegment[] = [];
  let cursor = startBeat + placed.duration;

  for (const other of others) {
    const start = startOf(other, 0);

    // Entirely before the placed block: untouched, gap and all.
    if (start + other.duration <= startBeat) {
      kept.push(other);
      continue;
    }

    const shifted = Math.max(start, cursor);
    cursor = shifted + other.duration;

    if (cursor > capacity) {
      overflow.push(other);
      continue;
    }
    kept.push(shifted === start ? other : { ...other, startBeat: shifted });
  }

  return { kept: byStart(kept), overflow };
}

/**
 * Restore the bar invariant across the whole project: every segment positioned,
 * inside its bar, in order and non-overlapping.
 *
 * Anything that no longer fits — because a block grew, a bar narrowed, or a drop
 * rippled its neighbours — moves to the start of the following bar and keeps
 * cascading, appending bars as needed. Every mutation ends here, which is what keeps
 * one rule in one place.
 */
export function refitBars(bars: Bar[], projectTs: TimeSignature): Bar[] {
  if (bars.length === 0) return [];

  const result: Bar[] = [];
  let carried: ChordSegment[] = [];

  for (let i = 0; bars[i] || carried.length > 0; i++) {
    const source = bars[i] ?? createBar(result.length, result);
    const capacity = getBarBeats(source, projectTs);
    // Carried blocks were pushed out of the previous bar, so they come first.
    const incoming = [...carried, ...byStart(withStartBeats(source.chords))];

    const chords: ChordSegment[] = [];
    carried = [];
    let cursor = 0;

    for (const segment of incoming) {
      if (carried.length > 0) {
        // Once one block has spilled, everything after it must follow, or the order
        // the user wrote would silently change.
        carried.push(segment);
        continue;
      }

      const startBeat = Math.max(startOf(segment, cursor), cursor);
      // A block longer than the bar fits nowhere; parking it here and overhanging
      // beats pushing it forever from bar to bar.
      const overhangs = startBeat + segment.duration > capacity;
      if (overhangs && cursor > 0) {
        carried.push({ ...segment, startBeat: 0 });
        continue;
      }

      chords.push(segment.startBeat === startBeat ? segment : { ...segment, startBeat });
      cursor = overhangs ? capacity : startBeat + segment.duration;
    }

    // Spilled blocks restart at the top of the next bar.
    carried = carried.map(s => ({ ...s, startBeat: undefined }));
    result.push({ ...source, barIndex: result.length, chords });
  }

  return result;
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
 * The meter a bar is actually in: its own if it has one, otherwise the project's.
 * Everything that needs a bar's metre — capacity, exporters, the piano roll grid —
 * resolves it here so the fallback rule is stated once.
 */
export function getBarTimeSignature(bar: Bar, projectTs: TimeSignature): TimeSignature {
  return bar.timeSignature ?? projectTs;
}

/**
 * Returns the number of beats a bar holds, preferring its own time signature
 * and falling back to the project's.
 */
export function getBarBeats(bar: Bar, projectTs: TimeSignature): number {
  return getBarTimeSignature(bar, projectTs).beatsPerMeasure;
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
