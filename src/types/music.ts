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

/**
 * What a timeline segment represents: a single note, or a stacked chord.
 *
 * Both are *named* material — a pitch, or a harmony with a root and a quality —
 * which is why they can be transposed by degree and re-voiced. A live performance
 * needs nothing further: sub-lanes let a played chord be the three overlapping note
 * blocks it actually is, rather than one opaque block that names nothing.
 */
export type SegmentKind = 'note' | 'chord';

/** How a chord's tones are spread across registers. Absent reads as 'close'. */
export type SpacingPreset = 'close' | 'open' | 'drop2' | 'drop3';

/** Order an arpeggio walks its pitches in. */
export type ArpeggioPattern = 'up' | 'down' | 'upDown' | 'asPlayed';

/** One chord tone duplicated an octave away. `tone` indexes the root-position chord. */
export interface ToneDoubling {
  tone: number;
  octaves: 1 | -1;
}

/**
 * How a chord's notes are spread in *time*. Arpeggio and strum are alternatives,
 * not layers — a strum inside an arpeggio would stagger one note against nothing —
 * so they are one field with a mode rather than two independent ones.
 */
export type SegmentBreak =
  | {
      mode: 'arpeggio';
      pattern: ArpeggioPattern;
      /** Fraction of a step each note sounds for; absent reads as 1 (legato). */
      gate?: number;
    }
  | {
      mode: 'strum';
      /**
       * Onset stagger between adjacent tones, in beats. Beats rather than
       * milliseconds so that generating notes never needs to know the tempo — a
       * strum scales with the music instead of the notes going stale on a bpm change.
       */
      spreadBeats: number;
      direction: 'up' | 'down';
    };

/**
 * A chord segment's voicing. Absent everywhere means the block voicing this app
 * produced before voicings existed, so every pre-1.6 project sounds identical.
 */
export interface SegmentVoicing {
  /** Which preset seeded `offsets`; absent once the user hand-tweaks one. */
  spacing?: SpacingPreset;
  /**
   * Per-chord-tone octave offsets, indexed like `CHORD_INTERVALS[quality]`:
   * 0 = root, 1 = third, 2 = fifth, 3 = seventh. Wins over `spacing` when present.
   *
   * Keyed by chord tone rather than by sounding position so a hand-tweaked voicing
   * survives a change of inversion — the third stays the third.
   */
  offsets?: number[];
  doublings?: ToneDoubling[];
  break?: SegmentBreak;
}

// Chord segment in a bar
export interface ChordSegment {
  id: string;
  /**
   * Beats from the start of the containing bar. Absent in projects written before
   * free placement, where position was implied by packing segments end to end;
   * `withStartBeats` fills those in on load.
   */
  startBeat?: number;
  /**
   * Which of its instrument's stacked sub-lanes this block sits in.
   *
   * Blocks may not overlap *within a lane*, and that is the only reason a lane
   * exists: material that merely follows on shares lane 0, and a second lane is
   * needed only when two blocks have to sound at the same time. Absent reads as 0,
   * which is every project written before sub-lanes — a single lane per instrument.
   */
  lane?: number;
  /** Defaults to 'chord' when absent, so pre-existing projects keep working. */
  kind?: SegmentKind;
  /** MIDI pitch — only meaningful when kind === 'note'. */
  pitch?: number;
  /**
   * MIDI velocity for everything this block sounds, 0-127. Absent reads as 100 —
   * the fixed velocity every note carried before recording could capture one — so
   * projects written before this sound identical.
   */
  velocity?: number;
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
  /**
   * The key this block was written in — the scale its `romanNumeral` names a degree
   * of, and the one a change of key retunes it away from.
   *
   * Distinct from `root` above, which is the *chord's* root: a ii chord in C major
   * has `root: 'D'` and `scale: { root: 'C', type: 'major' }`.
   *
   * Absent in projects written before the key moved off the bar, and read as the
   * project's own key. Loading such a project pushes the bar's key down onto its
   * segments, so the fallback only ever covers a hand-edited file.
   */
  scale?: Scale;
  /**
   * Voicing and articulation. Chord segments only — a note segment has one pitch
   * and nothing to space, double or break. Absent means the plain block chord,
   * which is what every chord sounded like before voicings existed.
   */
  voicing?: SegmentVoicing;
}

// Individual note
export interface Note {
  id: string;
  pitch: number;
  startBeat: number;
  duration: number;
  velocity: number;
}

/**
 * One breakpoint in a parameter's curve over time.
 *
 * Positioned in absolute beats rather than within a bar, like the play range and
 * unlike a chord segment: a ramp is a shape drawn across the music rather than
 * material belonging to one measure, and it has to be able to cross a bar line.
 */
export interface AutomationPoint {
  /** Beats from the start of the project. */
  beat: number;
  /** Level, 0-1, on the same scale as `Track.volume`. */
  value: number;
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
  /**
   * How many stacked sub-lanes this instrument shows on the timeline.
   *
   * Absent reads as 1 — the single lane every instrument had before sub-lanes, so
   * existing projects look exactly as they did. It only ever grows on its own, when
   * a recording needs somewhere to put a simultaneous note; emptying a lane does not
   * take it away again, so the strip's height never changes under the cursor.
   */
  laneCount?: number;
  volume: number;
  /**
   * Volume over time: breakpoints with linear ramps between them, sorted by beat
   * and with no two on the same beat.
   *
   * Absent or empty means the flat `volume` above; one point or more overrides it
   * entirely, so there is only ever one number in the audio path and no write/read
   * mode to explain. Absent in every project written before automation existed.
   */
  volumeAutomation?: AutomationPoint[];
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
  /**
   * A VST3 plugin's own state — its preset — base64'd.
   *
   * Opaque: only the plugin that produced it can read it. Absent on every
   * General MIDI track, and on a plugin track whose plugin has not been asked
   * for its state yet, which reads as "however the plugin starts up".
   */
  vst3State?: string;
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
  /**
   * Per-bar meter. Falls back to the project time signature when absent.
   *
   * Meter belongs to the bar, so every instrument shares it. Key does not: it
   * lives on each segment, so two blocks in one bar can be in different keys.
   */
  timeSignature?: TimeSignature;
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
  /** When true, a click track accompanies playback. */
  metronomeEnabled?: boolean;
  createdAt: Date;
  updatedAt: Date;
}
