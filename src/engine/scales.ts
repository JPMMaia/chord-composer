import type { NoteName, ScaleType, Scale } from '@/types/music';
import { MAX_SEGMENT_OCTAVE } from '@/utils/constants';

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
 * The semitone a root note stands on, 0-11 (C=0), including flat spellings like 'Eb'.
 *
 * Exported because degree arithmetic outside this file needs it too: transposing a
 * formula's scale reference by a root offset asks exactly this question, and a second
 * copy of the table would be a second thing to keep in step.
 */
export function rootSemitone(root: string): number {
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
  const tonic = rootSemitone(root);
  const intervals = getScaleIntervals(type);
  return intervals.map(interval => (tonic + interval) % 12);
}

/**
 * How far a pitch class sits above the tonic, in semitones (0-11).
 *
 * A scale is voiced as an ascending run from its root, so a degree whose pitch class
 * wrapped below the tonic — C# in D major — comes back as 11, not -1.
 *
 * @param scale - The scale whose root the offset is measured from.
 * @param pitchClass - The pitch class to measure (0=C, 1=C#, ..., 11=B).
 */
export function degreeOffsetFromTonic(scale: Scale, pitchClass: number): number {
  const tonic = rootSemitone(scale.root);
  return (((pitchClass - tonic) % 12) + 12) % 12;
}

/**
 * Whether a scale degree crosses the octave line, as 0 or 1.
 *
 * The register moves exactly when the ascending run passes C, which is what makes
 * A minor's third degree a C *above* its A rather than the C below it. This is the
 * same rule `registerShift` applies when the arrow keys walk a chord along the
 * scale, so stepping and dropping land in the same place.
 */
export function degreeRegisterShift(scale: Scale, pitchClass: number): 0 | 1 {
  const tonic = rootSemitone(scale.root);
  return tonic + degreeOffsetFromTonic(scale, pitchClass) >= 12 ? 1 : 0;
}

/**
 * The register a scale degree belongs in when the scale is voiced as an ascending
 * run starting at `baseOctave`.
 *
 * The chosen octave is the *root note's* — the rest of the scale rises from it, so a
 * degree whose pitch class wrapped below the tonic belongs in the next octave. Without
 * this the run dips backwards at the wrap point: D major at octave 4 would put its
 * vii° on C#4, a semitone under its own tonic.
 *
 * Capped at `MAX_SEGMENT_OCTAVE`, the highest register a chord segment may hold: at the
 * very top of the range the wrap cannot be honoured without pushing the chord off the
 * piano roll.
 *
 * @param scale - The scale the degree belongs to.
 * @param pitchClass - Pitch class of the degree (0=C, 1=C#, ..., 11=B).
 * @param baseOctave - Register of the scale's root note.
 */
export function octaveForDegree(
  scale: Scale,
  pitchClass: number,
  baseOctave: number
): number {
  return Math.min(baseOctave + degreeRegisterShift(scale, pitchClass), MAX_SEGMENT_OCTAVE);
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
 * The scale a project's key names — what a segment falls back to when it carries
 * no key of its own.
 *
 * `Project.keyMode` only distinguishes major from minor, so this is a widening:
 * the twelve scale types a segment may hold cannot all be expressed as a project
 * key, and nothing tries to round-trip one back.
 */
export function projectScale(key: NoteName, keyMode: 'major' | 'minor'): Scale {
  return { root: key, type: keyMode === 'minor' ? 'naturalMinor' : 'major' };
}

/**
 * The key a segment is written in.
 *
 * The one place the fallback is spelled out, so every reader — note generation,
 * the inspector, the arrow keys — agrees about what an absent key means.
 *
 * @param segment - The segment to read.
 * @param fallback - The project's key, used when the segment carries none.
 */
export function segmentScale(segment: { scale?: Scale }, fallback: Scale): Scale {
  return segment.scale ?? fallback;
}

/**
 * Formats a scale type enum into a human-readable label.
 */
export function formatScaleType(type: ScaleType): string {
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
