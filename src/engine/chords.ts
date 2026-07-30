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
const CHORD_INTERVALS: Record<ChordQuality, number[]> = {
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
const SEMITONE_TO_NOTE: Record<number, NoteName> = {
  0: 'C', 1: 'C#', 2: 'D', 3: 'D#', 4: 'E', 5: 'F',
  6: 'F#', 7: 'G', 8: 'G#', 9: 'A', 10: 'A#', 11: 'B',
};

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

/**
 * Returns the diatonic chords for the given scale.
 * @param scale - The scale to derive chords from.
 * @returns Array of 7 chord info objects (one per scale degree).
 */
export function getDiatonicChords(scale: Scale): ChordInfo[] {
  const scalePitches = getScalePitches(scale.root, scale.type);
  const qualities =
    scale.type === 'naturalMinor' || scale.type === 'harmonicMinor' || scale.type === 'melodicMinor'
      ? DIATONIC_CHORD_QUALITIES_MINOR
      : DIATONIC_CHORD_QUALITIES_MAJOR;

  const isMinor =
    scale.type === 'naturalMinor' || scale.type === 'harmonicMinor' || scale.type === 'melodicMinor';
  const bases = isMinor ? ROMAN_NUMERAL_BASES_MINOR : ROMAN_NUMERAL_BASES_MAJOR;

  return scalePitches.map((pitch, index) => {
    const rootNote = SEMITONE_TO_NOTE[pitch];
    return {
      root: rootNote,
      quality: qualities[index],
      romanNumeral: romanForQuality(qualities[index], bases[index]),
    };
  });
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

  // Apply inversion: rotate the first `inversion` elements to the end, adding 12
  const shifted = [...intervals];
  for (let i = 0; i < inversion && i < shifted.length; i++) {
    const moved = shifted.shift()!;
    shifted.push(moved + 12);
  }

  return shifted.map(interval => baseMidi + rootSemitone + interval);
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
  if (trimmed === 'maj7' || trimmed === 'maj7' || trimmed === 'M7' || trimmed === 'Δ' || trimmed === '△') {
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
