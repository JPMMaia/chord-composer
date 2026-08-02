import type { Bar, ChordSegment, Note, NoteName, Scale, TimeSignature } from '@/types/music';
import { generateId } from '@/utils/id';
import {
  CHORD_INTERVALS,
  getDiatonicChords,
  getDiatonicSevenths,
  invertIntervals,
  SEMITONE_TO_NOTE,
} from '@/engine/chords';
import { getScalePitches } from '@/engine/scales';
import { getBarBeats, withStartBeats } from '@/engine/timeline';
import { formatChordSymbol } from '@/engine/palette';
import {
  DEFAULT_TIME_SIGNATURE,
  MAX_SEGMENT_OCTAVE,
  MIN_SEGMENT_OCTAVE,
  NOTE_NAMES,
  PIANO_ROLL_MAX_MIDI,
  PIANO_ROLL_MIN_MIDI,
} from '@/utils/constants';

/**
 * Split a bar into equal-duration chord segments with diatonic chords.
 * Each chord gets a Roman numeral based on the bar's scale.
 *
 * @param bar - The bar to split.
 * @param chordCount - Number of chord segments to create.
 * @returns Array of ChordSegment objects.
 */
export function splitBarIntoChords(
  bar: Bar,
  chordCount: number,
  projectTs: TimeSignature = DEFAULT_TIME_SIGNATURE
): ChordSegment[] {
  if (chordCount < 1) {
    throw new Error('chordCount must be at least 1');
  }

  const beatsPerMeasure = getBarBeats(bar, projectTs);

  if (chordCount > beatsPerMeasure) {
    throw new Error(`chordCount (${chordCount}) cannot exceed bar length (${beatsPerMeasure})`);
  }

  const beatsPerChord = beatsPerMeasure / chordCount;
  const diatonicChords = getDiatonicChords(bar.scale);
  const chords: ChordSegment[] = [];

  for (let i = 0; i < chordCount; i++) {
    const chordInfo = diatonicChords[i % diatonicChords.length];
    chords.push({
      id: generateId(),
      kind: 'chord',
      romanNumeral: chordInfo.romanNumeral,
      chordSymbol: formatChordSymbol(chordInfo.root, chordInfo.quality),
      duration: beatsPerChord,
      root: chordInfo.root,
      quality: chordInfo.quality,
    });
  }

  return chords;
}

/**
 * Reorder chords by moving a chord from one index to another.
 *
 * @param chords - The array of chord segments.
 * @param fromIndex - The source index.
 * @param toIndex - The destination index.
 * @returns A new array with the chord moved.
 */
export function reorderChords(
  chords: ChordSegment[],
  fromIndex: number,
  toIndex: number
): ChordSegment[] {
  if (fromIndex < 0 || fromIndex >= chords.length) {
    throw new Error(`fromIndex ${fromIndex} is out of bounds (0-${chords.length - 1})`);
  }
  if (toIndex < 0 || toIndex >= chords.length) {
    throw new Error(`toIndex ${toIndex} is out of bounds (0-${chords.length - 1})`);
  }

  if (fromIndex === toIndex) {
    return [...chords];
  }

  const result = [...chords];
  const [moved] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, moved);

  return result;
}

/**
 * Generates the piano-roll notes for one instrument in a bar from its segments.
 *
 * This is the sync engine behind the chord panel: a track's `notes` are derived
 * state, regenerated whenever segments change, so the piano roll always mirrors the
 * timeline. A chord segment expands to its stacked intervals, voiced in whatever
 * inversion it carries; a note segment yields a single pitch. Segments sit where
 * they were placed, so the gaps between them come out as silence with no further
 * work.
 *
 * Deliberately total — it never throws — because it runs on every edit, including
 * transient states like a bar whose last segment was just deleted.
 *
 * Takes the segments rather than reading them off the bar, because a bar holds one
 * list per instrument and this runs once per instrument. The bar is still needed
 * for the scale and meter every instrument shares.
 *
 * @param chords - The segments to voice, from one instrument's content.
 * @param bar - The bar they sit in, for its scale and meter.
 * @param projectTs - Project time signature, used when the bar has none.
 * @param octave - Fallback octave for chord segments that carry none of their own.
 * @returns The notes for this instrument in this bar, in segment order.
 */
export function generateNotesFromSegments(
  chords: ChordSegment[],
  bar: Bar,
  projectTs: TimeSignature,
  octave: number = 4
): Note[] {
  const notes: Note[] = [];
  const barBeats = getBarBeats(bar, projectTs);

  // A segment saved before free placement carries no position; packing it is what
  // its position used to mean.
  for (const segment of withStartBeats(chords)) {
    const currentBeat = segment.startBeat!;

    // Refitting owns moving a segment past the bar line into the next bar; drawing
    // it here as well would sound it twice.
    if (currentBeat >= barBeats) continue;

    // A single note carries its own pitch and needs no harmonic interpretation.
    if (segment.kind === 'note') {
      if (segment.pitch !== undefined) {
        notes.push({
          id: generateId(),
          pitch: segment.pitch,
          startBeat: currentBeat,
          duration: segment.duration,
          velocity: 100,
        });
      }
      continue;
    }

    const { quality, rootSemitone } = resolveChord(segment, bar);
    // The segment's own register wins; the parameter is the fallback for
    // segments written before the palette could choose an octave.
    const baseMidi = ((segment.octave ?? octave) + 1) * 12 + rootSemitone;

    for (const interval of invertIntervals(CHORD_INTERVALS[quality], segment.inversion ?? 0)) {
      notes.push({
        id: generateId(),
        pitch: baseMidi + interval,
        startBeat: currentBeat,
        duration: segment.duration,
        velocity: 100,
      });
    }
  }

  return notes;
}

/**
 * Resolves a chord segment's quality and root pitch class, falling back to the
 * bar's scale when the segment only carries a Roman numeral.
 */
function resolveChord(
  segment: ChordSegment,
  bar: Bar
): { quality: ChordQualityKey; rootSemitone: number } {
  const match = segment.romanNumeral
    ? getDiatonicChords(bar.scale).find(
        c =>
          c.romanNumeral.replace(/[°+]/g, '') ===
          segment.romanNumeral!.replace(/[°+]/g, '')
      )
    : undefined;

  const quality = (segment.quality ?? match?.quality ?? 'major') as ChordQualityKey;
  const rootNote = segment.root ?? match?.root;

  // Look the root up chromatically rather than within the scale, so borrowed and
  // chromatic chords land on their real root instead of silently falling back to C.
  const rootSemitone = rootNote ? Math.max(0, NOTE_NAMES.indexOf(rootNote)) : 0;

  return { quality, rootSemitone };
}

/** Local alias so the interval lookup stays exhaustive over known qualities. */
type ChordQualityKey = keyof typeof CHORD_INTERVALS;

/** Normalise a roman numeral for comparison — casing carries the quality, symbols don't. */
function bareNumeral(numeral: string): string {
  return numeral.replace(/[°+]/g, '');
}

/** Find which degree of a scale a roman numeral names, or -1. */
function degreeOfNumeral(scale: Scale, numeral: string): number {
  const target = bareNumeral(numeral);
  return getDiatonicChords(scale).findIndex(c => bareNumeral(c.romanNumeral) === target);
}

/**
 * Re-derives segments against a new scale, keeping each one on the scale degree it
 * was written on.
 *
 * Segments carry an explicit root and quality so that borrowed and chromatic chords
 * survive, but that means a diatonic segment would otherwise ignore a change of key.
 * A segment is treated as diatonic exactly when it carries a roman numeral: the
 * numeral names a degree, and this moves that degree into the new scale. Segments
 * without one are chromatic by construction and pass through untouched.
 *
 * @param segments - Segments belonging to the bar whose scale changed.
 * @param fromScale - The scale the segments were written against.
 * @param toScale - The scale they should now express.
 */
export function retuneSegmentsToScale(
  segments: ChordSegment[],
  fromScale: Scale,
  toScale: Scale
): ChordSegment[] {
  return segments.map(segment => {
    if (segment.kind === 'note') {
      return retuneNote(segment, fromScale, toScale);
    }

    if (!segment.romanNumeral) return segment;

    const degree = degreeOfNumeral(fromScale, segment.romanNumeral);
    if (degree === -1) return segment;

    // Keep a seventh a seventh: the note count is what the user chose, the scale
    // only decides which notes.
    const target = isSeventhChord(segment)
      ? getDiatonicSevenths(toScale)
      : getDiatonicChords(toScale);

    // A shorter scale (pentatonic, blues) may simply not have this degree.
    const chord = target[degree];
    if (!chord) return segment;

    return {
      ...segment,
      root: chord.root,
      quality: chord.quality,
      romanNumeral: chord.romanNumeral,
      chordSymbol: formatChordSymbol(chord.root, chord.quality),
    };
  });
}

/** Move a single-note segment onto the same scale degree of the new scale. */
function retuneNote(
  segment: ChordSegment,
  fromScale: Scale,
  toScale: Scale
): ChordSegment {
  if (segment.pitch === undefined) return segment;

  const fromPitches = getScalePitches(fromScale.root, fromScale.type);
  const toPitches = getScalePitches(toScale.root, toScale.type);

  const pitchClass = ((segment.pitch % 12) + 12) % 12;
  const degree = fromPitches.indexOf(pitchClass);
  if (degree === -1 || toPitches[degree] === undefined) return segment;

  // Shift by the shorter way round the circle so the note stays in its register
  // instead of leaping an octave when the pitch class wraps.
  let delta = ((toPitches[degree] - pitchClass) % 12 + 12) % 12;
  if (delta > 6) delta -= 12;

  return {
    ...segment,
    pitch: segment.pitch + delta,
    root: SEMITONE_TO_NOTE[toPitches[degree]],
  };
}

/** True when a segment's quality has four notes, so a step must keep it a seventh. */
function isSeventhChord(segment: ChordSegment): boolean {
  return segment.quality
    ? CHORD_INTERVALS[segment.quality as ChordQualityKey].length === 4
    : false;
}

/**
 * Which degree of `scale` a chord segment sits on, or -1.
 *
 * The roman numeral is the authority — it is what the user wrote — but a segment
 * dropped without one still names a degree through its root, so fall back to that
 * before giving up and calling the chord chromatic.
 */
function degreeOfChord(segment: ChordSegment, scale: Scale): number {
  if (segment.romanNumeral) {
    const byNumeral = degreeOfNumeral(scale, segment.romanNumeral);
    if (byNumeral !== -1) return byNumeral;
  }
  if (!segment.root) return -1;
  return getScalePitches(scale.root, scale.type).indexOf(NOTE_NAMES.indexOf(segment.root));
}

/**
 * Moves a segment one step along the bar's scale — the meaning of the up and down
 * arrow keys.
 *
 * A note moves to the neighbouring pitch of the scale; a chord moves to the
 * neighbouring scale degree, keeping its size (a seventh stays a seventh) and its
 * inversion. Either way the result stays inside the scale, so stepping never
 * introduces a note the bar's key does not contain.
 *
 * A step that would leave the roll's range, or a chromatic chord that sits on no
 * degree at all, returns the segment unchanged rather than clamping — holding the
 * key down stops at the edge instead of piling up against it.
 *
 * @param segment - The segment to move.
 * @param scale - The scale of the bar the segment lives in.
 * @param direction - 1 for up, -1 for down.
 */
export function stepSegmentInScale(
  segment: ChordSegment,
  scale: Scale,
  direction: -1 | 1
): ChordSegment {
  const pitches = getScalePitches(scale.root, scale.type);

  if (segment.kind === 'note') {
    if (segment.pitch === undefined) return segment;

    // Walk semitone by semitone rather than by degree: that is what makes B4 step
    // to C5 across the octave line, and what snaps an off-scale pitch back on.
    let midi = segment.pitch;
    for (let i = 0; i < 12; i++) {
      midi += direction;
      if (pitches.includes(((midi % 12) + 12) % 12)) break;
    }
    if (midi < PIANO_ROLL_MIN_MIDI || midi > PIANO_ROLL_MAX_MIDI) return segment;

    const degree = pitches.indexOf(((midi % 12) + 12) % 12);
    return {
      ...segment,
      pitch: midi,
      root: SEMITONE_TO_NOTE[((midi % 12) + 12) % 12],
      // The numeral names the degree the note now sits on; leaving the old one
      // would label a D as the tonic.
      romanNumeral: getDiatonicChords(scale)[degree]?.romanNumeral,
    };
  }

  const degree = degreeOfChord(segment, scale);
  if (degree === -1) return segment;

  const target = isSeventhChord(segment) ? getDiatonicSevenths(scale) : getDiatonicChords(scale);
  const next = target[(degree + direction + target.length) % target.length];
  if (!next) return segment;

  const octave = (segment.octave ?? 4) + registerShift(segment.root, next.root, direction);
  if (octave < MIN_SEGMENT_OCTAVE || octave > MAX_SEGMENT_OCTAVE) return segment;

  return {
    ...segment,
    root: next.root,
    quality: next.quality,
    romanNumeral: next.romanNumeral,
    chordSymbol: formatChordSymbol(next.root, next.quality),
    octave,
  };
}

/**
 * Whether a step from one chord root to the next crosses the octave line, as -1,
 * 0 or 1.
 *
 * Wrapping the *degree index* is not enough to decide this. In C major, vii° (B)
 * to I (C) has to rise a register; but in A minor, VII (G) to i (A) must not —
 * A already sits a tone above G. What both cases share is that the root ascends
 * monotonically, so the register moves exactly when the pitch class crosses C.
 */
function registerShift(
  from: NoteName | undefined,
  to: NoteName,
  direction: -1 | 1
): number {
  if (!from) return 0;
  const fromSemitone = NOTE_NAMES.indexOf(from);
  const toSemitone = NOTE_NAMES.indexOf(to);
  if (direction === 1) return toSemitone <= fromSemitone ? 1 : 0;
  return toSemitone >= fromSemitone ? -1 : 0;
}

/**
 * Moves a segment a whole octave — the meaning of the + and - keys.
 *
 * A note carries an absolute pitch, so it moves by 12 semitones and is bounded by
 * the roll; a chord carries a register, so it moves by one and is bounded by the
 * registers the palette offers. A shift past either bound is refused.
 *
 * @param segment - The segment to move.
 * @param direction - 1 for up, -1 for down.
 */
export function shiftSegmentOctave(segment: ChordSegment, direction: -1 | 1): ChordSegment {
  if (segment.kind === 'note') {
    if (segment.pitch === undefined) return segment;
    const pitch = segment.pitch + direction * 12;
    if (pitch < PIANO_ROLL_MIN_MIDI || pitch > PIANO_ROLL_MAX_MIDI) return segment;
    return { ...segment, pitch };
  }

  const octave = (segment.octave ?? 4) + direction;
  if (octave < MIN_SEGMENT_OCTAVE || octave > MAX_SEGMENT_OCTAVE) return segment;
  return { ...segment, octave };
}

/**
 * Advances a chord to its next inversion, wrapping back to root position — the
 * meaning of the `i` key.
 *
 * The cycle is as long as the chord has notes, so a triad returns to root position
 * on the third press and a seventh on the fourth. Note segments have no voicing to
 * rotate and come back untouched.
 */
export function cycleSegmentInversion(segment: ChordSegment): ChordSegment {
  if (segment.kind === 'note' || !segment.quality) return segment;
  const size = CHORD_INTERVALS[segment.quality as ChordQualityKey].length;
  return { ...segment, inversion: ((segment.inversion ?? 0) + 1) % size };
}

/**
 * Merge adjacent chords with the same Roman numeral into a single chord.
 * Preserves the total duration and the first chord's metadata.
 *
 * @param chords - The array of chord segments.
 * @returns A new array with merged adjacent chords.
 */
export function mergeAdjacentChords(chords: ChordSegment[]): ChordSegment[] {
  if (chords.length === 0) {
    return [];
  }

  const result: ChordSegment[] = [];
  let current = { ...chords[0] };

  for (let i = 1; i < chords.length; i++) {
    if (chords[i].romanNumeral === current.romanNumeral) {
      // Merge: extend duration
      current.duration += chords[i].duration;
      // Preserve chordSymbol if set
      if (chords[i].chordSymbol) {
        current.chordSymbol = chords[i].chordSymbol;
      }
    } else {
      result.push(current);
      current = { ...chords[i] };
    }
  }

  result.push(current);
  return result;
}

/**
 * Get the duration of a chord segment.
 *
 * @param chord - The chord segment.
 * @param beatsPerMeasure - The beats per measure (for context).
 * @returns The chord's duration in beats.
 */
export function getChordDuration(chord: ChordSegment): number {
  return chord.duration;
}
