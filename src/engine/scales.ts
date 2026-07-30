import type { NoteName, ScaleType, Scale } from '@/types/music';

/**
 * Interval patterns (in semitones) for each scale type relative to the root.
 */
export const SCALE_INTERVALS: Record<ScaleType, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  naturalMinor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

/** Mapping from note name to semitone offset (C=0, C#=1, ..., B=11). */
const NOTE_TO_SEMITONE: Record<NoteName, number> = {
  C: 0,
  'C#': 1,
  D: 2,
  'D#': 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  'G#': 8,
  A: 9,
  'A#': 10,
  B: 11,
};

/** Mapping from flat note strings to semitone offsets. */
const FLAT_TO_SEMITONE: Record<string, number> = {
  Db: 3,
  Eb: 3,
  Fb: 4,
  Gb: 6,
  Ab: 8,
  Bb: 10,
  Cb: 0,
};

/**
 * Resolves a root note string (including flat notation like 'Eb') to a semitone offset.
 */
function resolveRootSemitone(root: string): number {
  const sharp = NOTE_TO_SEMITONE[root as NoteName];
  if (sharp !== undefined) return sharp;
  const flat = FLAT_TO_SEMITONE[root];
  if (flat !== undefined) return flat;
  throw new Error(`Invalid root note: ${root}`);
}

/**
 * Returns the interval pattern for the given scale type.
 * @param type - The scale type.
 * @returns Array of semitone intervals relative to the root.
 */
export function getScaleIntervals(type: ScaleType): number[] {
  const intervals = SCALE_INTERVALS[type];
  if (!intervals) {
    throw new Error(`Invalid scale type: ${type}`);
  }
  return [...intervals];
}

/**
 * Returns the pitch classes (0-11) for a scale starting at the given root.
 * Supports both sharp (C#, D#) and flat (Db, Eb) notation.
 * @param root - The root note name.
 * @param type - The scale type.
 * @returns Array of pitch classes in the scale.
 */
export function getScalePitches(root: NoteName, type: ScaleType): number[] {
  const rootSemitone = resolveRootSemitone(root);
  const intervals = getScaleIntervals(type);
  return intervals.map(interval => (rootSemitone + interval) % 12);
}

/**
 * Checks whether a pitch class (0-11) belongs to the given scale.
 * @param pitchClass - The pitch class to check (0=C, 1=C#, ..., 11=B).
 * @param scale - The scale to check against.
 * @returns True if the pitch class is in the scale.
 */
export function isNoteInScale(pitchClass: number, scale: Scale): boolean {
  const pitches = getScalePitches(scale.root, scale.type);
  return pitches.includes(pitchClass % 12);
}

/**
 * Returns all MIDI note numbers for the given scale within the specified octave range.
 * Octave numbers follow standard MIDI convention: octave 4 = C4 (MIDI 60).
 * @param scale - The scale to use.
 * @param minOctave - Minimum octave (inclusive), e.g. 2 for C2.
 * @param maxOctave - Maximum octave (inclusive).
 * @returns Sorted array of MIDI note numbers.
 */
export function getNotesInOctave(
  scale: Scale,
  minOctave: number,
  maxOctave: number
): number[] {
  const pitches = getScalePitches(scale.root, scale.type);
  const notes: number[] = [];

  for (let octave = minOctave; octave <= maxOctave; octave++) {
    const baseMidi = (octave + 1) * 12; // C in MIDI octave N = (N+1) * 12
    for (const pitch of pitches) {
      const midiNote = baseMidi + pitch;
      if (midiNote >= 0 && midiNote <= 127) {
        notes.push(midiNote);
      }
    }
  }

  return notes.sort((a, b) => a - b);
}

/**
 * Returns a human-readable scale name.
 * @param root - The root note name.
 * @param type - The scale type.
 * @returns Display name like "C Major" or "Eb Minor".
 */
export function getScaleName(root: NoteName, type: ScaleType): string {
  const rootLabel = root;
  const typeLabel = formatScaleType(type);
  return `${rootLabel} ${typeLabel}`;
}

/**
 * Formats a scale type enum into a human-readable label.
 */
function formatScaleType(type: ScaleType): string {
  const labels: Record<ScaleType, string> = {
    major: 'Major',
    naturalMinor: 'Minor',
    harmonicMinor: 'Harmonic Minor',
    melodicMinor: 'Melodic Minor',
    dorian: 'Dorian',
    phrygian: 'Phrygian',
    lydian: 'Lydian',
    mixolydian: 'Mixolydian',
    locrian: 'Locrian',
    pentatonicMajor: 'Pentatonic Major',
    pentatonicMinor: 'Pentatonic Minor',
    blues: 'Blues',
  };
  return labels[type] || type;
}
