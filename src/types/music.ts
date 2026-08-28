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
   * Semitones this note sits off the scale degree it names. Note segments only.
   *
   * The pitch alone cannot say which degree a note *means*: a raised seventh of D
   * dorian and its tonic are both MIDI 60, and without this the arrow keys would step
   * them to the same place. Absent means the note is the degree the scale spells,
   * which is every note written before formulas could name an accidental.
   */
  alter?: number;
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

/**
 * What a curve drives.
 *
 * Both kinds reach the plugin the same way, because in VST3 they *are* the same
 * thing: a MIDI controller has no stream of its own, and arrives as a parameter
 * change on whatever id the plugin names for it through `IMidiMapping`. The
 * difference is only which of them the plugin will tell you the name of.
 */
export type AutomationTarget =
  /** A parameter the plugin publishes, by its `ParamID`. */
  | { kind: 'param'; paramId: number }
  /**
   * A MIDI controller, 0-127.
   *
   * Stored as the controller number rather than the id it resolves to, because
   * the id belongs to this installed version of this plugin while the controller
   * is what the user bound — resolution happens natively, on the way in.
   *
   * No channel: the host emits every note on channel 0 and nothing can vary
   * that, so a controller on any other channel would arrive somewhere the notes
   * did not.
   */
  | { kind: 'cc'; controller: number };

/**
 * One target's curve over time.
 *
 * Values are the same 0-1 as every other level in this app, which is also VST3's
 * own normalised range — so a breakpoint travels from the lane to the plugin
 * unconverted.
 */
export interface ParameterAutomation {
  target: AutomationTarget;
  /**
   * What the lane calls itself.
   *
   * Stored rather than looked up so a lane still names itself when the plugin is
   * not installed on this machine, or before the native enumeration has come
   * back — the same reason the instrument picker keeps offering a ref it cannot
   * resolve rather than quietly replacing it. Seeded from the plugin's own title
   * for a parameter and from the controller number for a CC, and renameable
   * either way, since neither "Kontakt" nor "CC 20" says much later on.
   */
  name: string;
  points: AutomationPoint[];
}

/**
 * A named span of the arrangement: "Intro", "Verse", "Chorus".
 *
 * Positioned in absolute beats from the start of the project, like the play range
 * and unlike a chord segment — a section is a label written over the music rather
 * than material belonging to one measure, and it has to be able to cross bar lines.
 *
 * It owns nothing and sounds nothing. Deleting a section leaves every block where
 * it was; that is the whole point of it being a label.
 */
export interface Section {
  id: string;
  name: string;
  /** Beats from the start of the project. */
  startBeat: number;
  /** Exclusive: the beat the section stops at, always > startBeat. */
  endBeat: number;
  /** Absent means "assigned by index from SECTION_COLORS", as `Track.color` does. */
  color?: string;
}

/**
 * A named, collapsible bundle of instruments in the sidebar.
 *
 * It owns no music. Removing a group leaves every instrument exactly where it was
 * and playing exactly what it played; that is the whole point of it being a label.
 *
 * Its mute and solo are the one exception, and they are deliberately a *second*
 * pair of flags rather than a bulk edit of the members': silencing a group must
 * not overwrite which instruments the user had muted inside it, or ungrouping
 * would hand back a different mix than the one they built.
 *
 * Groups do not nest, and a group has no fader. One level of folder is what a
 * sidebar of a few dozen instruments needs; a tree is what a mixer needs.
 */
export interface TrackGroup {
  id: string;
  name: string;
  /** Folded away in the panel. Absent reads as expanded. */
  collapsed?: boolean;
  /** Silences every member, whatever each member's own `muted` says. */
  muted?: boolean;
  /** Puts every member into the project-wide solo set. */
  solo?: boolean;
  /** Absent means "assigned by index from TRACK_COLORS", as `Track.color` does. */
  color?: string;
}

// Track — one instrument in the arrangement.
export interface Track {
  id: string;
  name: string;
  /**
   * The group this instrument sits in, by `TrackGroup.id`. Absent means ungrouped,
   * which is what every instrument was before groups existed.
   *
   * Membership is stated here rather than as a list of ids on the group so that
   * there is only ever one array to keep in order — `Project.tracks` — and no way
   * for the two to disagree about where an instrument is.
   */
  groupId?: string;
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
  /**
   * The fader: the level this instrument plays at, and what every curve on it is
   * scaled by. Never overridden, so there is always one number the user can move.
   */
  volume: number;
  /**
   * Volume over time in absolute song beats — **derived**, like `Bar.content`.
   *
   * Recompiled by `compileAutomation` from the curves of the phrases placed on this
   * instrument, each shifted to where its clip sits and multiplied by `volume`
   * above. Never authored and never written to file: the curve belongs to the
   * phrase, which is the thing that gets placed, copied and played twice.
   *
   * Absent means nothing placed here is automated, which hands playback back to the
   * flat `volume`.
   */
  volumeAutomation?: AutomationPoint[];
  /**
   * Plugin parameter curves in absolute song beats, at most one per target —
   * **derived** from the placed phrases exactly as `volumeAutomation` above is.
   *
   * Absent or empty on every track that is not a plugin: a General MIDI or SFZ
   * sound has nothing to automate but its volume.
   *
   * Unlike `volumeAutomation` there is no flat fallback field beside it, and no
   * fader scaling it: a parameter with no curve is simply not driven, and keeps
   * whatever its preset or the plugin's own editor last set it to. There is no
   * value the app could put there that would not be an invention.
   */
  parameterAutomation?: ParameterAutomation[];
  /**
   * The target the touchpad performs on this instrument, live.
   *
   * Absent means the touchpad does nothing here, which is every instrument nobody has
   * assigned one on. Stored per instrument rather than once for the app because it is
   * a property of the *sound*: a harp's glissando is CC 11, a string library's
   * dynamics are CC 1, and switching instrument should switch what the finger drives
   * without anything being reassigned.
   *
   * Authored, unlike the two curves above: this is a setting, not something compiled
   * out of the placed phrases. What the gesture *writes* is an ordinary lane on the
   * phrase, named by `laneKey` from this same target.
   */
  touchpadTarget?: AutomationTarget;
  pan: number;
  /**
   * Nudge this instrument off the beat, in milliseconds. Negative sounds it
   * earlier, positive later. Absent reads as 0, which is where every instrument
   * sat before offsets existed.
   *
   * The cure for an instrument that does not sound when it is told to. A plugin
   * with a slow sampled attack, a legato patch, or one running its own lookahead
   * arrives late by an amount it never declares, and a hosted VST3 is late again by
   * the difference in output buffering between its stream and the webview's — see
   * the header of `src-tauri/src/vst3/clock.rs`. None of that is measurable from
   * here, so the number is set by ear, exactly as a DAW's track delay is.
   *
   * Authored rather than derived, like `touchpadTarget` above: a property of the
   * sound this instrument makes, not something compiled out of the placed phrases.
   * It moves when the notes sound, never where they are written — the roll, the
   * playhead and the exported beat positions all stay put.
   */
  timeOffsetMs?: number;
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

/**
 * A named, reusable block of one instrument's material.
 *
 * The first thing in this app that *owns* music and is instanced. `Section` and
 * `TrackGroup` are the near neighbours in shape, and both go out of their way to say
 * they own nothing; a phrase is the opposite, and everything it owns lives in its own
 * local `bars`, indexed from zero. That locality is the whole trick: the same phrase
 * can be placed at bar 1 and again at bar 17 without either placement knowing the
 * other exists, because neither position is written down inside it.
 *
 * Its content is filed under `PHRASE_TRACK_KEY` rather than under a track id. A phrase
 * names chords and notes, not a sound, and that is what lets a block be dragged off the
 * piano's row onto the strings' row and simply be played by the strings.
 *
 * `Bar.timeSignature` is unused inside a phrase: metre belongs to the song's bars, so
 * every instrument shares it (see `Bar.timeSignature` above). A phrase that carried its
 * own metre could not honestly be placed at two positions whose metres differ.
 */
export interface Phrase {
  id: string;
  name: string;
  /** Absent means "assigned by index from TRACK_COLORS", as `Track.color` does. */
  color?: string;
  /** Local bars, `barIndex` running 0..n-1. Content keyed by `PHRASE_TRACK_KEY`. */
  bars: Bar[];
  /**
   * Volume over the phrase, in beats from its own bar 0: breakpoints with linear
   * ramps between them, sorted, with no two on the same beat.
   *
   * A *shape*, not a level — 1 is "as loud as the instrument's fader", 0 silence —
   * which is what lets the same swell be played by the piano at one level and the
   * strings at another. `compileAutomation` multiplies it by `Track.volume` and
   * shifts it to each placement, so a phrase placed three times swells three times.
   *
   * Absent or empty means the placement plays flat at the fader, which is what every
   * phrase written before curves lived here does.
   */
  volumeAutomation?: AutomationPoint[];
  /**
   * Plugin parameter curves over the phrase, on the same local beat axis.
   *
   * A target is named by controller number or parameter id rather than by plugin, so
   * a lane survives the phrase being dragged onto another instrument — it simply
   * drives that instrument's plugin instead, or nothing at all when it has none.
   */
  parameterAutomation?: ParameterAutomation[];
}

/**
 * One placement of a phrase: which instrument plays it, and from which bar.
 *
 * Positioned in whole bars, unlike `Section`, which is drawn across the music in
 * absolute beats. A phrase *is* a run of bars, so a placement starting mid-bar would
 * leave its first segment with no bar to live in.
 *
 * Carries no length of its own. The length is the phrase's, and a clip able to disagree
 * with its phrase about how long it is would be a second truth to keep in step.
 */
export interface PhraseClip {
  id: string;
  phraseId: string;
  /** The instrument that plays it, by `Track.id`. */
  trackId: string;
  /** Index into `Project.bars` where the phrase's local bar 0 lands. */
  startBar: number;
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
  /**
   * The sidebar's groups, in the order they are shown.
   *
   * Absent or empty in every project written before groups existed, which is
   * exactly what an ungrouped sidebar means.
   *
   * A group's *members* are not listed here: they are the run of `tracks` carrying
   * its id, which the panel and every writer keep contiguous. So this array orders
   * the groups relative to each other only — and matters on its own solely for a
   * group with no members yet, which `tracks` cannot place.
   */
  trackGroups?: TrackGroup[];
  /**
   * Every phrase the project knows, placed or not.
   *
   * This is where all music lives from schema 1.17 on. A phrase with no clip is not
   * a leak: it is an idea in the library, waiting to be dragged onto a row, and
   * deleting its last placement should remove a placement rather than destroy it.
   *
   * Required rather than optional, unlike `sections` and `trackGroups`. Its *absence*
   * is the shape `deserializeProject` migrates a pre-1.17 file on, so an empty array
   * and a missing key have to stay distinguishable.
   */
  phrases: Phrase[];
  /** Where each phrase is played, and by which instrument. Normalised, never overlapping. */
  clips: PhraseClip[];
  /**
   * The song's bar grid.
   *
   * `id`, `barIndex` and `timeSignature` are authored. `content` is **derived** —
   * recompiled from `clips` by `compileBars` after every edit and never written to
   * file, exactly like `TrackContent.notes` one level down. Nothing outside
   * `projectStore` should write it, and nothing at all should author it: an edit
   * belongs in the phrase the clip points at.
   */
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
  /**
   * Named spans over the arrangement, sorted by start and never overlapping.
   *
   * Absent or empty in every project written before sections existed, which is
   * exactly what an unlabelled timeline means. Gaps between them are allowed:
   * music nobody has named yet is a normal state, not a hole to fill.
   */
  sections?: Section[];
  createdAt: Date;
  updatedAt: Date;
}
