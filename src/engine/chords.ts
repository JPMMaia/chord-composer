import type { NoteName, Scale, ChordQuality } from '@/types/music';
import { getScalePitches } from './scales';

/** Internal representation of a chord with intervals. */
export interface ChordData {
  root: NoteName;
  intervals: number[];
  bass?: NoteName;
}

/** Diatonic chord info with quality and roman numeral. */
export interface ChordInfo {
  root: NoteName;
  quality: ChordQuality;
  romanNumeral: string;
}

/** Interval patterns for each chord quality (relative to root). */
export const CHORD_INTERVALS: Record<ChordQuality, number[]> = {
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
  halfDim7: [0, 3, 6, 10],
  minMaj7: [0, 3, 7, 11],
};

/** Diatonic chord qualities for a major scale (I through vii°). */
export const DIATONIC_CHORD_QUALITIES_MAJOR: ChordQuality[] = [
  'major', 'minor', 'minor', 'major', 'major', 'minor', 'diminished',
];

/** Diatonic chord qualities for a natural minor scale (i through VI). */
export const DIATONIC_CHORD_QUALITIES_MINOR: ChordQuality[] = [
  'minor', 'diminished', 'major', 'minor', 'minor', 'major', 'major',
];

/** Mapping from note name to semitone offset. */
const NOTE_TO_SEMITONE: Record<NoteName, number> = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5,
  'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

/** Mapping from semitone offset to note name. */
export const SEMITONE_TO_NOTE: Record<number, NoteName> = {
  0: 'C', 1: 'C#', 2: 'D', 3: 'D#', 4: 'E', 5: 'F',
  6: 'F#', 7: 'G', 8: 'G#', 9: 'A', 10: 'A#', 11: 'B',
};

/**
 * Scientific-pitch octave of a MIDI note: 60 -> 4, so middle C reads C4.
 * @param midi - MIDI note number.
 */
export function midiToOctave(midi: number): number {
  return Math.floor(midi / 12) - 1;
}

/**
 * Full key name for a MIDI note: 60 -> 'C4', 61 -> 'C#4'.
 *
 * Spelled with sharps, matching `NoteName`. The MusicXML exporter keeps its own
 * speller because it also has to choose flats for the key it is writing in.
 *
 * @param midi - MIDI note number.
 */
export function midiToNoteLabel(midi: number): string {
  const pitchClass = ((midi % 12) + 12) % 12;
  return `${SEMITONE_TO_NOTE[pitchClass]}${midiToOctave(midi)}`;
}

/**
 * Rotates a chord's intervals into an inversion: the lowest `inversion` notes
 * each move up an octave, so `[0,4,7]` at inversion 1 becomes `[4,7,12]` — the
 * third in the bass, the root on top.
 *
 * Kept separate from any particular octave so both the chord builder and the
 * timeline's note generator can voice a segment the same way.
 *
 * @param intervals - Ascending semitone offsets from the chord root.
 * @param inversion - How many notes to lift; values past the chord size keep
 *   rotating, which simply stacks the whole chord an octave higher.
 * @returns A new array; the input is left alone.
 */
export function invertIntervals(intervals: number[], inversion: number): number[] {
  const shifted = [...intervals];
  for (let i = 0; i < inversion; i++) {
    shifted.push(shifted.shift()! + 12);
  }
  return shifted;
}

/** Roman numeral labels for major scale degrees (case varies by quality). */
const ROMAN_NUMERAL_BASES_MAJOR = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** Roman numeral labels for minor scale degrees. */
const ROMAN_NUMERAL_BASES_MINOR = ['i', 'ii', 'III', 'iv', 'v', 'VI', 'VII'];

/** Map chord quality to roman numeral case: major=a, minor=lower, diminished=lower+° */
function romanForQuality(quality: ChordQuality, base: string): string {
  switch (quality) {
    case 'major':
      return base.toUpperCase();
    case 'minor':
      return base.toLowerCase();
    case 'diminished':
      return base.toLowerCase() + '°';
    case 'augmented':
      return base.toLowerCase() + '+';
    default:
      return base.toLowerCase();
  }
}

/** True for the scale types whose roman numerals use minor-key casing. */
function isMinorScale(scale: Scale): boolean {
  return (
    scale.type === 'naturalMinor' ||
    scale.type === 'harmonicMinor' ||
    scale.type === 'melodicMinor'
  );
}

/**
 * Builds a chord by stacking thirds *within the scale itself* — taking degrees
 * i, i+2, i+4 (and i+6 for a seventh), wrapping around the scale.
 *
 * Deriving chords from the scale rather than from a fixed 7-entry quality table
 * is what makes this correct for every scale type, including the 5-note
 * pentatonics and the 6-note blues scale.
 *
 * @param scalePitches - Pitch classes of the scale, in scale-degree order.
 * @param degree - Index of the scale degree to build on.
 * @param noteCount - 3 for a triad, 4 for a seventh.
 * @returns Ascending semitone intervals relative to the chord root.
 */
export function buildStackedChord(
  scalePitches: number[],
  degree: number,
  noteCount: 3 | 4
): number[] {
  const length = scalePitches.length;
  const root = scalePitches[degree % length];
  const intervals: number[] = [];

  for (let i = 0; i < noteCount; i++) {
    const pitch = scalePitches[(degree + i * 2) % length];
    let interval = ((pitch - root) % 12 + 12) % 12;
    // Keep the stack ascending — a wrapped degree belongs in the next octave.
    while (i > 0 && interval <= intervals[i - 1]) {
      interval += 12;
    }
    intervals.push(interval);
  }

  return intervals;
}

/**
 * Matches an interval set back to a known chord quality.
 * @returns The quality, or undefined when the intervals match nothing known.
 */
export function classifyIntervals(intervals: number[]): ChordQuality | undefined {
  const qualities = Object.keys(CHORD_INTERVALS) as ChordQuality[];
  return qualities.find(quality => intervalsEqual(intervals, CHORD_INTERVALS[quality]));
}

/**
 * Falls back to a usable quality when a stacked chord matches no known pattern,
 * which happens on gapped scales like pentatonic and blues. The third decides.
 */
function approximateQuality(intervals: number[]): ChordQuality {
  return intervals[1] === 3 ? 'minor' : 'major';
}

/**
 * Builds the diatonic chords of a scale by stacking thirds on each degree.
 * @param scale - The scale to derive chords from.
 * @param noteCount - 3 for triads, 4 for sevenths.
 */
function getDiatonicStack(scale: Scale, noteCount: 3 | 4): ChordInfo[] {
  const scalePitches = getScalePitches(scale.root, scale.type);
  const bases = isMinorScale(scale) ? ROMAN_NUMERAL_BASES_MINOR : ROMAN_NUMERAL_BASES_MAJOR;

  return scalePitches.map((pitch, index) => {
    const intervals = buildStackedChord(scalePitches, index, noteCount);
    const quality = classifyIntervals(intervals) ?? approximateQuality(intervals);

    // Roman numerals are cased by the *triad* at this degree, so that a seventh
    // reads as V7 rather than switching case with its extension.
    const triadIntervals =
      noteCount === 3 ? intervals : buildStackedChord(scalePitches, index, 3);
    const triadQuality =
      classifyIntervals(triadIntervals) ?? approximateQuality(triadIntervals);

    return {
      root: SEMITONE_TO_NOTE[pitch],
      quality,
      romanNumeral: romanForQuality(triadQuality, bases[index % bases.length]),
    };
  });
}

/**
 * Returns the diatonic triads for the given scale.
 * @param scale - The scale to derive chords from.
 * @returns One chord info object per scale degree (7 for heptatonic scales).
 */
export function getDiatonicChords(scale: Scale): ChordInfo[] {
  return getDiatonicStack(scale, 3);
}

/**
 * Returns the diatonic seventh chords for the given scale — Imaj7, iim7, V7 and
 * so on, including the half-diminished vii of a major key.
 * @param scale - The scale to derive chords from.
 * @returns One chord info object per scale degree.
 */
export function getDiatonicSevenths(scale: Scale): ChordInfo[] {
  return getDiatonicStack(scale, 4);
}

/**
 * Returns the Roman numeral for a chord within a scale.
 * @param chordRoot - The root note of the chord.
 * @param chordQuality - The quality of the chord.
 * @param scale - The scale context.
 * @returns Roman numeral string (e.g., 'I', 'ii', 'V').
 */
export function getRomanNumeral(
  chordRoot: NoteName,
  chordQuality: ChordQuality,
  scale: Scale
): string {
  const diatonicChords = getDiatonicChords(scale);
  const chordSemitone = NOTE_TO_SEMITONE[chordRoot];
  if (chordSemitone === undefined) {
    throw new Error(`Invalid chord root: ${chordRoot}`);
  }

  const index = diatonicChords.findIndex(
    c => c.root === chordRoot && c.quality === chordQuality
  );

  if (index === -1) {
    // Try to find by pitch class only
    const scalePitches = getScalePitches(scale.root, scale.type);
    const pitchIndex = scalePitches.indexOf(chordSemitone);
    if (pitchIndex === -1) {
      throw new Error(`Chord ${chordRoot} ${chordQuality} not diatonic to ${scale.root} ${scale.type}`);
    }
    const isMinor =
      scale.type === 'naturalMinor' || scale.type === 'harmonicMinor' || scale.type === 'melodicMinor';
    const romanNumerals = isMinor ? ROMAN_NUMERAL_BASES_MINOR : ROMAN_NUMERAL_BASES_MAJOR;
    return romanNumerals[pitchIndex];
  }

  return diatonicChords[index].romanNumeral;
}

/**
 * Creates a chord from a Roman numeral within a scale.
 * @param roman - Roman numeral string (e.g., 'I', 'ii', 'vii°').
 * @param scale - The scale context.
 * @returns ChordInfo with root, quality, and intervals.
 */
export function chordFromRomanNumeral(roman: string, scale: Scale): ChordInfo & { intervals: number[] } {
  const diatonicChords = getDiatonicChords(scale);
  const romanClean = roman.replace(/[°+]/g, '');

  // Find matching chord by roman numeral (strip suffixes from stored values too)
  const match = diatonicChords.find(c => c.romanNumeral.replace(/[°+]/g, '') === romanClean);
  if (!match) {
    throw new Error(`Invalid Roman numeral '${roman}' for scale ${scale.root} ${scale.type}`);
  }

  return {
    root: match.root,
    quality: match.quality,
    romanNumeral: match.romanNumeral,
    intervals: CHORD_INTERVALS[match.quality],
  };
}

/**
 * Parses a chord symbol string into a ChordData object.
 * Supports: C, Cm, Cmaj7, C7, Cmin7, Cdim, Caug, Csus2, Csus4, Cm9, C/E, etc.
 * @param symbol - Chord symbol string.
 * @returns ChordData with root, intervals, and optional bass note.
 */
export function chordFromSymbol(symbol: string): ChordData {
  // Handle inversion: C/E
  let bassNote: NoteName | undefined;
  let chordPart = symbol;
  if (symbol.includes('/')) {
    const [chordStr, bassStr] = symbol.split('/');
    chordPart = chordStr.trim();
    bassNote = bassStr.trim() as NoteName;
    if (NOTE_TO_SEMITONE[bassNote] === undefined) {
      throw new Error(`Invalid bass note in chord symbol: ${symbol}`);
    }
  }

  // Parse root note (first character, possibly followed by # or b)
  let root: NoteName | undefined;
  let rest = chordPart;

  // Try to match root + accidental
  if (chordPart.length >= 2 && chordPart[1] === '#') {
    root = chordPart.substring(0, 2) as NoteName;
    rest = chordPart.substring(2);
  } else if (chordPart.length >= 2 && chordPart[1] === 'b') {
    // Handle flat notation: Cm(b7) → C minor with flat 7 (simplified: just use root)
    root = chordPart.substring(0, 2) as NoteName;
    rest = chordPart.substring(2);
  } else {
    root = chordPart[0] as NoteName;
    rest = chordPart.substring(1);
  }

  if (root === undefined || NOTE_TO_SEMITONE[root] === undefined) {
    throw new Error(`Invalid chord symbol: ${symbol}`);
  }

  // Determine quality and extensions from the rest
  const intervals = parseChordQuality(rest);
  if (intervals.length < 3) {
    throw new Error(`Cannot determine chord quality from symbol: ${symbol}`);
  }

  return { root, intervals, bass: bassNote };
}

/**
 * Converts a chord to MIDI note numbers.
 * @param chord - ChordData with root and intervals.
 * @param octave - The octave for the root (e.g., 4 for middle C octave).
 * @param inversion - Inversion offset (0 = root position).
 * @returns Array of MIDI note numbers.
 */
export function chordToNotes(chord: ChordData, octave: number, inversion: number = 0): number[] {
  const intervals = chord.intervals;

  // Validate: need at least a triad (3 notes)
  if (intervals.length < 3) {
    throw new Error('Invalid chord intervals: need at least 3 notes for a triad');
  }

  // Check that intervals match a known chord quality
  const knownQualities = Object.values(CHORD_INTERVALS);
  const isValid = knownQualities.some(known => intervalsEqual(intervals, known));
  if (!isValid) {
    throw new Error('Invalid chord intervals: does not match any known chord quality');
  }

  const rootSemitone = NOTE_TO_SEMITONE[chord.root];
  const baseMidi = (octave + 1) * 12;

  return invertIntervals(intervals, inversion).map(
    interval => baseMidi + rootSemitone + interval
  );
}

/**
 * Parses a chord quality suffix string into interval offsets.
 */
function parseChordQuality(rest: string): number[] {
  const trimmed = rest.trim();

  // Check for extended chords first (maj9, m9, 9, 11, 13)
  if (/^[mM]?[0-9]+$/.test(trimmed)) {
    const isMinor = trimmed.startsWith('m');
    const number = parseInt(trimmed.replace('m', ''), 10);

    if (number === 7) {
      return isMinor ? CHORD_INTERVALS.min7 : CHORD_INTERVALS.dominant7;
    }
    if (number === 9) {
      // For m9: minor triad + min7 + major 9th (14)
      // For 9 (dominant 9th): dominant7 + major 9th (14)
      const base = isMinor ? CHORD_INTERVALS.min7 : CHORD_INTERVALS.dominant7;
      return [...base, 14];
    }
    if (number === 11) {
      const base = isMinor ? CHORD_INTERVALS.min7 : CHORD_INTERVALS.dominant7;
      return [...base, 14, 17];
    }
    if (number === 13) {
      const base = isMinor ? CHORD_INTERVALS.min7 : CHORD_INTERVALS.dominant7;
      return [...base, 14, 17, 21];
    }
  }

  // Check for maj7
  if (trimmed === 'maj7' || trimmed === 'M7' || trimmed === 'Δ' || trimmed === '△') {
    return CHORD_INTERVALS.maj7;
  }

  // Check for dominant 7th
  if (trimmed === '7' || trimmed === 'dom7') {
    return CHORD_INTERVALS.dominant7;
  }

  // Check for minor 7th
  if (trimmed === 'm7' || trimmed === 'min7') {
    return CHORD_INTERVALS.min7;
  }

  // Check for diminished 7th
  if (trimmed === 'dim7' || trimmed === '°7' || trimmed === 'o7') {
    return CHORD_INTERVALS.dim7;
  }

  // Check for half-diminished 7th (m7b5)
  if (
    trimmed === 'm7b5' || trimmed === 'min7b5' || trimmed === 'ø' || trimmed === 'ø7'
  ) {
    return CHORD_INTERVALS.halfDim7;
  }

  // Check for minor-major 7th
  if (trimmed === 'mMaj7' || trimmed === 'mM7' || trimmed === 'minMaj7') {
    return CHORD_INTERVALS.minMaj7;
  }

  // Check for triads
  if (trimmed === '' || trimmed === 'maj' || trimmed === 'M' || trimmed === '△') {
    return CHORD_INTERVALS.major;
  }
  if (trimmed === 'm' || trimmed === 'min' || trimmed === '-') {
    return CHORD_INTERVALS.minor;
  }
  if (trimmed === 'dim' || trimmed === '°' || trimmed === 'o') {
    return CHORD_INTERVALS.diminished;
  }
  if (trimmed === 'aug' || trimmed === '+' || trimmed === 'aug7') {
    return CHORD_INTERVALS.augmented;
  }
  if (trimmed === 'sus2') {
    return CHORD_INTERVALS.sus2;
  }
  if (trimmed === 'sus4' || trimmed === 'sus') {
    return CHORD_INTERVALS.sus4;
  }

  // Default to major triad for unrecognized suffixes
  return CHORD_INTERVALS.major;
}

/**
 * Compares two interval arrays for equality.
 */
function intervalsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
