// Note names (12-tone chromatic scale)
export type NoteName = 'C' | 'C#' | 'D' | 'D#' | 'E' | 'F' | 'F#' | 'G' | 'G#' | 'A' | 'A#' | 'B';

// Supported scale types
export type ScaleType =
  | 'major'
  | 'naturalMinor'
  | 'harmonicMinor'
  | 'melodicMinor'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'locrian'
  | 'pentatonicMajor'
  | 'pentatonicMinor'
  | 'blues';

// Chord qualities
export type ChordQuality =
  | 'major'
  | 'minor'
  | 'diminished'
  | 'augmented'
  | 'sus2'
  | 'sus4'
  | 'dominant7'
  | 'maj7'
  | 'min7'
  | 'dim7'
  | 'halfDim7'
  | 'minMaj7';

// Time signature
export interface TimeSignature {
  beatsPerMeasure: number;
  beatUnit: number;
}

// Scale definition
export interface Scale {
  root: NoteName;
  type: ScaleType;
}

// What a timeline segment represents: a single note or a stacked chord.
export type SegmentKind = 'note' | 'chord';

// Chord segment in a bar
export interface ChordSegment {
  id: string;
  /**
   * Beats from the start of the containing bar. Absent in projects written before
   * free placement, where position was implied by packing segments end to end;
   * `withStartBeats` fills those in on load.
   */
  startBeat?: number;
  /** Defaults to 'chord' when absent, so pre-existing projects keep working. */
  kind?: SegmentKind;
  /** MIDI pitch — only meaningful when kind === 'note'. */
  pitch?: number;
  /**
   * Register a chord is voiced in, e.g. 4 for the middle-C octave. Chord
   * segments only — a note segment's register already lives in its absolute
   * `pitch`. Absent in projects written before octave selection, and read as 4.
   */
  octave?: number;
  romanNumeral?: string;
  chordSymbol?: string;
  duration: number;
  root?: NoteName;
  inversion?: number;
  quality?: ChordQuality;
}

// Individual note
export interface Note {
  id: string;
  pitch: number;
  startBeat: number;
  duration: number;
  velocity: number;
}

// Track — one instrument in the arrangement.
export interface Track {
  id: string;
  name: string;
  /**
   * The sound this instrument makes: a General MIDI id from
   * `@/engine/instrumentCatalog`, e.g. 'acoustic_grand_piano'. Empty on tracks
   * read from files written before instruments could choose a sound.
   */
  instrument: string;
  volume: number;
  pan: number;
  /**
   * Temporarily silenced. Its notes still draw in the piano roll — muting is
   * about what you hear, `visible` is about what you see.
   */
  muted: boolean;
  solo: boolean;
  /** When false, this instrument's notes are hidden from the roll. Absent reads as visible. */
  visible?: boolean;
  /** Colour its notes draw in. Absent means "assigned by index from TRACK_COLORS". */
  color?: string;
}

/**
 * One instrument's material within a bar.
 *
 * `notes` is derived from `chords` — the store regenerates it after every
 * mutation — so nothing outside `projectStore` should write it.
 */
export interface TrackContent {
  chords: ChordSegment[];
  notes: Note[];
}

// Bar (measure)
export interface Bar {
  id: string;
  barIndex: number;
  /** Per-bar meter. Falls back to the project time signature when absent. */
  timeSignature?: TimeSignature;
  /** Scale and meter belong to the bar, so every instrument shares them. */
  scale: Scale;
  /**
   * Per-instrument content, keyed by `Track.id`. A track with no key here simply
   * has nothing in this bar; the accessors in `@/engine/timeline` read that as
   * silence rather than requiring every bar to carry a key per track.
   */
  content: Record<string, TrackContent>;
}

// Project
export interface Project {
  id: string;
  name: string;
  bpm: number;
  timeSignature: TimeSignature;
  key: NoteName;
  keyMode: 'major' | 'minor';
  tracks: Track[];
  bars: Bar[];
  /**
   * Play range, in absolute beats from the start of the project. Absent means the
   * whole project plays; when present, playback is confined to it.
   */
  loopStart?: number;
  loopEnd?: number;
  /** When true, playback wraps to `loopStart` at `loopEnd` instead of stopping. */
  loopEnabled?: boolean;
  createdAt: Date;
  updatedAt: Date;
}
