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

// Track
export interface Track {
  id: string;
  name: string;
  instrument: string;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
}

// Bar (measure)
export interface Bar {
  id: string;
  barIndex: number;
  /** Per-bar meter. Falls back to the project time signature when absent. */
  timeSignature?: TimeSignature;
  scale: Scale;
  chords: ChordSegment[];
  notes: Note[];
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
