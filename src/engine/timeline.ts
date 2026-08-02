import type { Bar, ChordSegment, Note, TimeSignature, TrackContent } from '@/types/music';
import { generateId } from '@/utils/id';

// ---------------------------------------------------------------------------
// Per-instrument content accessors
// ---------------------------------------------------------------------------

/** Shared empty content, so a miss allocates nothing and never leaks a writable array. */
const EMPTY_CONTENT: TrackContent = Object.freeze({
  chords: Object.freeze([]) as unknown as ChordSegment[],
  notes: Object.freeze([]) as unknown as Note[],
});

/**
 * One instrument's material in a bar, or empty content when it has none.
 *
 * Every read of a bar's segments or notes goes through here or its wrappers, so
 * "an instrument with no key in this bar is silent" is stated once rather than
 * at each of the ~50 call sites that used to read `bar.chords` directly.
 */
export function barContent(bar: Bar, trackId: string): TrackContent {
  return bar.content[trackId] ?? EMPTY_CONTENT;
}

export function barChords(bar: Bar, trackId: string): ChordSegment[] {
  return barContent(bar, trackId).chords;
}

export function barNotes(bar: Bar, trackId: string): Note[] {
  return barContent(bar, trackId).notes;
}

/** Every note in a bar, tagged with the instrument it belongs to. */
export function allBarNotes(bar: Bar): Array<{ note: Note; trackId: string }> {
  return Object.entries(bar.content).flatMap(([trackId, content]) =>
    content.notes.map(note => ({ note, trackId }))
  );
}

/** Every instrument id that has content anywhere in the project. */
export function trackIdsInBars(bars: Bar[]): string[] {
  const ids = new Set<string>();
  for (const bar of bars) {
    for (const id of Object.keys(bar.content)) ids.add(id);
  }
  return [...ids];
}

/** Replace one instrument's content in a bar, leaving the others alone. */
export function withBarContent(bar: Bar, trackId: string, content: TrackContent): Bar {
  return { ...bar, content: { ...bar.content, [trackId]: content } };
}

/** Rewrite one instrument's segments in a bar, keeping its notes for the store to regenerate. */
export function mapBarChords(
  bar: Bar,
  trackId: string,
  fn: (chords: ChordSegment[]) => ChordSegment[]
): Bar {
  const content = barContent(bar, trackId);
  return withBarContent(bar, trackId, { ...content, chords: fn(content.chords) });
}

/** Drop an instrument's content from every bar — what removing a track leaves behind. */
export function withoutTrackContent(bars: Bar[], trackId: string): Bar[] {
  return bars.map(bar => {
    if (!(trackId in bar.content)) return bar;
    const { [trackId]: _removed, ...rest } = bar.content;
    return { ...bar, content: rest };
  });
}

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
export function refitBars(bars: Bar[], projectTs: TimeSignature, trackIds?: string[]): Bar[] {
  if (bars.length === 0) return [];

  const ids = trackIds ?? trackIdsInBars(bars);
  // An appended bar inherits the last real bar's meter, exactly as `createBar` does.
  const capacityAt = (index: number) =>
    getBarBeats(bars[Math.min(index, bars.length - 1)], projectTs);

  // Each instrument is refitted on its own, so one instrument's ripple can never
  // push another's blocks. Overflow may append bars, and different instruments may
  // need different numbers of them, so the project ends up as long as the longest.
  let barCount = bars.length;
  const perTrack = new Map<string, ChordSegment[][]>();
  for (const id of ids) {
    const refitted = refitTrackChords(
      bars.map(bar => barChords(bar, id)),
      capacityAt
    );
    perTrack.set(id, refitted);
    barCount = Math.max(barCount, refitted.length);
  }

  const result: Bar[] = [];
  for (let i = 0; i < barCount; i++) {
    const source = bars[i] ?? createBar(i, result);
    const content: Record<string, TrackContent> = {};

    for (const id of ids) {
      const chords = perTrack.get(id)![i] ?? [];
      // Bars stay sparse: an instrument only gets a key here if it has something
      // in this bar, or already had one to preserve.
      if (chords.length === 0 && !(id in source.content)) continue;
      content[id] = { chords, notes: barContent(source, id).notes };
    }

    result.push({ ...source, barIndex: i, content });
  }

  return result;
}

/**
 * Refit one instrument's segments across the project: the bar invariant applied to
 * a single track's lists. Returns one list per bar, possibly longer than the input
 * when blocks spilled off the end.
 */
function refitTrackChords(
  chordsPerBar: ChordSegment[][],
  capacityAt: (index: number) => number
): ChordSegment[][] {
  const result: ChordSegment[][] = [];
  let carried: ChordSegment[] = [];

  for (let i = 0; i < chordsPerBar.length || carried.length > 0; i++) {
    const capacity = capacityAt(i);
    // Carried blocks were pushed out of the previous bar, so they come first.
    const incoming = [...carried, ...byStart(withStartBeats(chordsPerBar[i] ?? []))];

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
    result.push(chords);
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
 * How many beats a bar of this metre holds.
 *
 * A beat is a quarter note everywhere in the app — BPM is quarter-note BPM, MIDI
 * counts ticks per quarter, MusicXML counts divisions per quarter — so the
 * denominator has to be folded in here rather than taken as a beat count. Six
 * eighths are three quarters, which is why 6/8 and 3/4 come out the same length.
 */
export function timeSignatureBeats(ts: TimeSignature): number {
  return ts.beatsPerMeasure * (4 / ts.beatUnit);
}

/**
 * Returns the number of beats a bar holds, preferring its own time signature
 * and falling back to the project's.
 */
export function getBarBeats(bar: Bar, projectTs: TimeSignature): number {
  return timeSignatureBeats(getBarTimeSignature(bar, projectTs));
}

/**
 * How a metre is *felt*, as opposed to how long it is.
 *
 * 3/4 and 6/8 occupy the same three quarter notes but are not the same metre: 3/4
 * is three quarter-note pulses each split in two, 6/8 is two dotted-quarter pulses
 * each split in three. Everything that has to show or sound that difference — the
 * timeline grid, the piano roll grid, the metronome — asks here, so the rule is
 * stated once.
 */
export interface MeterPulse {
  /** Length of one felt beat, in beats: 1 in 3/4, 1.5 in 6/8. */
  pulseBeats: number;
  /** How many of them fill a bar: 3 in 3/4, 2 in 6/8. */
  pulseCount: number;
  /** Length of one subdivision within a pulse: 0.5 in both 3/4 and 6/8. */
  subdivisionBeats: number;
  /** Subdivisions per pulse: two when the metre is simple, three when compound. */
  subdivisionsPerPulse: number;
}

/**
 * A metre is compound when its denominator counts subdivisions rather than beats,
 * which is what an eighth-or-finer unit grouped in threes means: 6/8, 9/8, 12/8,
 * 6/16. 3/8 is excluded — with only one group it is heard as three eighth beats,
 * not as a single pulse.
 */
function isCompound(ts: TimeSignature): boolean {
  return ts.beatUnit >= 8 && ts.beatsPerMeasure >= 6 && ts.beatsPerMeasure % 3 === 0;
}

/**
 * The pulse of a metre. Irregular metres (5/8, 7/8) fall through to the simple
 * case, giving one pulse per denominator unit: an even grid rather than a wrong
 * guess at whether the bar is 3+2+2 or 2+2+3.
 */
export function getMeterPulse(ts: TimeSignature): MeterPulse {
  const unit = 4 / ts.beatUnit;

  if (isCompound(ts)) {
    return {
      pulseBeats: unit * 3,
      pulseCount: ts.beatsPerMeasure / 3,
      subdivisionBeats: unit,
      subdivisionsPerPulse: 3,
    };
  }

  return {
    pulseBeats: unit,
    pulseCount: ts.beatsPerMeasure,
    subdivisionBeats: unit / 2,
    subdivisionsPerPulse: 2,
  };
}

/** The pulse of a bar, resolving its metre the same way `getBarBeats` does. */
export function getBarPulse(bar: Bar, projectTs: TimeSignature): MeterPulse {
  return getMeterPulse(getBarTimeSignature(bar, projectTs));
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

/**
 * Index of the bar containing an absolute beat, clamped to the project's range.
 *
 * Bar lengths vary, so this walks rather than divides. A beat sitting exactly on a
 * bar line belongs to the bar it opens.
 */
export function getBarIndexAtBeat(
  bars: Bar[],
  projectTs: TimeSignature,
  beat: number
): number {
  let start = 0;
  for (let i = 0; i < bars.length; i++) {
    start += getBarBeats(bars[i], projectTs);
    if (beat < start) return i;
  }
  return Math.max(0, bars.length - 1);
}

/**
 * Concatenate one instrument's segments across every bar into one ordered list.
 *
 * Scoped to an instrument because its callers — Shift-range ordering and stale
 * selection pruning — both act on what the timeline is currently showing, which
 * is only ever the selected instrument.
 */
export function flattenSegments(bars: Bar[], trackId: string): ChordSegment[] {
  return bars.flatMap(bar => barChords(bar, trackId));
}

/** Where a segment lives, for callers that hold only its id. */
export interface SegmentLocation {
  bar: Bar;
  trackId: string;
  segment: ChordSegment;
}

/**
 * Find a segment anywhere in the project, whichever bar or instrument holds it.
 *
 * Unscoped, unlike `flattenSegments`, because selection deliberately does not
 * follow the bar cursor: a block stays selected when the cursor moves elsewhere,
 * so anything inspecting the selection has to be able to find it without being
 * told where to look.
 */
export function findSegment(bars: Bar[], segmentId: string): SegmentLocation | null {
  for (const bar of bars) {
    for (const [trackId, content] of Object.entries(bar.content)) {
      const segment = content.chords.find(c => c.id === segmentId);
      if (segment) return { bar, trackId, segment };
    }
  }
  return null;
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
    content: {},
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
