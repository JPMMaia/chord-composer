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
  | 'dim7';

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

// Chord segment in a bar
export interface ChordSegment {
  id: string;
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
  createdAt: Date;
  updatedAt: Date;
}
