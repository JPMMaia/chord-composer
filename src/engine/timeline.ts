import type { Bar, ChordSegment, Note, TimeSignature, Track, TrackContent } from '@/types/music';
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
 * Smallest editable segment length, in beats — a thirty-second note. The piano roll
 * is handed this same value as its grid size, so resizing a chord and drawing a note
 * snap to the same lattice.
 *
 * An eighth of a beat is a binary fraction and therefore exact in floating point,
 * which is why the lattice can be refined this far without the rounding guards
 * elsewhere (`gridKey`, `EPSILON`) having to widen. A triplet grid would not be.
 */
export const MIN_SEGMENT_BEATS = 0.125;

/** Snap a beat value to the editing grid, avoiding float drift (1.3 -> 1.25). */
function snapToGrid(beats: number): number {
  return Math.round(beats / MIN_SEGMENT_BEATS) * MIN_SEGMENT_BEATS;
}

/**
 * Snap resolutions offered in the timeline toolbar, labelled as note values.
 *
 * The beat figures assume a quarter-note beat: a whole note is four beats, a
 * thirty-second an eighth of one — which is also `MIN_SEGMENT_BEATS`, so no option
 * can ask for a position finer than a segment can be.
 */
export const SNAP_OPTIONS = [
  { label: '1/1', beats: 4 },
  { label: '1/2', beats: 2 },
  { label: '1/4', beats: 1 },
  { label: '1/8', beats: 0.5 },
  { label: '1/16', beats: 0.25 },
  { label: '1/32', beats: 0.125 },
] as const;

/** Quarter notes: the resolution most progressions are written at. */
export const DEFAULT_SNAP_BEATS = 1;

/**
 * Snap a beat to the chosen grid. The second rounding is not redundant: it pulls
 * the result back onto the `MIN_SEGMENT_BEATS` lattice so a chain of snapped edits
 * cannot accumulate float error.
 */
export function snapBeat(beat: number, snapBeats: number): number {
  if (!Number.isFinite(beat) || snapBeats <= 0) return 0;
  return Math.max(0, snapToGrid(Math.round(beat / snapBeats) * snapBeats));
}

/**
 * Keep a block's *start* inside its bar.
 *
 * Only the start: a block is free to run past the bar line and sound on into the
 * following bars, which is how a chord held across a barline is written. What a
 * block may not do is begin outside the bar that holds it — the bar a block lives
 * in is the one its onset falls in, and that is what makes a position mean one
 * thing. The last legal start is one grid step short of the bar line, so a block
 * pushed hard right still has somewhere to be.
 */
export function clampStartToBar(startBeat: number, capacity: number): number {
  return Math.max(0, Math.min(startBeat, capacity - MIN_SEGMENT_BEATS));
}

/** A segment's position, treating an absent one as "wherever the packing left off". */
function startOf(segment: ChordSegment, fallback: number): number {
  return typeof segment.startBeat === 'number' && Number.isFinite(segment.startBeat)
    ? segment.startBeat
    : fallback;
}

/**
 * Which of its instrument's stacked sub-lanes a segment sits in.
 *
 * Absent, negative or fractional all read as lane 0 — the single lane every project
 * written before sub-lanes had, and the only lane most material ever needs.
 */
export function laneOf(segment: Pick<ChordSegment, 'lane'>): number {
  const lane = segment.lane;
  return typeof lane === 'number' && Number.isFinite(lane) && lane > 0 ? Math.floor(lane) : 0;
}

/** How many sub-lanes an instrument shows. Absent, or anything invalid, reads as 1. */
export function trackLaneCount(track: Pick<Track, 'laneCount'>): number {
  const count = track.laneCount;
  return typeof count === 'number' && Number.isFinite(count) && count > 1 ? Math.floor(count) : 1;
}

/**
 * Split segments into one list per lane, indexed by lane number.
 *
 * The length follows the *data*, not the track's `laneCount`: a block sitting in a
 * lane the track no longer shows still has to be refitted and drawn somewhere rather
 * than quietly vanishing.
 */
export function byLane(segments: ChordSegment[]): ChordSegment[][] {
  const lanes: ChordSegment[][] = [[]];
  for (const segment of segments) {
    const lane = laneOf(segment);
    while (lanes.length <= lane) lanes.push([]);
    lanes[lane].push(segment);
  }
  return lanes;
}

/**
 * Fill in any missing `startBeat` by packing segments in order.
 *
 * That packing is exactly what a position-less list used to mean — durations
 * accumulated from the start of the bar — so this is what lets projects saved before
 * free placement open with the positions they always had.
 *
 * One cursor per lane, because packing is a per-lane notion: where a lane-1 block
 * lands follows from the lane-1 blocks before it, not from whatever lane 0 holds.
 * Files written before sub-lanes are entirely lane 0, so they pack as they always
 * did. Input order is preserved, since callers iterate the result.
 */
export function withStartBeats(segments: ChordSegment[]): ChordSegment[] {
  const cursors = new Map<number, number>();
  return segments.map(segment => {
    const lane = laneOf(segment);
    const startBeat = startOf(segment, cursors.get(lane) ?? 0);
    cursors.set(lane, startBeat + segment.duration);
    return segment.startBeat === startBeat ? segment : { ...segment, startBeat };
  });
}

/** Order segments by position, and blocks stacked on one beat by lane. */
function byStart(segments: ChordSegment[]): ChordSegment[] {
  return [...segments].sort((a, b) => startOf(a, 0) - startOf(b, 0) || laneOf(a) - laneOf(b));
}

/**
 * Place `segment` at `startBeat` within one bar, rippling whatever it lands on to
 * the right.
 *
 * A block is only moved if it actually overlaps the placed one, or overlaps a block
 * that was itself pushed — so the cascade stops at the first gap wide enough to
 * absorb the shift, and empty space elsewhere in the bar survives untouched. The
 * ripple may push a block past the bar line; that is not this function's problem,
 * because a position past `capacity` is just a position further along the timeline,
 * and `refitBars` is what re-homes it into the bar it now starts in.
 *
 * **The ripple is confined to the placed block's own lane.** Blocks stacked above or
 * below it are not in its way — that is what a lane is for — so they are carried
 * through untouched, however exactly their beats coincide.
 *
 * Passing a segment already present moves it, rather than duplicating it, including
 * when the move is from one lane to another.
 */
export function placeSegmentInBar(
  segments: ChordSegment[],
  segment: ChordSegment,
  startBeat: number
): ChordSegment[] {
  const placed = { ...segment, startBeat };
  const lane = laneOf(placed);
  // Filtered by id across every lane, so moving a block between lanes lifts the
  // old copy out rather than leaving it behind in the lane it came from.
  const rest = withStartBeats(segments.filter(s => s.id !== placed.id));
  const others = byStart(rest.filter(s => laneOf(s) === lane));

  const kept: ChordSegment[] = [placed, ...rest.filter(s => laneOf(s) !== lane)];
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
    kept.push(shifted === start ? other : { ...other, startBeat: shifted });
  }

  return byStart(kept);
}

/**
 * Clear one instrument's segments out of an absolute beat range, so something else
 * can be written over it.
 *
 * A block wholly inside the range is dropped; one that straddles an edge is trimmed
 * back to the part lying outside, and dropped in turn if that leaves it shorter than
 * `MIN_SEGMENT_BEATS`. A block spanning the range end to end keeps only its head —
 * punching into the middle of a long chord shortens it rather than leaving an orphan
 * behind the take.
 *
 * Nothing is ever *moved*, which is what makes this a punch-in rather than the ripple
 * `placeSegmentInBar` performs: re-recording four bars into a finished song must not
 * shove the rest of it along. The range is half-open, so a block that merely touches
 * an edge survives untouched.
 *
 * @param exceptId - A segment to leave alone: the take being recorded, which is
 *   already on the timeline and must not clear itself away as it grows.
 * @param lane - Punch only this sub-lane. Recording into lane 1 must not erase what
 *   is stacked underneath it in lane 0, any more than it erases another instrument.
 *   Absent punches every lane.
 */
export function clearRange(
  bars: Bar[],
  projectTs: TimeSignature,
  trackId: string,
  fromBeat: number,
  toBeat: number,
  exceptId?: string,
  lane?: number
): Bar[] {
  if (!(toBeat > fromBeat)) return bars;

  let barStart = 0;
  let anyChanged = false;

  const result = bars.map(bar => {
    const offset = barStart;
    barStart += getBarBeats(bar, projectTs);

    const chords = barChords(bar, trackId);
    if (chords.length === 0) return bar;

    let changed = false;
    const kept: ChordSegment[] = [];
    for (const segment of withStartBeats(chords)) {
      const start = offset + segment.startBeat!;
      const end = start + segment.duration;

      // Outside the punch entirely, in a lane it does not reach, or explicitly spared.
      if (
        end <= fromBeat ||
        start >= toBeat ||
        segment.id === exceptId ||
        (lane !== undefined && laneOf(segment) !== lane)
      ) {
        kept.push(segment);
        continue;
      }

      // Head before the punch wins over any tail after it: one segment cannot be
      // split into two without inventing an id, and the head is what was played.
      const trimmed =
        start < fromBeat
          ? { start, duration: fromBeat - start }
          : { start: toBeat, duration: end - toBeat };

      changed = true;
      if (trimmed.duration < MIN_SEGMENT_BEATS) continue;

      kept.push({
        ...segment,
        startBeat: trimmed.start - offset,
        duration: snapToGrid(trimmed.duration),
      });
    }

    if (!changed) return bar;
    anyChanged = true;
    return withBarContent(bar, trackId, { ...barContent(bar, trackId), chords: kept });
  });

  return anyChanged ? result : bars;
}

/**
 * Restore the timeline invariant across the whole project: every segment
 * positioned, in order, and non-overlapping *within its lane*, each one living in
 * the bar its onset falls in.
 *
 * Blocks in different lanes may coincide exactly, which is what lets a played chord
 * be the three note blocks it actually is rather than one opaque block.
 *
 * A block may run past its bar line — a chord held across the barline is ordinary
 * music — so what gets re-homed here is only a block whose *start* has been pushed
 * out of its bar, by a ripple, by a neighbour growing, or by a bar narrowing. It
 * moves to the bar containing its new onset, keeping the beat it landed on rather
 * than being reset to the downbeat, and bars are appended when it lands beyond the
 * last one. Every mutation ends here, which is what keeps one rule in one place.
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
    const refitted = refitTrackLanes(
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
 * Refit one instrument's segments across the project, lane by lane.
 *
 * A lane is the unit the non-overlap rule applies to, so each one is refitted on its
 * own and the results are merged back per bar — exactly the relationship `refitBars`
 * has to instruments, one level down. A lane that overflows appends bars without
 * touching the lanes stacked with it, so the project ends up as long as the longest.
 *
 * The lanes considered come from the segments themselves rather than from the
 * track's `laneCount`, so a block left in a lane the track has since stopped showing
 * is still placed rather than lost.
 */
function refitTrackLanes(
  chordsPerBar: ChordSegment[][],
  capacityAt: (index: number) => number
): ChordSegment[][] {
  const laneCount = chordsPerBar.reduce(
    (widest, chords) => chords.reduce((max, s) => Math.max(max, laneOf(s) + 1), widest),
    1
  );

  // The one-lane case is every project written before sub-lanes, and most tracks
  // in every project after: skip the split and the merge entirely.
  if (laneCount === 1) return refitTrackChords(chordsPerBar, capacityAt);

  let barCount = chordsPerBar.length;
  const perLane: ChordSegment[][][] = [];
  for (let lane = 0; lane < laneCount; lane++) {
    const refitted = refitTrackChords(
      chordsPerBar.map(chords => chords.filter(s => laneOf(s) === lane)),
      capacityAt
    );
    perLane.push(refitted);
    barCount = Math.max(barCount, refitted.length);
  }

  const merged: ChordSegment[][] = [];
  for (let i = 0; i < barCount; i++) {
    merged.push(byStart(perLane.flatMap(lane => lane[i] ?? [])));
  }
  return merged;
}

/**
 * Refit one lane's segments across the project. Returns one list per bar,
 * possibly longer than the input when blocks ran off the end.
 *
 * The work is done in absolute beats rather than bar by bar, because that is the
 * frame the rules are actually written in: blocks may not overlap, and each one
 * lives in whichever bar its onset falls in. Bars are a *view* of that line, so
 * this converts to it, pushes overlaps apart along it, and slices it back up —
 * which is what lets a block sit across a barline instead of being clamped by it.
 */
function refitTrackChords(
  chordsPerBar: ChordSegment[][],
  capacityAt: (index: number) => number
): ChordSegment[][] {
  /** A segment with its position measured from the start of the project. */
  interface Placed {
    segment: ChordSegment;
    startBeat: number;
  }

  const placed: Placed[] = [];
  let barStart = 0;
  for (let i = 0; i < chordsPerBar.length; i++) {
    for (const segment of byStart(withStartBeats(chordsPerBar[i]))) {
      placed.push({ segment, startBeat: barStart + startOf(segment, 0) });
    }
    barStart += capacityAt(i);
  }

  // A stable sort, so blocks that a bar's own list already ordered — and a spilled
  // block against the next bar's downbeat — keep the order the user wrote them in.
  placed.sort((a, b) => a.startBeat - b.startBeat);

  // Push overlaps apart. Nothing is ever dropped or shortened; a block only ever
  // moves later, to just after whatever now precedes it.
  let cursor = 0;
  let end = 0;
  for (const entry of placed) {
    entry.startBeat = Math.max(entry.startBeat, cursor);
    cursor = entry.startBeat + entry.segment.duration;
    end = Math.max(end, cursor);
  }

  // Slice the line back into bars, each block landing in the one holding its onset.
  const result: ChordSegment[][] = [];
  let index = 0;
  let current: ChordSegment[] = [];
  barStart = 0;

  const closeBar = () => {
    result.push(current);
    current = [];
    barStart += capacityAt(index);
    index++;
  };

  for (const { segment, startBeat: absolute } of placed) {
    while (absolute >= barStart + capacityAt(index)) closeBar();
    const startBeat = absolute - barStart;
    current.push(segment.startBeat === startBeat ? segment : { ...segment, startBeat });
  }
  closeBar();

  // The project keeps every bar it had, and grows enough to contain the tail of a
  // block hanging off the end — otherwise the last chord would outlast the song.
  while (result.length < chordsPerBar.length || barStart < end) closeBar();

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

/** A segment together with where it sits on the project's absolute beat line. */
export interface SegmentSpan {
  segment: ChordSegment;
  /** Beats from the start of the project. */
  startBeat: number;
  /** Where the block stops sounding — `startBeat + duration`. */
  endBeat: number;
  lane: number;
}

/**
 * One instrument's segments as absolute spans, in start order.
 *
 * Bars are a view of one continuous line, so any question about what occupies
 * what — does this land on something? is this lane free here? — is easier to ask
 * on the line than bar by bar. `refitTrackChords` does the same walk internally
 * for the same reason.
 */
export function segmentSpans(
  bars: Bar[],
  projectTs: TimeSignature,
  trackId: string
): SegmentSpan[] {
  const spans: SegmentSpan[] = [];
  let barStart = 0;

  for (const bar of bars) {
    for (const segment of withStartBeats(barChords(bar, trackId))) {
      const startBeat = barStart + startOf(segment, 0);
      spans.push({
        segment,
        startBeat,
        endBeat: startBeat + segment.duration,
        lane: laneOf(segment),
      });
    }
    barStart += getBarBeats(bar, projectTs);
  }

  return spans.sort((a, b) => a.startBeat - b.startBeat || a.lane - b.lane);
}

/** Half-open overlap: blocks that merely touch at an edge do not collide. */
function spansOverlap(
  a: { startBeat: number; endBeat: number },
  b: { startBeat: number; endBeat: number }
): boolean {
  return a.startBeat < b.endBeat && b.startBeat < a.endBeat;
}

/**
 * The smallest lane shift (>= 0) that clears `incoming` of everything in `existing`.
 *
 * The whole group moves together, so the shape a user copied arrives as the shape
 * they copied — blocks stacked across two lanes stay two lanes apart. Lanes above
 * the highest occupied one are empty by definition, so the search terminates.
 */
export function freeLaneShift(
  existing: readonly { startBeat: number; endBeat: number; lane: number }[],
  incoming: readonly { startBeat: number; endBeat: number; lane: number }[]
): number {
  if (incoming.length === 0) return 0;

  // Past the highest occupied lane nothing can collide, so the search never needs
  // to look further than one lane above it.
  const ceiling = existing.reduce((max, span) => Math.max(max, span.lane), -1) + 1;

  for (let shift = 0; shift < ceiling; shift++) {
    const clear = incoming.every(
      block =>
        !existing.some(span => span.lane === block.lane + shift && spansOverlap(span, block))
    );
    if (clear) return shift;
  }

  return ceiling;
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

/** A position on the timeline, as the bar holding it and the offset within that bar. */
export interface BeatPosition {
  barIndex: number;
  startBeat: number;
}

/**
 * Convert an absolute beat into the bar holding it and the offset within that bar.
 *
 * Bars may carry their own meter, so this walks rather than divides.
 *
 * @param absoluteBeat - Beats from the start of the project.
 * @param bars - The project's bars.
 * @param projectTs - Meter for bars carrying none of their own.
 * @param extend - What to do with a beat falling past the last bar. False — the
 *   default, and what paste wants — pins it to the start of the last bar. True
 *   continues counting on the last bar's meter and returns a bar index past the end,
 *   for callers that go on to create the bars it names.
 * @returns The position, or null when there are no bars at all.
 */
export function resolveBeatPosition(
  absoluteBeat: number,
  bars: Bar[],
  projectTs: TimeSignature,
  extend = false
): BeatPosition | null {
  if (!bars.length) return null;

  let accumulated = 0;
  for (let i = 0; i < bars.length; i++) {
    const barBeats = getBarBeats(bars[i], projectTs);
    if (absoluteBeat < accumulated + barBeats) {
      return { barIndex: i, startBeat: absoluteBeat - accumulated };
    }
    accumulated += barBeats;
  }

  if (!extend) return { barIndex: bars.length - 1, startBeat: 0 };

  // Past the end: keep counting in bars the length of the last one, which is the
  // meter any bar appended after it would inherit.
  const lastBeats = getBarBeats(bars[bars.length - 1], projectTs);
  const past = absoluteBeat - accumulated;
  return {
    barIndex: bars.length + Math.floor(past / lastBeats),
    startBeat: past % lastBeats,
  };
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
 * Build a fresh empty bar, inheriting the meter of the bar before it so that
 * overflowing into new territory does not silently change metre. Key needs no
 * inheriting: it travels with the blocks that spill in.
 */
function createBar(index: number, existing: Bar[]): Bar {
  const previous = existing[existing.length - 1];
  return {
    id: generateId(),
    barIndex: index,
    timeSignature: previous?.timeSignature,
    content: {},
  };
}

/**
 * Grow the project until `beat` falls inside a bar, appending bars that inherit the
 * last one's meter — the same rule `refitBars` follows when a block spills off the end.
 *
 * This is what lets a block be *placed* past the end rather than only rippled there:
 * dragging a selection off the end of the song extends it, instead of piling every
 * block onto the last bar. A beat already inside a bar appends nothing and hands back
 * the array untouched, so callers can run it unconditionally.
 */
export function extendBarsToBeat(
  bars: Bar[],
  projectTs: TimeSignature,
  beat: number
): Bar[] {
  if (!Number.isFinite(beat) || bars.length === 0) return bars;

  let total = getTotalBeats(bars, projectTs);
  if (beat < total) return bars;

  const result = [...bars];
  // Each appended bar inherits from the one before it, so the meter carries along
  // the whole run rather than only onto the first new bar.
  while (beat >= total) {
    result.push(createBar(result.length, result));
    total += getBarBeats(result[result.length - 1], projectTs);
  }
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
 * Set a segment's duration, snapped to `snapBeats` and clamped to at least
 * `MIN_SEGMENT_BEATS`. Pass `maxBeats` (usually the containing bar's capacity) to
 * cap it.
 *
 * The snap resolution is passed in rather than assumed so that resizing lands on the
 * same lattice as dragging and dropping. Resize used to quantise to the floor
 * instead, which was invisible only while the floor and the finest menu option were
 * the same value — once the floor moved below the menu, a resize at a coarse snap
 * setting would have ignored it entirely.
 */
export function resizeSegment(
  segments: ChordSegment[],
  id: string,
  duration: number,
  snapBeats: number,
  maxBeats?: number
): ChordSegment[] {
  // `snapBeat` rounds to nearest, so a drag shorter than half a step lands on zero.
  // The floor is applied after snapping to pull that back up to a drawable block.
  let next = Math.max(MIN_SEGMENT_BEATS, snapBeat(duration, snapBeats));
  if (maxBeats !== undefined) {
    next = Math.min(next, maxBeats);
  }
  return segments.map(s => (s.id === id ? { ...s, duration: next } : s));
}
