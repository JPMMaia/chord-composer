import type { NoteName, ScaleType, TimeSignature } from '@/types/music';

/** All 12 note names in chromatic order */
export const NOTE_NAMES: NoteName[] = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

/** All supported scale types */
export const SCALE_TYPES: ScaleType[] = [
  'major',
  'naturalMinor',
  'harmonicMinor',
  'melodicMinor',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'locrian',
  'pentatonicMajor',
  'pentatonicMinor',
  'blues',
];

/** Default time signature: 4/4 */
export const DEFAULT_TIME_SIGNATURE: TimeSignature = {
  beatsPerMeasure: 4,
  beatUnit: 4,
};

/**
 * Width of the piano roll's key column, in pixels.
 *
 * Shared with the chord timeline, which reserves the same gutter before bar 1 so
 * its bar lines sit directly above the piano roll's.
 */
export const PIANO_KEYS_WIDTH = 80;

/**
 * Horizontal zoom of the beat axis, in pixels per beat.
 *
 * Shared by the chord timeline and the piano roll: they scroll from a single
 * offset, so a difference here would show up directly as misalignment.
 */
export const PIXELS_PER_BEAT = 80;

/**
 * Width of a bar line, in pixels.
 *
 * The timeline draws its bar lines in the DOM and the piano roll paints its own on
 * canvas, so both follow one rule: a bar line covers the two pixels *starting* at
 * its beat, except the closing line, which is pulled inside so the project still
 * ends exactly at `totalBeats * PIXELS_PER_BEAT`.
 */
export const BAR_LINE_WIDTH = 2;

/**
 * Pitch range the piano roll draws, as MIDI note numbers: a standard 88-key
 * piano, A0 to C8. The roll scrolls vertically over the whole span.
 */
export const PIANO_ROLL_MIN_MIDI = 21;
export const PIANO_ROLL_MAX_MIDI = 108;

/** Number of key rows on the roll — 88. */
export const PIANO_ROLL_KEY_COUNT = PIANO_ROLL_MAX_MIDI - PIANO_ROLL_MIN_MIDI + 1;

/**
 * Registers a chord segment may be voiced in.
 *
 * Bounded so every chord stays inside the roll's A0–C8 window: octave 1 puts the
 * lowest root at MIDI 24, and octave 7 leaves a seventh chord's top note at MIDI
 * 107. Both the palette dropdown and the octave shortcut read these, so a chord
 * cannot be pushed somewhere the roll could not show it.
 */
export const MIN_SEGMENT_OCTAVE = 1;
export const MAX_SEGMENT_OCTAVE = 7;

/** Default BPM */
export const DEFAULT_BPM = 120;

/** Default key */
export const DEFAULT_KEY: NoteName = 'C';

/** Default key mode */
export const DEFAULT_KEY_MODE: 'major' | 'minor' = 'major';
