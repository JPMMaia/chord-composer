import type { Bar, ChordSegment, Note } from '@/types/music';
import { generateId } from '@/utils/id';
import { getDiatonicChords, SEMITONE_TO_NOTE } from '@/engine/chords';
import { getScalePitches } from '@/engine/scales';

/**
 * Split a bar into equal-duration chord segments with diatonic chords.
 * Each chord gets a Roman numeral based on the bar's scale.
 *
 * @param bar - The bar to split.
 * @param chordCount - Number of chord segments to create.
 * @returns Array of ChordSegment objects.
 */
export function splitBarIntoChords(bar: Bar, chordCount: number): ChordSegment[] {
  if (chordCount < 1) {
    throw new Error('chordCount must be at least 1');
  }

  const beatsPerMeasure = bar.chords.length > 0
    ? bar.chords.reduce((sum, c) => sum + c.duration, 0) || 4
    : 4;

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
      romanNumeral: chordInfo.romanNumeral,
      chordSymbol: `${chordInfo.root}${chordInfo.quality === 'major' ? '' : chordInfo.quality === 'minor' ? 'm' : chordInfo.quality === 'diminished' ? 'dim' : ''}`,
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
 * Auto-fill piano roll notes from chord segments in a bar.
 * Each chord generates a triad based on its quality, placed at the correct beat position.
 *
 * @param bar - The bar containing the chords.
 * @param chords - The chord segments to generate notes from.
 * @param octave - The octave for the root note (e.g., 4 for middle C octave).
 * @returns Array of Note objects.
 */
export function autoFillNotesFromChords(
  bar: Bar,
  chords: ChordSegment[],
  octave: number
): Note[] {
  if (chords.length === 0) {
    throw new Error('Cannot auto-fill notes from an empty chords array');
  }

  // Validate total duration
  const totalDuration = chords.reduce((sum, c) => sum + c.duration, 0);
  const beatsPerMeasure = bar.chords.length > 0
    ? bar.chords.reduce((sum, c) => sum + c.duration, 0) || 4
    : 4;

  if (totalDuration > beatsPerMeasure) {
    throw new Error(`Total chord duration (${totalDuration}) exceeds bar length (${beatsPerMeasure})`);
  }

  const notes: Note[] = [];
  let currentBeat = 0;

  // Chord quality to intervals mapping
  const qualityToIntervals: Record<string, number[]> = {
    major: [0, 4, 7],
    minor: [0, 3, 7],
    diminished: [0, 3, 6],
    augmented: [0, 4, 8],
    sus2: [0, 2, 7],
    sus4: [0, 5, 7],
    dominant7: [0, 4, 7, 10],
    maj7: [0, 4, 7, 11],
    min7: [0, 3, 7, 10],
    dim7: [0, 3, 6, 9],
  };

  for (const chord of chords) {
    // Determine quality: use explicit quality, or infer from Roman numeral
    let quality = chord.quality;
    if (!quality && chord.romanNumeral) {
      const diatonicChords = getDiatonicChords(bar.scale);
      const roman = chord.romanNumeral;
      const romanClean = roman.replace(/[°+]/g, '');
      const match = diatonicChords.find(c => c.romanNumeral.replace(/[°+]/g, '') === romanClean);
      if (match) {
        quality = match.quality;
      }
    }
    quality = quality || 'major';
    const chordIntervals = qualityToIntervals[quality] || [0, 4, 7];

    // Determine root semitone
    let rootSemitone = 0;
    if (chord.root) {
      const scalePitches = getScalePitches(bar.scale.root, bar.scale.type);
      const rootIndex = scalePitches.findIndex(p => SEMITONE_TO_NOTE[p] === chord.root);
      rootSemitone = rootIndex >= 0 ? scalePitches[rootIndex] : 0;
    } else if (chord.romanNumeral) {
      // Find root from Roman numeral by matching diatonic chord
      const diatonicChords = getDiatonicChords(bar.scale);
      const roman = chord.romanNumeral;
      const romanClean = roman.replace(/[°+]/g, '');
      const match = diatonicChords.find(c => c.romanNumeral.replace(/[°+]/g, '') === romanClean);
      if (match) {
        const scalePitches = getScalePitches(bar.scale.root, bar.scale.type);
        const rootIndex = scalePitches.findIndex(p => SEMITONE_TO_NOTE[p] === match.root);
        rootSemitone = rootIndex >= 0 ? scalePitches[rootIndex] : 0;
      }
    }

    const baseMidi = (octave + 1) * 12 + rootSemitone;

    // Generate triad notes
    for (const interval of chordIntervals) {
      const pitch = baseMidi + interval;
      notes.push({
        id: generateId(),
        pitch,
        startBeat: currentBeat,
        duration: chord.duration,
        velocity: 100,
      });
    }

    currentBeat += chord.duration;
  }

  return notes;
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
