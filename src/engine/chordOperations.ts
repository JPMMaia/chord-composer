import type { Bar, ChordSegment, Note, Scale, TimeSignature } from '@/types/music';
import { generateId } from '@/utils/id';
import {
  CHORD_INTERVALS,
  getDiatonicChords,
  getDiatonicSevenths,
  SEMITONE_TO_NOTE,
} from '@/engine/chords';
import { getScalePitches } from '@/engine/scales';
import { getBarBeats } from '@/engine/timeline';
import { formatChordSymbol } from '@/engine/palette';
import { DEFAULT_TIME_SIGNATURE, NOTE_NAMES } from '@/utils/constants';

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
 * Generates the piano-roll notes for a bar from its segments.
 *
 * This is the sync engine behind the chord panel: `bar.notes` is derived state,
 * regenerated whenever segments change, so the piano roll always mirrors the
 * timeline. A chord segment expands to its stacked intervals; a note segment
 * yields a single pitch.
 *
 * Deliberately total — it never throws — because it runs on every edit, including
 * transient states like a bar whose last segment was just deleted.
 *
 * @param bar - The bar whose segments drive the notes.
 * @param projectTs - Project time signature, used when the bar has none.
 * @param octave - Octave for chord roots (e.g. 4 for the middle-C octave).
 * @returns The notes for this bar, in segment order.
 */
export function generateNotesFromSegments(
  bar: Bar,
  projectTs: TimeSignature,
  octave: number = 4
): Note[] {
  const notes: Note[] = [];
  const barBeats = getBarBeats(bar, projectTs);
  let currentBeat = 0;

  for (const segment of bar.chords) {
    // Segments are reflowed to fit before they reach here; anything still sitting
    // past the bar line belongs to the next bar and is that bar's job to render.
    if (currentBeat >= barBeats) break;

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
      currentBeat += segment.duration;
      continue;
    }

    const { quality, rootSemitone } = resolveChord(segment, bar);
    const baseMidi = (octave + 1) * 12 + rootSemitone;

    for (const interval of CHORD_INTERVALS[quality]) {
      notes.push({
        id: generateId(),
        pitch: baseMidi + interval,
        startBeat: currentBeat,
        duration: segment.duration,
        velocity: 100,
      });
    }

    currentBeat += segment.duration;
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
    const isSeventh = segment.quality
      ? CHORD_INTERVALS[segment.quality as ChordQualityKey].length === 4
      : false;
    const target = isSeventh ? getDiatonicSevenths(toScale) : getDiatonicChords(toScale);

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
