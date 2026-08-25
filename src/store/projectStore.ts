import { create } from 'zustand';
import type {
  AutomationPoint,
  Bar,
  ChordSegment,
  NoteName,
  AutomationTarget,
  ParameterAutomation,
  Project,
  Scale,
  Section,
  SegmentBreak,
  SpacingPreset,
  TimeSignature,
  Phrase,
  PhraseClip,
  Track,
  TrackGroup,
} from '@/types/music';
import type { CopiedSegment } from './clipboardStore';
import { clearLocalStorage } from '@/engine/fileIO';
import { generateId } from '@/utils/id';
import {
  movePoint,
  normalizePoints,
  samePoints,
  withPoint,
  withoutPoint,
} from '@/engine/volumeAutomation';
import {
  laneKey,
  normalizeParameterAutomation,
  sameLanes,
  withLane,
  withLaneName,
  withLanePoints,
  withoutLane,
} from '@/engine/parameterAutomation';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { nextSectionName, normalizeSections, sectionColorAt } from '@/engine/sections';
import {
  PHRASE_TRACK_KEY,
  canPlaceClip,
  clipEndBar,
  clonePhrase,
  compileAutomation,
  compileBars,
  createPhrase,
  insertPhraseBars,
  nextPhraseName,
  phraseById,
  phraseBarsForDisplay,
  phraseColorAt,
  relocateOverlaps,
  removePhraseBar,
  removePhraseBars,
  resizePhrase,
  uniquePhraseName,
  validClips,
} from '@/engine/phrases';
import {
  moveGroup as moveGroupInTracks,
  moveTrack as moveTrackInTracks,
  normalizeTrackOrder,
} from '@/engine/trackGroups';
import {
  barChords,
  clampStartToBar,
  clearRange,
  extendBarsToBeat,
  flattenSegments,
  getBarIndexAtBeat,
  getBarBeats,
  getBarStartBeat,
  getTotalBeats,
  isValidTimeSignature,
  mapBarChords,
  MIN_SEGMENT_BEATS,
  laneOf,
  placeSegmentInBar,
  refitBars,
  removeSegmentById,
  resizeSegment,
  resolveBeatPosition,
  trackLaneCount,
  withStartBeats,
} from '@/engine/timeline';
import {
  alterSegment,
  convertSegmentKind,
  cycleSegmentInversion,
  generateNotesFromSegments,
  retuneSegmentsToScale,
  shiftSegmentOctave,
  stepSegmentInScale,
} from '@/engine/chordOperations';
import {
  withBreak,
  withInversion,
  withoutVoicing,
  withSpacing,
  withToggledDoubling,
  withToneOffset,
  withVelocity,
} from '@/engine/voicing';
import { projectScale, segmentScale } from '@/engine/scales';
import {
  DEFAULT_BPM,
  DEFAULT_TIME_SIGNATURE,
  DEFAULT_KEY,
  DEFAULT_KEY_MODE,
  trackColorAt,
} from '@/utils/constants';
import { DEFAULT_INSTRUMENT_ID } from '@/engine/instrumentCatalog';
import type { TemplateInstrument } from '@/engine/instrumentTemplate';

/** Gate set by App.tsx to silence middleware pushState during recording takes. */
let recordingGate: ((active: boolean) => void) | undefined;

/** Call from App.tsx to bridge the middleware's setRecording into the store. */
export function setRecordingGate(fn: (active: boolean) => void) {
  recordingGate = fn;
}

/**
 * One block's destination in a batch move, as beats from the start of the project.
 *
 * Absolute rather than bar-relative because a move is a move along the timeline: bars
 * are a view of that line, and which one a block ends up in follows from where it
 * lands rather than being chosen up front. That is what lets a selection be dragged
 * across a bar line one grid step at a time instead of a bar at a time.
 */
export interface SegmentMove {
  segmentId: string;
  absoluteBeat: number;
  /** Sub-lane to land in. Absent keeps the lane the block is already in. */
  lane?: number;
}

interface ProjectState {
  project: Project | null;
  createProject: () => void;
  loadProject: (project: Project) => void;
  setBpm: (bpm: number) => void;
  setTimeSignature: (ts: TimeSignature) => void;
  setKey: (key: NoteName, mode?: 'major' | 'minor') => void;
  addBar: () => void;
  insertBar: (index: number, count: number) => void;
  removeBar: (barId: string) => void;
  /** Take a run of song bars away, closing the placements up behind them. */
  removeBars: (index: number, count: number) => void;
  setSegmentsScale: (segmentIds: string[], patch: Partial<Scale>) => void;
  setBarTimeSignature: (barId: string, ts: TimeSignature) => void;
  insertSegment: (
    barId: string,
    startBeat: number,
    segment: ChordSegment,
    trackId: string
  ) => void;
  recordSegment: (
    trackId: string,
    startBeat: number,
    segment: ChordSegment,
    onCommit?: (project: Project) => void
  ) => void;
  removeSegment: (segmentId: string) => void;
  removeSegments: (segmentIds: string[]) => void;
  moveSegments: (moves: SegmentMove[]) => void;
  /**
   * How many stacked sub-lanes an instrument shows.
   *
   * Refuses to shrink over a lane that still holds blocks — a lane is removed by
   * emptying it first, not by having its contents silently rehomed.
   */
  setTrackLaneCount: (trackId: string, count: number) => void;
  /** `snapBeats` is the editor's current grid; the caller owns it, the store does not. */
  resizeSegmentDuration: (segmentId: string, duration: number, snapBeats: number) => void;
  // Instruments. Tracks live here rather than in a store of their own so they
  // ride along with undo, autosave and project load like everything else.
  /** Returns the new instrument's id, so the caller can select it. */
  addTrack: (name?: string) => string | null;
  /**
   * Add a saved instrument set alongside the ones already here.
   *
   * Append rather than replace: a template is a starting point, not a project, and
   * removing instruments would take their music with them. Every appended instrument
   * gets a fresh id, so loading a template captured from this same project produces
   * copies rather than collisions.
   *
   * @returns the first new instrument's id, or null when there was nothing to add.
   */
  appendInstruments: (instruments: TemplateInstrument[]) => string | null;
  removeTrack: (trackId: string) => void;
  renameTrack: (trackId: string, name: string) => void;
  setTrackInstrument: (trackId: string, instrument: string) => void;
  setTrackVolume: (trackId: string, volume: number) => void;
  /**
   * Point the touchpad at one of an instrument's targets, or at nothing.
   *
   * Null rather than an absent argument for clearing it, so unassigning is something
   * the caller states rather than something it omits.
   */
  setTrackTouchpadTarget: (trackId: string, target: AutomationTarget | null) => void;
  // Volume over a *phrase*, which is what owns its curves: positions are beats from
  // the phrase's own bar 0, and levels are 0-1 relative to the instrument's fader.
  // Both are clamped rather than rejected, because these come from a drag in the lane
  // where going past an edge is the gesture, not a bad argument.
  addVolumePoint: (phraseId: string, beat: number, value: number) => void;
  moveVolumePoint: (phraseId: string, index: number, beat: number, value: number) => void;
  removeVolumePoint: (phraseId: string, index: number) => void;
  clearVolumeAutomation: (phraseId: string) => void;
  // Plugin targets over the phrase, on the same local beat axis and the same 0-1
  // scale as the volume curve — which is also VST3's normalised range, so a
  // breakpoint reaches a plugin unconverted. Only `addLane` needs the target
  // itself; every later edit names the lane by its key, which is what the
  // timeline and the selection already hold.
  addLane: (phraseId: string, target: AutomationTarget, name: string) => void;
  removeLane: (phraseId: string, key: string) => void;
  renameLane: (phraseId: string, key: string, name: string) => void;
  addLanePoint: (phraseId: string, key: string, beat: number, value: number) => void;
  moveLanePoint: (
    phraseId: string,
    key: string,
    index: number,
    beat: number,
    value: number
  ) => void;
  removeLanePoint: (phraseId: string, key: string, index: number) => void;
  /**
   * Append a performed run of breakpoints to one lane, creating the lane if the
   * target has none yet.
   *
   * Batched rather than one call per point because a gesture on the touchpad produces
   * samples at pointer rate, and every write here recompiles the arrangement — a
   * point at a time would put `compileAutomation` over the whole project in the path
   * of every pointer event. The recorder buffers and flushes; this is what it flushes
   * into.
   *
   * Creating the lane is part of the action rather than the caller's job so that a
   * take cannot half-happen: there is no moment at which a lane exists holding none
   * of the gesture that made it.
   */
  recordLanePoints: (phraseId: string, target: AutomationTarget, name: string, points: AutomationPoint[]) => void;
  setTrackPan: (trackId: string, pan: number) => void;
  toggleTrackMute: (trackId: string) => void;
  toggleTrackSolo: (trackId: string) => void;
  toggleTrackVisible: (trackId: string) => void;
  stepSegmentPitch: (segmentId: string, direction: -1 | 1) => void;
  shiftSegmentOctave: (segmentId: string, direction: -1 | 1) => void;
  cycleSegmentInversion: (segmentId: string) => void;
  stepSegmentsPitch: (segmentIds: string[], direction: -1 | 1) => void;
  shiftSegmentsOctave: (segmentIds: string[], direction: -1 | 1) => void;
  cycleSegmentsInversion: (segmentIds: string[]) => void;
  setSegmentInversion: (segmentId: string, inversion: number) => void;
  setSegmentSpacing: (segmentId: string, preset: SpacingPreset) => void;
  setSegmentToneOffset: (segmentId: string, tone: number, offsetOctaves: number) => void;
  toggleSegmentDoubling: (segmentId: string, tone: number, octaves: 1 | -1) => void;
  setSegmentBreak: (segmentId: string, spec: SegmentBreak | null) => void;
  setSegmentVelocity: (segmentId: string, velocity: number) => void;
  clearSegmentVoicing: (segmentId: string) => void;
  setSegmentsInversion: (segmentIds: string[], inversion: number) => void;
  setSegmentsSpacing: (segmentIds: string[], preset: SpacingPreset) => void;
  setSegmentsToneOffset: (segmentIds: string[], tone: number, offsetOctaves: number) => void;
  toggleSegmentsDoubling: (segmentIds: string[], tone: number, octaves: 1 | -1) => void;
  setSegmentsBreak: (segmentIds: string[], spec: SegmentBreak | null) => void;
  /**
   * How hard every named segment sounds, 1-127.
   *
   * Unlike the voicing edits above this applies to every kind: a note carries a
   * velocity just as a chord does.
   */
  setSegmentsVelocity: (segmentIds: string[], velocity: number) => void;
  /**
   * Raise or flatten each note against the degree it names, in semitones.
   *
   * Note segments only: a chord names a stack of degrees, so there is no one note in
   * it an accidental could belong to.
   */
  setSegmentsAlter: (segmentIds: string[], alter: number) => void;
  clearSegmentsVoicing: (segmentIds: string[]) => void;
  convertSegmentsKind: (
    segmentIds: string[],
    target: import('@/engine/chordOperations').SegmentKindTarget
  ) => void;
  setLoopRegion: (start: number | null, end: number | null) => void;
  /**
   * Draw a named span over the arrangement. Returns its id, so the caller can select
   * it and open its name for editing; null when nothing was added.
   */
  addSection: (startBeat: number, endBeat: number, name?: string) => string | null;
  renameSection: (sectionId: string, name: string) => void;
  setSectionRange: (sectionId: string, startBeat: number, endBeat: number) => void;
  setSectionColor: (sectionId: string, color: string) => void;
  removeSection: (sectionId: string) => void;
  /** Clone an instrument and all its chord segments. Returns the new instrument's id. */
  duplicateTrack: (sourceTrackId: string) => string | null;

  // -- Instrument groups -----------------------------------------------------
  /**
   * Add an empty group to the end of the sidebar. Returns its id so the caller can
   * open its name for editing, as `addSection` does.
   */
  addTrackGroup: (name?: string) => string | null;
  /**
   * Remove a group. Its instruments stay exactly where they are, ungrouped — a
   * group is a label, and removing a label must never remove what it labelled.
   */
  removeTrackGroup: (groupId: string) => void;
  renameTrackGroup: (groupId: string, name: string) => void;
  setTrackGroupColor: (groupId: string, color: string) => void;
  toggleTrackGroupCollapsed: (groupId: string) => void;
  toggleTrackGroupMute: (groupId: string) => void;
  toggleTrackGroupSolo: (groupId: string) => void;
  /**
   * Move an instrument into a group and to a position within it.
   *
   * `groupId` null means ungrouped; `beforeTrackId` null means the end of the
   * target group, or the end of the sidebar when both are null.
   */
  moveTrack: (
    trackId: string,
    groupId: string | null,
    beforeTrackId: string | null
  ) => void;
  /** Move a whole group before another, or to the end when `beforeGroupId` is null. */
  moveTrackGroup: (groupId: string, beforeGroupId: string | null) => void;
  /**
   * Paste clipboard segments into the project.
   *
   * @param segments — the clipboard payload (from clipboardStore).
   * @param trackId — the target instrument.
   * @param offsetBarIndex — bar index to start pasting into.
   * @param targetStartBeat — beat offset within the target bar where the
   *   left edge of the first pasted segment should land (from the mouse cursor).
   * @returns the ids of pasted segments, or null if nothing was pasted.
   */
  pasteSegments: (
    segments: CopiedSegment[],
    trackId: string,
    offsetBarIndex: number,
    targetStartBeat?: number
  ) => string[] | null;
  toggleLoopEnabled: () => void;
  toggleMetronome: () => void;
  resetProject: () => void;
  /** Execute `fn` while recording mode is active — pushState is silenced. */
  withRecording: (fn: () => void) => void;

  // -------------------------------------------------------------------------
  // Phrases and their placements
  // -------------------------------------------------------------------------

  /**
   * The phrase the timeline is currently editing, or null in the arrangement view.
   *
   * Not view state, despite reading like it: it is *which sub-tree of the document the
   * segment actions address*, so it belongs beside the document rather than in
   * `editorStore`. Kept out of `project` so that it neither lands on the undo stack —
   * which snapshots `state.project` — nor ever reaches a file.
   */
  editingPhraseId: string | null;

  /**
   * Which placement of it was opened, or null when none can be named.
   *
   * A phrase says what the editor edits; the placement says *where in the song* that
   * editing can be heard, which is what the phrase editor's audition plays. Held for
   * the same reasons as `editingPhraseId` and treated the same way: ephemeral, off the
   * undo stack, out of the file. Readers fall back to the phrase's first placement, so
   * an id left behind by an undo still resolves to somewhere sensible.
   */
  editingClipId: string | null;
  /** Open a placement for editing, and select the instrument that plays it. */
  openClip: (clipId: string) => void;
  /** Open a phrase for editing directly, e.g. an unplaced one from the library. */
  openPhrase: (phraseId: string) => void;
  closePhrase: () => void;

  /** Create a phrase and place it. Returns the new clip's id. */
  addPhraseClip: (trackId: string, startBar: number, lengthBars: number) => string | null;
  /** Place an existing phrase again — a *linked* placement, sharing its content. */
  placePhrase: (phraseId: string, trackId: string, startBar: number) => string | null;
  /** Place a second block playing the same phrase — an edit to either reaches both. */
  linkClip: (clipId: string, trackId: string, startBar: number) => string | null;
  /** Copy a placement *and* its phrase, so the copy can be edited alone. */
  duplicateClip: (clipId: string, trackId: string, startBar: number) => string | null;
  /** Give a placement a private copy of its phrase, so editing it moves nothing else. */
  makeClipUnique: (clipId: string) => void;
  moveClip: (clipId: string, trackId: string, startBar: number) => void;
  removeClip: (clipId: string) => void;
  renamePhrase: (phraseId: string, name: string) => void;
  setPhraseColor: (phraseId: string, color: string) => void;
  setPhraseLength: (phraseId: string, lengthBars: number) => void;
  /** Open empty bars up inside a phrase, pushing the bars from there on along. */
  insertPhraseBarsAt: (phraseId: string, index: number, count: number) => void;
  /** Take one bar out of a phrase, closing the bars after it up behind it. */
  removePhraseBarAt: (phraseId: string, barId: string) => void;
  /** The same by position and length — what the phrase ruler's menu removes. */
  removePhraseBarsAt: (phraseId: string, index: number, count: number) => void;
  /** Remove a phrase and every placement of it. */
  removePhrase: (phraseId: string) => void;
}

/**
 * Point the editor's instrument at the row a phrase was opened from.
 *
 * A one-way call into `selectionStore`, which imports nothing and so cannot import
 * back. Opening a placement has to move the selection: a phrase names no instrument,
 * so without this the editor would audition, record and colour its blocks as whatever
 * row happened to be selected last.
 */
function selectTrackForPhrase(trackId: string): void {
  selectionStore.getState().selectTrack(trackId);
}

/**
 * Show the surface that matches what is now open.
 *
 * The other one-way call out of this store, for the same reason as the one above:
 * `editingPhraseId` says which sub-tree the segment actions address, and the centre
 * column has to be showing that sub-tree or opening a block would appear to do
 * nothing. `editorStore` imports nothing from here, so the arrow only points one way.
 */
function showView(view: 'arrangement' | 'phrase'): void {
  editorStore.getState().setView(view);
}

/** Octave the generated chord roots sit in — the middle-C octave. */
const GENERATED_NOTE_OCTAVE = 4;

/**
 * The key a segment falls back to when it carries none of its own.
 *
 * Only reached by segments written before key moved off the bar and never loaded
 * through `fileIO`, which migrates them — but every note-generating path needs an
 * answer, so it is spelled out once here rather than defaulted per caller.
 */
function keyScale(project: Project): Scale {
  return projectScale(project.key, project.keyMode);
}

/**
 * Regenerate every instrument's notes in every bar from its segments.
 *
 * A track's notes are derived state: this is what keeps the piano roll in step with
 * the chord panel. Running it over all bars rather than only the edited one is what
 * makes overflow correct — a segment pushed across a bar line changes two bars at
 * once — and over all instruments because a refit can move any of them.
 */
function withGeneratedNotes(
  bars: Bar[],
  projectTs: TimeSignature,
  fallbackScale: Scale
): Bar[] {
  return bars.map(bar => ({
    ...bar,
    content: Object.fromEntries(
      Object.entries(bar.content).map(([trackId, content]) => [
        trackId,
        {
          chords: content.chords,
          notes: generateNotesFromSegments(
            content.chords,
            bar,
            fallbackScale,
            projectTs,
            GENERATED_NOTE_OCTAVE
          ),
        },
      ])
    ),
  }));
}

/**
 * Rebuild the project from a set of bars: refit them so every segment sits inside
 * its bar without overlapping, then resync the derived notes. Every segment mutation
 * funnels through here so no caller can skip either step.
 *
 * The refit is handed the project's track ids, not just the ids with content, so an
 * instrument that has been emptied still gets its (empty) lists rebuilt rather than
 * keeping stale ones.
 */
/**
 * The bars the segment actions address: the open phrase's, or null when none is open.
 *
 * The bars are handed back carrying the metre of the song bars the phrase's first
 * placement covers (see `phraseBarsForDisplay`). That matters for more than looks: a
 * bar's metre is its *capacity*, so a refit run against metre-less phrase bars would
 * let four beats into a bar the user is being shown as three.
 *
 * A phrase's content is filed under `PHRASE_TRACK_KEY` rather than under the id of the
 * instrument playing it, which is what lets a placement be dragged to another row
 * without rewriting a thing. So the `trackId` the segment actions take is no longer
 * where content goes — it is only used to check the instrument exists, and to reach
 * its lane count.
 */
function surfaceOf(
  project: Project,
  editingPhraseId: string | null
): { phrase: Phrase; bars: Bar[] } | null {
  if (!editingPhraseId) return null;
  const phrase = phraseById(project.phrases, editingPhraseId);
  if (!phrase) return null;
  return { phrase, bars: phraseBarsForDisplay(phrase, project) };
}

/**
 * Rebuild the project from a set of *phrase* bars: refit them so every segment sits
 * inside its bar without overlapping, resync the derived notes, then recompile the
 * song from every placement. Every segment mutation funnels through here, so no caller
 * can skip a step.
 *
 * The refit is scoped to `PHRASE_TRACK_KEY` — a phrase holds one part, and there is no
 * other instrument in it for a ripple to disturb. It may append bars when a block
 * spills off the end, which lengthens the phrase itself and so every placement of it at
 * once; `relocateOverlaps` then makes room on the rows that needed it.
 *
 * The borrowed display metre is stripped on the way back in. Metre belongs to the song's
 * bars, and a phrase that kept a copy would be a second opinion about the bar the user
 * is hearing.
 */
function applyPhraseBars(project: Project, phraseId: string, bars: Bar[]): Project {
  const refitted = refitBars(bars, project.timeSignature, [PHRASE_TRACK_KEY]);
  const withNotes = withGeneratedNotes(refitted, project.timeSignature, keyScale(project));

  const phrases = project.phrases.map(p =>
    p.id === phraseId
      ? {
          ...p,
          bars: withNotes.map((bar, i) => ({ ...bar, barIndex: i, timeSignature: undefined })),
        }
      : p
  );

  return recompiled({ ...project, phrases });
}

/**
 * Resettle the placements and rebuild `project.bars` from them.
 *
 * The single exit every phrase and clip mutation takes, so the compiled timeline that
 * playback and the piano roll read is never one edit behind what the arrangement shows.
 */
function recompiled(project: Project): Project {
  // `relocateOverlaps` rather than `normalizeClips` here, and the order matters: an
  // overlap at this point is one an edit just created — a phrase grown under a
  // neighbour — so the neighbour is pushed along rather than deleted. Dropping is the
  // file reader's rule, for overlaps that were already wrong when they arrived.
  const clips = relocateOverlaps(
    validClips(project.clips, project.phrases, project.tracks),
    project.phrases
  );
  const bars = compileBars(project.bars, project.phrases, clips);
  return {
    ...project,
    clips,
    bars,
    // The curves are derived from the placements exactly as the bars' content is, so
    // they are rebuilt on the same beat — a phrase moved a bar to the right takes its
    // swell with it, with nothing else to keep in step.
    tracks: compileAutomation(project.tracks, bars, project.phrases, clips, project.timeSignature),
    updatedAt: new Date(),
  };
}

/**
 * Rebuild the project from a set of *song* bars — the grid itself, not its contents.
 *
 * Only the handful of actions that author the grid reach this: adding, inserting and
 * removing bars, and changing a bar's metre. Whatever content the caller left on those
 * bars is discarded and recompiled from the placements, since `Bar.content` is derived.
 */
function applyGrid(project: Project, bars: Bar[]): Project {
  return recompiled({ ...project, bars });
}

/**
 * Rewrite one instrument's segments in one bar, leaving every other bar and every
 * other instrument alone. The refit that follows still sees the whole project, so a
 * change here can still spill into later bars.
 */
function mapBar(
  bars: Bar[],
  barId: string,
  trackId: string,
  fn: (chords: ChordSegment[]) => ChordSegment[]
): Bar[] {
  return bars.map(bar => (bar.id === barId ? mapBarChords(bar, trackId, fn) : bar));
}

/**
 * Drop `segment` into a bar at `startBeat`, rippling whatever it lands on.
 *
 * Only the onset is held inside the bar; the block's tail, and any neighbour the
 * ripple pushes past the bar line, are left where the arithmetic put them for the
 * refit that follows to re-home.
 */
function placedIn(
  chords: ChordSegment[],
  segment: ChordSegment,
  startBeat: number,
  capacity: number
) {
  return placeSegmentInBar(chords, segment, clampStartToBar(startBeat, capacity));
}

/**
 * Rewrite segments in place, leaving where they sit alone.
 *
 * Each transform is handed the key that segment is written in, which is what lets
 * "the next note of the scale" mean the right thing when a multi-selection spans
 * blocks in different keys. Only the derived notes are
 * resynced: none of these edits moves a block along the timeline, so unlike
 * `applyBars` there is nothing here for `refitBars` to refit.
 *
 * The whole selection is rewritten in one pass so a keypress is one visual step
 * and one history entry rather than one per block.
 *
 * Returns null when no bar holds any of the segments, so the caller can leave the
 * store untouched rather than publishing an identical project.
 */
function withTransformedSegments(
  project: Project,
  phrase: Phrase,
  segmentIds: string[],
  transform: (segment: ChordSegment, scale: Scale) => ChordSegment
): Project | null {
  const targets = new Set(segmentIds);
  if (targets.size === 0) return null;

  let matched = false;
  const bars = phrase.bars.map(bar => {
    const content = Object.entries(bar.content);
    if (!content.some(([, c]) => c.chords.some(s => targets.has(s.id)))) return bar;
    matched = true;
    return {
      ...bar,
      content: Object.fromEntries(
        content.map(([key, trackContent]) => [
          key,
          {
            ...trackContent,
            chords: trackContent.chords.map(c =>
              targets.has(c.id) ? transform(c, segmentScale(c, keyScale(project))) : c
            ),
          },
        ])
      ),
    };
  });

  if (!matched) return null;

  const phrases = project.phrases.map(p =>
    p.id === phrase.id
      ? { ...p, bars: withGeneratedNotes(bars, project.timeSignature, keyScale(project)) }
      : p
  );
  return recompiled({ ...project, phrases });
}

/**
 * Run a transform over the open phrase's selection, or do nothing if no phrase is open.
 *
 * The fourteen voicing, velocity and transposition actions differ only in the transform
 * they pass, so the "is anything open, and did anything match" dance is written once
 * here rather than fourteen times.
 */
function transformSelection(
  state: { project: Project | null; editingPhraseId: string | null },
  segmentIds: string[],
  transform: (segment: ChordSegment, scale: Scale) => ChordSegment
): Project | null {
  const project = state.project;
  if (!project) return null;
  const surface = surfaceOf(project, state.editingPhraseId);
  if (!surface) return null;
  return withTransformedSegments(project, surface.phrase, segmentIds, transform);
}

/**
 * The phrase the timeline is editing, with its bars in the metre they are shown in.
 *
 * The public face of `surfaceOf`, for everything outside this store that has to resolve
 * a *selected* segment id — the inspector, the clipboard, formula capture. Those ids
 * come off the phrase, so looking them up in `project.bars` would find either nothing
 * or, for a phrase played twice, two blocks that no segment action would accept.
 *
 * Returns null in the arrangement view, where there is no segment to be selected.
 */
export function editSurface(): { phrase: Phrase; bars: Bar[] } | null {
  const { project, editingPhraseId } = projectStore.getState();
  return project ? surfaceOf(project, editingPhraseId) : null;
}

/** Build an instrument. New ones start on the default sound, audible and visible. */
export function createTrack(name: string, index: number, instrument?: string): Track {
  return {
    id: generateId(),
    name,
    instrument: instrument ?? DEFAULT_INSTRUMENT_ID,
    volume: 1.0,
    pan: 0,
    muted: false,
    solo: false,
    visible: true,
    color: trackColorAt(index),
  };
}

const createInitialProject = (): Project => ({
  id: generateId(),
  name: 'Untitled',
  bpm: DEFAULT_BPM,
  timeSignature: DEFAULT_TIME_SIGNATURE,
  key: DEFAULT_KEY,
  keyMode: DEFAULT_KEY_MODE,
  // Every project opens with one instrument, so there is always somewhere for a
  // dropped chord to land.
  tracks: [createTrack('Piano', 0)],
  phrases: [],
  clips: [],
  bars: [],
  sections: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});

/**
 * Patch one instrument, leaving the others alone.
 *
 * An unknown id is a no-op rather than an error: these are all driven by clicks on
 * a panel that can lag a removal by a frame, which is a sloppy state, not a bug.
 */
function updateTrack(
  get: () => ProjectState,
  set: (partial: Partial<ProjectState>) => void,
  trackId: string,
  patch: (track: Track) => Partial<Track>
): void {
  const project = get().project;
  if (!project) return;
  if (!project.tracks.some(t => t.id === trackId)) return;
  const tracks = project.tracks.map(t => (t.id === trackId ? { ...t, ...patch(t) } : t));
  set({
    project: {
      ...project,
      // Recompiled rather than stored as patched: `volumeAutomation` is derived, and
      // the fader is what scales it — so moving the fader has to redraw every curve
      // it drives. Tracks whose curves are unchanged come back by identity.
      tracks: compileAutomation(
        tracks,
        project.bars,
        project.phrases,
        project.clips,
        project.timeSignature
      ),
      updatedAt: new Date(),
    },
  });
}

/**
 * Rewrite one phrase's volume curve.
 *
 * Every automation edit goes through here so three rules hold in one place: the
 * stored array is always what `normalizePoints` would produce, a curve that has
 * lost its last point is *dropped* rather than left as an empty array — an empty
 * curve and no curve mean the same thing, and only the absent form hands the
 * placement back to the instrument's fader — and the song is recompiled, so the
 * curve reaches every placement of the phrase at once.
 *
 * A no-op edit returns the project untouched, so a stray move never lands an
 * entry on the undo stack.
 */
function updateVolumeAutomation(
  get: () => ProjectState,
  set: (partial: Partial<ProjectState>) => void,
  phraseId: string,
  edit: (points: AutomationPoint[]) => AutomationPoint[]
): void {
  const project = get().project;
  const phrase = project ? phraseById(project.phrases, phraseId) : null;
  if (!project || !phrase) return;

  const current = phrase.volumeAutomation ?? [];
  const next = normalizePoints(edit(current));
  if (samePoints(current, next)) return;

  set({
    project: recompiled({
      ...project,
      phrases: project.phrases.map(p =>
        p.id === phraseId ? { ...p, volumeAutomation: next.length > 0 ? next : undefined } : p
      ),
    }),
  });
}

/**
 * Rewrite one phrase's plugin parameter lanes.
 *
 * The counterpart to `updateVolumeAutomation`, with one deliberate difference:
 * an empty *lane* is kept where an empty volume curve is dropped. Dropping the
 * volume curve hands control back to the fader, which is a real destination; a
 * parameter has no fader to hand back to, and a lane the user just added would
 * vanish before they could draw on it.
 *
 * A no-op edit returns the project untouched, so a stray drag never lands an
 * entry on the undo stack.
 */
function updateParameterAutomation(
  get: () => ProjectState,
  set: (partial: Partial<ProjectState>) => void,
  phraseId: string,
  edit: (lanes: ParameterAutomation[]) => ParameterAutomation[]
): void {
  const project = get().project;
  const phrase = project ? phraseById(project.phrases, phraseId) : null;
  if (!project || !phrase) return;

  const current = phrase.parameterAutomation ?? [];
  const next = normalizeParameterAutomation(edit(current));
  if (sameLanes(current, next)) return;

  set({
    project: recompiled({
      ...project,
      phrases: project.phrases.map(p =>
        p.id === phraseId
          ? { ...p, parameterAutomation: next.length > 0 ? next : undefined }
          : p
      ),
    }),
  });
}

/**
 * Rewrite the project's sections.
 *
 * Every section edit goes through here so one rule holds in one place: the stored
 * array is always what `normalizeSections` would produce, sorted and free of
 * overlaps, whatever a pointer drag handed in. Like the play range, none of these
 * edits throws — a drag can legitimately pass through a backwards or zero-width span
 * on the way to a good one, and refusing it mid-gesture would only fight the pointer.
 */
function updateSections(
  get: () => ProjectState,
  set: (partial: Partial<ProjectState>) => void,
  edit: (sections: Section[]) => Section[]
): Section[] | null {
  const project = get().project;
  if (!project) return null;

  const current = project.sections ?? [];
  const next = normalizeSections(
    edit(current),
    getTotalBeats(project.bars, project.timeSignature)
  );

  // An edit naming an id that is not there changes nothing, and a no-op must not
  // land an entry on the undo stack — the panels these come from can lag a removal
  // by a frame, which is a sloppy state rather than a bug, as `updateTrack` has it.
  const unchanged =
    next.length === current.length &&
    next.every((s, i) => {
      const was = current[i];
      return (
        s.id === was.id &&
        s.name === was.name &&
        s.startBeat === was.startBeat &&
        s.endBeat === was.endBeat &&
        s.color === was.color
      );
    });
  if (unchanged) return next;

  set({ project: { ...project, sections: next, updatedAt: new Date() } });
  return next;
}

/** Whether two track arrays hold the same instruments, in the same order and groups. */
function sameTrackOrder(a: Track[], b: Track[]): boolean {
  return (
    a.length === b.length &&
    a.every((track, i) => track.id === b[i].id && track.groupId === b[i].groupId)
  );
}

/**
 * Rewrite the project's instrument groups.
 *
 * Every group edit goes through here so one rule holds in one place: the tracks are
 * re-normalized against whatever groups came out, which is what turns "remove this
 * group" into "its members become ungrouped and stay where they are" without any
 * caller having to say so. A group naming an id that is not there changes nothing
 * and must not land on the undo stack, the way `updateTrack` refuses an unknown id.
 */
function updateTrackGroups(
  get: () => ProjectState,
  set: (partial: Partial<ProjectState>) => void,
  edit: (groups: TrackGroup[]) => TrackGroup[]
): void {
  const project = get().project;
  if (!project) return;

  const current = project.trackGroups ?? [];
  const next = edit(current);
  if (next.length === current.length && next.every((g, i) => g === current[i])) return;

  set({
    project: {
      ...project,
      trackGroups: next,
      tracks: normalizeTrackOrder(project.tracks, next),
      updatedAt: new Date(),
    },
  });
}

export const projectStore = create<ProjectState>((set, get) => ({
  project: null,

  createProject: () => {
    set({ project: createInitialProject() });
  },

  /** Replace the current project wholesale, e.g. after loading a file. */
  loadProject: (project: Project) => {
    // A project saved before free placement carries no segment positions; packing
    // them is what those files always meant. Applied to the phrases, since that is
    // where the file's music now is — the song's bars are rebuilt from them below.
    const phrases = project.phrases.map(phrase => ({
      ...phrase,
      bars: phrase.bars.map(bar => ({
        ...bar,
        content: Object.fromEntries(
          Object.entries(bar.content).map(([key, content]) => [
            key,
            { ...content, chords: withStartBeats(content.chords) },
          ])
        ),
      })),
    }));

    set({
      // `recompiled` rather than a plain set: `Bar.content` is not written to file, so
      // a freshly-read project has an empty grid until the placements are played into
      // it. It also runs the clips through their normalise gate, for the same reason
      // the curves and the sections are normalised on the way in — a hand-edited file
      // is the one place a dangling or overlapping list can come from.
      project: recompiled({
        ...project,
        phrases,
        sections: normalizeSections(
          project.sections ?? [],
          getTotalBeats(project.bars, project.timeSignature)
        ),
      }),
      // Whatever was open belonged to the project being replaced.
      editingPhraseId: null,
      editingClipId: null,
    });
    showView('arrangement');
  },

  setBpm: (bpm: number) => {
    const project = get().project;
    if (!project) return;
    if (bpm < 20 || bpm > 300) {
      throw new Error('BPM must be between 20 and 300');
    }
    set({
      project: {
        ...project,
        bpm,
        updatedAt: new Date(),
      },
    });
  },

  /**
   * Set — or, with a null bound, clear — the play range.
   *
   * Unlike the other setters this never throws: it is driven by a pointer drag, which
   * can legitimately produce a backwards or zero-width range on the way to a good one.
   * A range too short to hear is simply ignored, leaving the previous one in place.
   */
  setLoopRegion: (start: number | null, end: number | null) => {
    const project = get().project;
    if (!project) return;

    if (start === null || end === null) {
      set({
        project: { ...project, loopStart: undefined, loopEnd: undefined, updatedAt: new Date() },
      });
      return;
    }

    const songEnd = getTotalBeats(project.bars, project.timeSignature);
    const clamp = (beat: number) => Math.max(0, Math.min(beat, songEnd));
    const loopStart = clamp(Math.min(start, end));
    const loopEnd = clamp(Math.max(start, end));

    if (loopEnd - loopStart < MIN_SEGMENT_BEATS) return;

    set({ project: { ...project, loopStart, loopEnd, updatedAt: new Date() } });
  },

  /**
   * Draw a named span over the arrangement.
   *
   * Returns the new section's id — read back out of the normalised list rather than
   * assumed, since a span too short to read, or one wholly swallowed by the section
   * it was dropped on, legitimately produces nothing at all.
   */
  addSection: (startBeat: number, endBeat: number, name?: string) => {
    const current = get().project?.sections ?? [];
    const id = generateId();
    const section: Section = {
      id,
      name: name && name.trim().length > 0 ? name : nextSectionName(current),
      startBeat,
      endBeat,
      color: sectionColorAt(current.length),
    };

    const next = updateSections(get, set, sections => [...sections, section]);
    return next?.some(s => s.id === id) ? id : null;
  },

  renameSection: (sectionId: string, name: string) => {
    // An empty name would leave a band nothing can be read off; the old one stands.
    if (name.trim().length === 0) return;
    updateSections(get, set, sections =>
      sections.map(s => (s.id === sectionId ? { ...s, name } : s))
    );
  },

  setSectionRange: (sectionId: string, startBeat: number, endBeat: number) => {
    updateSections(get, set, sections =>
      sections.map(s => (s.id === sectionId ? { ...s, startBeat, endBeat } : s))
    );
  },

  setSectionColor: (sectionId: string, color: string) => {
    updateSections(get, set, sections =>
      sections.map(s => (s.id === sectionId ? { ...s, color } : s))
    );
  },

  /** Erase a label. Every block underneath it stays exactly where it was. */
  removeSection: (sectionId: string) => {
    updateSections(get, set, sections => sections.filter(s => s.id !== sectionId));
  },

  toggleLoopEnabled: () => {
    const project = get().project;
    if (!project) return;
    set({
      project: { ...project, loopEnabled: !project.loopEnabled, updatedAt: new Date() },
    });
  },

  toggleMetronome: () => {
    const project = get().project;
    if (!project) return;
    set({
      project: { ...project, metronomeEnabled: !project.metronomeEnabled, updatedAt: new Date() },
    });
  },

  setTimeSignature: (ts: TimeSignature) => {
    const project = get().project;
    if (!project) return;
    if (!isValidTimeSignature(ts)) {
      throw new Error('Invalid time signature');
    }
    set({
      project: {
        ...project,
        timeSignature: ts,
        updatedAt: new Date(),
      },
    });
  },

  setKey: (key: NoteName, mode: 'major' | 'minor' = 'major') => {
    const project = get().project;
    if (!project) return;
    set({
      project: {
        ...project,
        key,
        keyMode: mode,
        updatedAt: new Date(),
      },
    });
  },

  addBar: () => {
    const project = get().project;
    if (!project) return;
    const newBar: Bar = {
      id: generateId(),
      barIndex: project.bars.length,
      content: {},
    };
    set({ project: applyGrid(project, [...project.bars, newBar]) });
  },

  /**
   * Insert empty bars at a position, shifting everything from there on.
   *
   * Like a drop that missed its target rather than a bad call, an out-of-range
   * index is clamped to the ends of the list and a non-positive count does
   * nothing: the caller is a drag or a context menu, and a sloppy one simply
   * does not apply.
   */
  insertBar: (index: number, count: number) => {
    const project = get().project;
    if (!project) return;

    const amount = Math.floor(count);
    if (amount <= 0) return;

    const bars = [...project.bars];
    const at = Math.max(0, Math.min(index, bars.length));
    const fresh: Bar[] = Array.from({ length: amount }, () => ({
      id: generateId(),
      barIndex: 0,
      content: {},
    }));
    bars.splice(at, 0, ...fresh);
    // Placements from the insertion point on move along with the music they hold. A
    // clip left where it was would find different bars under it — which is the one
    // thing inserting a bar must not do to the rest of the arrangement.
    set({
      project: applyGrid(
        {
          ...project,
          clips: project.clips.map(c =>
            c.startBar >= at ? { ...c, startBar: c.startBar + amount } : c
          ),
        },
        bars.map((b, i) => ({ ...b, barIndex: i }))
      ),
    });
  },

  removeBar: (barId: string) => {
    const project = get().project;
    if (!project) return;
    const barIndex = project.bars.findIndex(b => b.id === barId);
    if (barIndex === -1) {
      throw new Error('Bar not found');
    }
    // A bar something is playing over cannot be taken away. The placement over it is
    // as long as its phrase and cannot be trimmed, so the grid would simply grow back
    // underneath it on the next compile — better to refuse than to appear to work.
    // Move or delete the block first, as the arrangement view invites.
    if (project.clips.some(c => c.startBar <= barIndex && clipEndBar(c, project.phrases) > barIndex)) {
      return;
    }

    const newBars = project.bars.filter(b => b.id !== barId).map((b, i) => ({ ...b, barIndex: i }));
    // Placements after the removed bar close up behind it.
    set({
      project: applyGrid(
        {
          ...project,
          clips: project.clips.map(c =>
            c.startBar > barIndex ? { ...c, startBar: c.startBar - 1 } : c
          ),
        },
        newBars
      ),
    });
  },

  /**
   * Take a run of bars out of the song — Remove on the arrangement ruler's menu.
   *
   * The mirror of `insertBar`, and it takes the clicked bar and the ones after it
   * rather than the ones before, so a count reads the same way in both: the bar the
   * user pointed at is the one the edit starts from.
   *
   * `removeBar`'s refusal carries over, and applies to the run as a whole: if anything
   * is playing over any bar in it, nothing goes. A placement is as long as its phrase
   * and cannot be trimmed, so the grid would simply grow back underneath it on the
   * next compile. Refusing part-way would be worse than refusing — the user asked for
   * a number of bars, not for as many as happened to be free.
   *
   * The last bar is kept, unlike in `removeBar`, which is only ever asked for one at a
   * time: a song with no bars has no bar cursor, and so no way back to Add Bar.
   */
  removeBars: (index: number, count: number) => {
    const project = get().project;
    if (!project) return;

    const amount = Math.trunc(count);
    if (amount <= 0) return;

    const at = Math.max(0, Math.trunc(index));
    if (at >= project.bars.length) return;

    const span = Math.min(amount, project.bars.length - at);
    if (span >= project.bars.length) return;

    const end = at + span;
    if (project.clips.some(c => c.startBar < end && clipEndBar(c, project.phrases) > at)) {
      return;
    }

    const newBars = project.bars
      .filter((_, i) => i < at || i >= end)
      .map((b, i) => ({ ...b, barIndex: i }));
    set({
      project: applyGrid(
        {
          ...project,
          clips: project.clips.map(c =>
            c.startBar >= end ? { ...c, startBar: c.startBar - span } : c
          ),
        },
        newBars
      ),
    });
  },

  setSegmentsScale: (segmentIds: string[], patch: Partial<Scale>) => {
    const project = get().project;
    if (!project) return;
    // Diatonic segments name a scale degree, so a change of key has to move them
    // onto the new key's chord for that degree — and their notes with them. Only
    // the selected blocks move; their neighbours keep the key they were written in.
    const next = transformSelection(get(), segmentIds, (segment, current) => {
      // A patch rather than a whole scale, so setting the type across a selection
      // whose roots differ leaves each block on its own root.
      const target: Scale = { root: patch.root ?? current.root, type: patch.type ?? current.type };
      return { ...retuneSegmentsToScale([segment], current, target)[0], scale: target };
    });
    if (!next) return;
    set({ project: next });
  },

  setBarTimeSignature: (barId: string, ts: TimeSignature) => {
    const project = get().project;
    if (!project) return;
    if (!isValidTimeSignature(ts)) {
      throw new Error('Invalid time signature');
    }
    if (!project.bars.some(b => b.id === barId)) {
      throw new Error('Bar not found');
    }
    const bars = project.bars.map(b => (b.id === barId ? { ...b, timeSignature: ts } : b));
    // The bar's capacity just changed, so whatever plays there may no longer fit; the
    // recompile re-runs every placement through it.
    set({ project: applyGrid(project, bars) });
  },

  insertSegment: (barId: string, startBeat: number, segment: ChordSegment, trackId: string) => {
    const project = get().project;
    if (!project) return;
    // A drop made in the arrangement view has no phrase to land in. Nothing to do —
    // the same shrug a drop that missed every bar gets.
    const surface = surfaceOf(project, get().editingPhraseId);
    if (!surface) return;
    const target = surface.bars.find(b => b.id === barId);
    if (!target) return;
    // Likewise a drop with no instrument to land on.
    if (!project.tracks.some(t => t.id === trackId)) return;

    const capacity = getBarBeats(target, project.timeSignature);
    const bars = mapBar(surface.bars, barId, PHRASE_TRACK_KEY, chords =>
      placedIn(chords, segment, startBeat, capacity)
    );
    set({ project: applyPhraseBars(project, surface.phrase.id, bars) });
  },

  /**
   * Punch a segment onto the timeline at an *absolute* beat — what live recording
   * commits, on key-down and again on key-up.
   *
   * Absolute rather than bar-relative because the caller is a playhead reading, which
   * knows nothing of bars; the bar is resolved here. What it lands on is *cleared*
   * rather than rippled, unlike `insertSegment`: re-recording over a passage must not
   * shove the rest of the song along. Re-calling it with the same segment id and a
   * longer duration is how a held key grows its block — `placeSegmentInBar` moves a
   * segment it already holds rather than duplicating it.
   *
   * Both the clear and the placement are confined to the segment's own sub-lane, and
   * the instrument grows a lane when the segment needs one it does not have. That is
   * what lets a chord be recorded as the several simultaneous blocks it is: each key
   * lands in its own lane instead of erasing the one before it, and nothing played is
   * ever refused for want of somewhere to put it.
   */
  recordSegment: (trackId, startBeat, segment, onCommit) => {
    const project = get().project;
    if (!project) return;
    const track = project.tracks.find(t => t.id === trackId);
    if (!track) return;
    // A take needs a phrase to land in. Recording is disabled in the arrangement view
    // for exactly this reason, so reaching here means a stray key-up after a close.
    const surface = surfaceOf(project, get().editingPhraseId);
    if (!surface) return;
    // Recording is bounded by the phrase: bars are added deliberately, not by holding
    // a key down past the last one.
    if (startBeat < 0 || startBeat >= getTotalBeats(surface.bars, project.timeSignature)) return;

    const barIndex = getBarIndexAtBeat(surface.bars, project.timeSignature, startBeat);
    const target = surface.bars[barIndex];
    const offset = getBarStartBeat(surface.bars, barIndex, project.timeSignature);

    const lane = laneOf(segment);
    const cleared = clearRange(
      surface.bars,
      project.timeSignature,
      PHRASE_TRACK_KEY,
      startBeat,
      startBeat + segment.duration,
      segment.id,
      lane
    );
    // Lift any earlier copy of the take out first, so a shrinking one leaves no
    // stale remains behind for the ripple in `placedIn` to find.
    const lifted = cleared.map(bar =>
      PHRASE_TRACK_KEY in bar.content
        ? mapBarChords(bar, PHRASE_TRACK_KEY, chords =>
            removeSegmentById(withStartBeats(chords), segment.id)
          )
        : bar
    );

    const capacity = getBarBeats(target, project.timeSignature);
    const bars = mapBar(lifted, target.id, PHRASE_TRACK_KEY, chords =>
      placedIn(chords, segment, startBeat - offset, capacity)
    );

    // The instrument grows to hold the lane just written to. It never shrinks back
    // on its own: an emptied lane keeps its row so the strip's height does not
    // change under the cursor mid-take.
    const grown =
      lane < trackLaneCount(track)
        ? project
        : {
            ...project,
            tracks: project.tracks.map(t =>
              t.id === trackId ? { ...t, laneCount: lane + 1 } : t
            ),
          };

    const next = applyPhraseBars(grown, surface.phrase.id, bars);
    set({ project: next });
    onCommit?.(next);
  },

  removeSegment: (segmentId: string) => {
    get().removeSegments([segmentId]);
  },

  /**
   * Delete every named block at once — what Delete does to a multi-selection.
   *
   * The space each occupied stays empty: a deleted block leaves a rest behind
   * rather than pulling its neighbours back. The whole batch is one store write,
   * so however many blocks are selected it is one visual step and one history
   * entry. Bars this instrument has nothing in are skipped rather than gaining an
   * empty key, which would leave `content` growing an entry per bar per edit.
   */
  removeSegments: (segmentIds: string[]) => {
    const project = get().project;
    if (!project) return;

    const surface = surfaceOf(project, get().editingPhraseId);
    if (!surface) return;

    // No grouping by instrument any more: a phrase holds one part, so every id in a
    // selection is in the one place there is to look.
    const targets = new Set(segmentIds);
    if (!surface.bars.some(bar => barChords(bar, PHRASE_TRACK_KEY).some(c => targets.has(c.id)))) {
      return;
    }

    const bars = surface.bars.map(bar =>
      PHRASE_TRACK_KEY in bar.content
        ? mapBarChords(bar, PHRASE_TRACK_KEY, chords =>
            withStartBeats(chords).filter(c => !targets.has(c.id))
          )
        : bar
    );
    set({ project: applyPhraseBars(project, surface.phrase.id, bars) });
  },

  setTrackLaneCount: (trackId: string, count: number) => {
    const project = get().project;
    if (!project) return;
    if (!Number.isFinite(count)) return;

    const next = Math.max(1, Math.floor(count));
    const track = project.tracks.find(t => t.id === trackId);
    if (!track || trackLaneCount(track) === next) return;

    // Shrinking over occupied lanes is a no-op rather than an error: the buttons
    // that call this are a gesture, and a gesture that cannot apply simply does
    // not, exactly as a drop that missed every bar does nothing.
    // Every phrase this instrument plays has to fit in the remaining lanes, not just
    // the one open in the editor: shrinking here would otherwise hide a lane that some
    // other placement is still using.
    const occupied = project.clips
      .filter(c => c.trackId === trackId)
      .some(c => {
        const phrase = phraseById(project.phrases, c.phraseId);
        return phrase
          ? flattenSegments(phrase.bars, PHRASE_TRACK_KEY).some(seg => laneOf(seg) >= next)
          : false;
      });
    if (occupied) return;

    set({
      project: {
        ...project,
        tracks: project.tracks.map(t => (t.id === trackId ? { ...t, laneCount: next } : t)),
        updatedAt: new Date(),
      },
    });
  },

  /**
   * Reposition several blocks at once — what dragging a multi-selection commits.
   *
   * Every moved block is lifted out first, so blocks in the same bar never ripple
   * against stale copies of themselves or of each other. They are then placed in
   * ascending destination order, which makes the ripple deterministic regardless
   * of the order the caller listed them in, and the whole batch ends in a single
   * refit — one visual step, one history entry.
   *
   * Destinations are absolute beats, so a batch may land past the end of the song;
   * the project grows to hold it rather than the moves being clamped back into the
   * last bar.
   */
  moveSegments: (moves: SegmentMove[]) => {
    const project = get().project;
    if (!project) return;
    if (moves.length === 0) return;

    const surface = surfaceOf(project, get().editingPhraseId);
    if (!surface) return;

    // Drop moves whose block no longer exists, or that name a beat off the line
    // entirely, rather than failing the whole gesture: a stale selection is a
    // sloppy state, not an error.
    const resolved = moves
      .map(move => ({
        move,
        segment: surface.bars
          .flatMap(bar => withStartBeats(barChords(bar, PHRASE_TRACK_KEY)))
          .find(c => c.id === move.segmentId),
      }))
      .filter(
        (entry): entry is { move: SegmentMove; segment: ChordSegment } =>
          entry.segment !== undefined &&
          Number.isFinite(entry.move.absoluteBeat) &&
          entry.move.absoluteBeat >= 0
      );
    if (resolved.length === 0) return;

    const movedIds = new Set(resolved.map(entry => entry.move.segmentId));
    let bars = surface.bars.map(bar =>
      PHRASE_TRACK_KEY in bar.content
        ? mapBarChords(bar, PHRASE_TRACK_KEY, chords =>
            withStartBeats(chords).filter(c => !movedIds.has(c.id))
          )
        : bar
    );

    // Grow the phrase before anything is placed, so the bar a destination names
    // exists by the time it is resolved.
    const furthest = Math.max(...resolved.map(entry => entry.move.absoluteBeat));
    bars = extendBarsToBeat(bars, project.timeSignature, furthest);

    // Lane joins the ordering key so a chord's worth of stacked blocks lands in a
    // fixed order, however the caller happened to list them.
    const ordered = [...resolved].sort(
      (a, b) =>
        a.move.absoluteBeat - b.move.absoluteBeat ||
        (a.move.lane ?? laneOf(a.segment)) - (b.move.lane ?? laneOf(b.segment))
    );

    for (const { move, segment } of ordered) {
      // The bar holding this beat, and the offset within it — the one place the
      // absolute line is turned back into the bars that display it.
      const position = resolveBeatPosition(move.absoluteBeat, bars, project.timeSignature);
      if (!position) continue;
      const target = bars[position.barIndex];
      const capacity = getBarBeats(target, project.timeSignature);
      // A move with no lane keeps the one the block is in, so every caller that
      // predates sub-lanes goes on meaning what it did.
      const placed = move.lane === undefined ? segment : { ...segment, lane: move.lane };
      bars = mapBar(bars, target.id, PHRASE_TRACK_KEY, chords =>
        placedIn(chords, placed, position.startBeat, capacity)
      );
    }

    set({ project: applyPhraseBars(project, surface.phrase.id, bars) });
  },

  resizeSegmentDuration: (segmentId: string, duration: number, snapBeats: number) => {
    const project = get().project;
    if (!project) return;
    const surface = surfaceOf(project, get().editingPhraseId);
    if (!surface) return;
    const owner = surface.bars.find(b =>
      barChords(b, PHRASE_TRACK_KEY).some(c => c.id === segmentId)
    );
    if (!owner) return;

    const chords = withStartBeats(barChords(owner, PHRASE_TRACK_KEY));
    // A block grows into the space in front of it, and may run straight through the
    // bar line to do it — a chord held over the barline is ordinary music. What it
    // cannot outlast is the phrase, so the end of the last bar is the cap.
    const start = chords.find(c => c.id === segmentId)!.startBeat!;
    const absoluteStart =
      getBarStartBeat(surface.bars, surface.bars.indexOf(owner), project.timeSignature) + start;
    const maxBeats = getTotalBeats(surface.bars, project.timeSignature) - absoluteStart;

    const resized = resizeSegment(chords, segmentId, duration, snapBeats, maxBeats);
    // A resize that lands on the width the block already had is not an edit. Refitting
    // and recompiling for it would mint a fresh project object, and with it an undo
    // entry that rewinds to a state indistinguishable from the current one.
    const before = chords.find(c => c.id === segmentId)!.duration;
    if (resized.find(c => c.id === segmentId)!.duration === before) return;

    const bars = mapBar(surface.bars, owner.id, PHRASE_TRACK_KEY, () => resized);
    set({ project: applyPhraseBars(project, surface.phrase.id, bars) });
  },

  /** Move every named segment one step along its own bar's scale — the up and down arrows. */
  stepSegmentsPitch: (segmentIds: string[], direction: -1 | 1) => {
    const project = get().project;
    if (!project) return;
    const next = transformSelection(get(), segmentIds, (segment, scale) =>
      stepSegmentInScale(segment, scale, direction)
    );
    if (next) set({ project: next });
  },

  /** Move every named segment a whole octave — the + and - keys. */
  shiftSegmentsOctave: (segmentIds: string[], direction: -1 | 1) => {
    const project = get().project;
    if (!project) return;
    const next = transformSelection(get(), segmentIds, segment =>
      shiftSegmentOctave(segment, direction)
    );
    if (next) set({ project: next });
  },

  /** Advance each chord to its next inversion, wrapping to root position — the `i` key. */
  cycleSegmentsInversion: (segmentIds: string[]) => {
    const project = get().project;
    if (!project) return;
    const next = transformSelection(get(), segmentIds, cycleSegmentInversion);
    if (next) set({ project: next });
  },

  /**
   * Set an absolute inversion, as the inspector's buttons name one.
   *
   * The companion to `cycleSegmentsInversion`, which the `i` key still uses:
   * stepping through them and picking one out are the same edit, reached two ways.
   */
  setSegmentsInversion: (segmentIds: string[], inversion: number) => {
    const project = get().project;
    if (!project) return;
    const next = transformSelection(get(), segmentIds, (segment, scale) =>
      withInversion(segment, scale, inversion)
    );
    if (next) set({ project: next });
  },

  /** Space each chord by a preset, seeding the per-tone offsets it implies. */
  setSegmentsSpacing: (segmentIds: string[], preset: SpacingPreset) => {
    const project = get().project;
    if (!project) return;
    const next = transformSelection(get(), segmentIds, (segment, scale) =>
      withSpacing(segment, scale, preset)
    );
    if (next) set({ project: next });
  },

  /** Move one chord tone by whole octaves, which makes the voicing custom. */
  setSegmentsToneOffset: (segmentIds: string[], tone: number, offsetOctaves: number) => {
    const project = get().project;
    if (!project) return;
    const next = transformSelection(get(), segmentIds, segment =>
      withToneOffset(segment, tone, offsetOctaves)
    );
    if (next) set({ project: next });
  },

  /** Add or remove a doubled copy of one chord tone. */
  toggleSegmentsDoubling: (segmentIds: string[], tone: number, octaves: 1 | -1) => {
    const project = get().project;
    if (!project) return;
    const next = transformSelection(get(), segmentIds, segment =>
      withToggledDoubling(segment, tone, octaves)
    );
    if (next) set({ project: next });
  },

  /** Arpeggiate or strum each chord; null returns it to a block chord. */
  setSegmentsBreak: (segmentIds: string[], spec: SegmentBreak | null) => {
    const project = get().project;
    if (!project) return;
    const next = transformSelection(get(), segmentIds, segment =>
      withBreak(segment, spec)
    );
    if (next) set({ project: next });
  },

  /** Set how hard each segment sounds — chords, notes and recorded blocks alike. */
  setSegmentsVelocity: (segmentIds: string[], velocity: number) => {
    const project = get().project;
    if (!project) return;
    const next = transformSelection(get(), segmentIds, segment =>
      withVelocity(segment, velocity)
    );
    if (next) set({ project: next });
  },

  /** Raise or flatten each note against the degree it names — the inspector's ♭ ♮ ♯. */
  setSegmentsAlter: (segmentIds: string[], alter: number) => {
    const project = get().project;
    if (!project) return;
    const next = transformSelection(get(), segmentIds, (segment, scale) =>
      alterSegment(segment, scale, alter)
    );
    if (next) set({ project: next });
  },

  /** Return each chord to close position, sounded as a block. */
  clearSegmentsVoicing: (segmentIds: string[]) => {
    const project = get().project;
    if (!project) return;
    const next = transformSelection(get(), segmentIds, withoutVoicing);
    if (next) set({ project: next });
  },

  /** Convert segments between note, triad, and seventh kinds. */
  convertSegmentsKind: (segmentIds, target) => {
    const project = get().project;
    if (!project) return;
    const next = transformSelection(get(), segmentIds, (segment, scale) =>
      convertSegmentKind(segment, scale, target)
    );
    if (next) set({ project: next });
  },

  // The single-segment forms, kept because plenty of callers only ever have one.
  stepSegmentPitch: (segmentId: string, direction: -1 | 1) => {
    get().stepSegmentsPitch([segmentId], direction);
  },

  shiftSegmentOctave: (segmentId: string, direction: -1 | 1) => {
    get().shiftSegmentsOctave([segmentId], direction);
  },

  cycleSegmentInversion: (segmentId: string) => {
    get().cycleSegmentsInversion([segmentId]);
  },

  setSegmentInversion: (segmentId: string, inversion: number) => {
    get().setSegmentsInversion([segmentId], inversion);
  },

  setSegmentSpacing: (segmentId: string, preset: SpacingPreset) => {
    get().setSegmentsSpacing([segmentId], preset);
  },

  setSegmentToneOffset: (segmentId: string, tone: number, offsetOctaves: number) => {
    get().setSegmentsToneOffset([segmentId], tone, offsetOctaves);
  },

  toggleSegmentDoubling: (segmentId: string, tone: number, octaves: 1 | -1) => {
    get().toggleSegmentsDoubling([segmentId], tone, octaves);
  },

  setSegmentBreak: (segmentId: string, spec: SegmentBreak | null) => {
    get().setSegmentsBreak([segmentId], spec);
  },

  setSegmentVelocity: (segmentId: string, velocity: number) => {
    get().setSegmentsVelocity([segmentId], velocity);
  },

  clearSegmentVoicing: (segmentId: string) => {
    get().clearSegmentsVoicing([segmentId]);
  },

  // -------------------------------------------------------------------------
  // Instruments
  // -------------------------------------------------------------------------

  addTrack: (name?: string) => {
    const project = get().project;
    if (!project) return null;
    const index = project.tracks.length;
    const track = createTrack(name ?? `Instrument ${index + 1}`, index);
    set({
      project: {
        ...project,
        tracks: [...project.tracks, track],
        updatedAt: new Date(),
      },
    });
    return track.id;
  },

  appendInstruments: (instruments: TemplateInstrument[]) => {
    const project = get().project;
    if (!project) return null;
    if (instruments.length === 0) return null;

    const offset = project.tracks.length;
    const added: Track[] = instruments.map((entry, i) => ({
      id: generateId(),
      name: entry.name,
      instrument: entry.instrument,
      volume: entry.volume,
      pan: entry.pan,
      // Session state, not part of the instrument: a template must never arrive
      // pre-muted or soloed, which would look like the app had gone silent.
      muted: false,
      solo: false,
      visible: true,
      // A template written before colours were captured falls back to the palette
      // position the instrument lands in, the way `addTrack` colours a new one.
      color: entry.color ?? trackColorAt(offset + i),
      vst3State: entry.vst3State,
    }));

    // Bars are deliberately untouched. A track with no key in `Bar.content` reads as
    // silence, so the appended instruments simply start empty.
    set({
      project: {
        ...project,
        tracks: [...project.tracks, ...added],
        updatedAt: new Date(),
      },
    });
    return added[0].id;
  },

  /**
   * Remove an instrument and every placement on its row.
   *
   * The *phrases* it played survive, unplaced, in the library. Losing an instrument
   * should cost the arrangement its row, not destroy the music written for it — and a
   * phrase is instrument-agnostic anyway, so what is left is still playable by
   * whatever the user drags it onto next.
   */
  removeTrack: (trackId: string) => {
    const project = get().project;
    if (!project) return;
    if (!project.tracks.some(t => t.id === trackId)) return;
    set({
      project: recompiled({
        ...project,
        tracks: project.tracks.filter(t => t.id !== trackId),
        clips: project.clips.filter(c => c.trackId !== trackId),
      }),
    });
  },

  renameTrack: (trackId: string, name: string) => {
    updateTrack(get, set, trackId, () => ({ name }));
  },

  setTrackInstrument: (trackId: string, instrument: string) => {
    updateTrack(get, set, trackId, () => ({ instrument }));
  },

  setTrackVolume: (trackId: string, volume: number) => {
    if (volume < 0 || volume > 1) {
      throw new Error('Volume must be between 0 and 1');
    }
    updateTrack(get, set, trackId, () => ({ volume }));
  },

  setTrackPan: (trackId: string, pan: number) => {
    if (pan < -1 || pan > 1) {
      throw new Error('Pan must be between -1 and 1');
    }
    updateTrack(get, set, trackId, () => ({ pan }));
  },

  addVolumePoint: (phraseId: string, beat: number, value: number) => {
    updateVolumeAutomation(get, set, phraseId, points =>
      withPoint(points, { beat, value })
    );
  },

  moveVolumePoint: (phraseId: string, index: number, beat: number, value: number) => {
    updateVolumeAutomation(get, set, phraseId, points =>
      movePoint(points, index, { beat, value })
    );
  },

  removeVolumePoint: (phraseId: string, index: number) => {
    updateVolumeAutomation(get, set, phraseId, points => withoutPoint(points, index));
  },

  clearVolumeAutomation: (phraseId: string) => {
    updateVolumeAutomation(get, set, phraseId, () => []);
  },

  addLane: (phraseId: string, target: AutomationTarget, name: string) => {
    updateParameterAutomation(get, set, phraseId, lanes =>
      withLane(lanes, { target, name, points: [] })
    );
  },

  removeLane: (phraseId: string, key: string) => {
    updateParameterAutomation(get, set, phraseId, lanes => withoutLane(lanes, key));
  },

  renameLane: (phraseId: string, key: string, name: string) => {
    updateParameterAutomation(get, set, phraseId, lanes => withLaneName(lanes, key, name));
  },

  addLanePoint: (phraseId: string, key: string, beat: number, value: number) => {
    updateParameterAutomation(get, set, phraseId, lanes =>
      withLanePoints(lanes, key, points => withPoint(points, { beat, value }))
    );
  },

  moveLanePoint: (
    phraseId: string,
    key: string,
    index: number,
    beat: number,
    value: number
  ) => {
    updateParameterAutomation(get, set, phraseId, lanes =>
      withLanePoints(lanes, key, points => movePoint(points, index, { beat, value }))
    );
  },

  removeLanePoint: (phraseId: string, key: string, index: number) => {
    updateParameterAutomation(get, set, phraseId, lanes =>
      withLanePoints(lanes, key, points => withoutPoint(points, index))
    );
  },

  recordLanePoints: (
    phraseId: string,
    target: AutomationTarget,
    name: string,
    points: AutomationPoint[]
  ) => {
    if (points.length === 0) return;

    const key = laneKey(target);
    updateParameterAutomation(get, set, phraseId, lanes => {
      // `withLane` keeps an existing lane's curve untouched, so a second pass over a
      // controller adds to what is there rather than replacing it — which is what
      // punching in over one stretch of a phrase has to mean.
      const opened = withLane(lanes, { target, name, points: [] });
      return withLanePoints(opened, key, existing =>
        points.reduce((acc, point) => withPoint(acc, point), existing)
      );
    });
  },

  setTrackTouchpadTarget: (trackId: string, target: AutomationTarget | null) => {
    updateTrack(get, set, trackId, () => ({
      touchpadTarget: target ?? undefined,
    }));
  },

  toggleTrackMute: (trackId: string) => {
    updateTrack(get, set, trackId, t => ({ muted: !t.muted }));
  },

  toggleTrackSolo: (trackId: string) => {
    updateTrack(get, set, trackId, t => ({ solo: !t.solo }));
  },

  /** Show or hide this instrument's notes on the piano roll. Does not affect sound. */
  toggleTrackVisible: (trackId: string) => {
    updateTrack(get, set, trackId, t => ({ visible: t.visible === false }));
  },

  /** Clone an instrument and all its chord segments across every bar. */
  duplicateTrack: (sourceTrackId: string) => {
    const project = get().project;
    if (!project) return null;
    const source = project.tracks.find(t => t.id === sourceTrackId);
    if (!source) return null;

    const sourceIndex = project.tracks.indexOf(source);
    const newId = generateId();
    const newTrack: Track = {
      id: newId,
      name: `${source.name} (copy)`,
      // Lands in the same group as its original, which is both where the row
      // appears and what keeps the group's run contiguous.
      groupId: source.groupId,
      instrument: source.instrument,
      // The copy holds the same blocks in the same lanes, so it needs the same rows.
      laneCount: source.laneCount,
      volume: source.volume,
      // No curves are copied: they are derived from the phrases, and the copy is
      // about to be handed the same placements — so the recompile below gives it the
      // same curves without them ever being written down twice.
      pan: source.pan,
      muted: source.muted,
      solo: source.solo,
      visible: source.visible,
      color: trackColorAt(sourceIndex + 1),
      // The plugin's preset is part of the instrument, so a copy that dropped it
      // would sound like the plugin's defaults rather than like the original.
      vst3State: source.vst3State,
    };

    // Build the tracks array with the copy inserted after the source.
    const newTracks = [
      ...project.tracks.slice(0, sourceIndex + 1),
      newTrack,
      ...project.tracks.slice(sourceIndex + 1),
    ];

    // The copy plays the same phrases at the same places — *linked*, not deep-copied.
    // Two instruments doubling a part is the ordinary reason to duplicate a track, and
    // linking means editing the part once changes both, which is what doubling means.
    // Make Unique on any one of the new blocks is how they are parted later.
    const newClips = project.clips
      .filter(c => c.trackId === sourceTrackId)
      .map(c => ({ ...c, id: generateId(), trackId: newId }));

    set({
      project: recompiled({
        ...project,
        tracks: newTracks,
        clips: [...project.clips, ...newClips],
      }),
    });
    return newId;
  },

  // -------------------------------------------------------------------------
  // Instrument groups
  // -------------------------------------------------------------------------

  addTrackGroup: (name?: string) => {
    const project = get().project;
    if (!project) return null;

    const current = project.trackGroups ?? [];
    const id = generateId();
    const group: TrackGroup = {
      id,
      name: name && name.trim().length > 0 ? name : `Group ${current.length + 1}`,
      color: trackColorAt(current.length),
    };

    set({
      project: { ...project, trackGroups: [...current, group], updatedAt: new Date() },
    });
    return id;
  },

  removeTrackGroup: (groupId: string) => {
    updateTrackGroups(get, set, groups => groups.filter(g => g.id !== groupId));
  },

  renameTrackGroup: (groupId: string, name: string) => {
    // An empty name would leave a header nothing can be read off; the old one stands,
    // as it does for a section and an automation lane.
    if (name.trim().length === 0) return;
    updateTrackGroups(get, set, groups =>
      groups.map(g => (g.id === groupId ? { ...g, name } : g))
    );
  },

  setTrackGroupColor: (groupId: string, color: string) => {
    updateTrackGroups(get, set, groups =>
      groups.map(g => (g.id === groupId ? { ...g, color } : g))
    );
  },

  toggleTrackGroupCollapsed: (groupId: string) => {
    updateTrackGroups(get, set, groups =>
      groups.map(g => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g))
    );
  },

  toggleTrackGroupMute: (groupId: string) => {
    updateTrackGroups(get, set, groups =>
      groups.map(g => (g.id === groupId ? { ...g, muted: !g.muted } : g))
    );
  },

  toggleTrackGroupSolo: (groupId: string) => {
    updateTrackGroups(get, set, groups =>
      groups.map(g => (g.id === groupId ? { ...g, solo: !g.solo } : g))
    );
  },

  moveTrack: (trackId: string, groupId: string | null, beforeTrackId: string | null) => {
    const project = get().project;
    if (!project) return;

    const groups = project.trackGroups ?? [];
    const tracks = moveTrackInTracks(project.tracks, groups, trackId, groupId, beforeTrackId);

    // A drop that changed nothing must not land on the undo stack — dragging a row
    // one pixel and letting go is a common miss.
    if (sameTrackOrder(project.tracks, tracks)) return;

    set({ project: { ...project, tracks, updatedAt: new Date() } });
  },

  moveTrackGroup: (groupId: string, beforeGroupId: string | null) => {
    const project = get().project;
    if (!project) return;

    const current = project.trackGroups ?? [];
    const moved = moveGroupInTracks(project.tracks, current, groupId, beforeGroupId);

    if (
      sameTrackOrder(project.tracks, moved.tracks) &&
      moved.groups.every((g, i) => g === current[i])
    ) {
      return;
    }

    set({
      project: {
        ...project,
        tracks: moved.tracks,
        trackGroups: moved.groups,
        updatedAt: new Date(),
      },
    });
  },

  /** Paste clipboard segments into the project at the given bar offset. */
  pasteSegments: (segments, trackId, offsetBarIndex, targetStartBeat = 0) => {
    const project = get().project;
    if (!project) return null;
    if (segments.length === 0) return null;
    if (!project.tracks.some(t => t.id === trackId)) return null;
    const surface = surfaceOf(project, get().editingPhraseId);
    if (!surface) return null;

    // Ensure enough bars exist for the paste destination.
    let bars = [...surface.bars];
    const maxSourceBar = Math.max(...segments.map(s => s.barIndex));
    const neededBars = offsetBarIndex + (maxSourceBar - segments[0].barIndex) + 1;

    // Append bars if needed, inheriting meter from the last existing bar.
    while (bars.length < neededBars) {
      const index = bars.length;
      const previous = bars[index - 1];
      bars.push({
        id: generateId(),
        barIndex: index,
        timeSignature: previous?.timeSignature,
        content: {},
      });
    }

    // Group segments by their relative bar offset.
    const baseBar = segments[0].barIndex;
    // The first segment's original startBeat — used to offset all segments
    // so that the left edge of the first pasted segment lands at the cursor.
    const baseStartBeat = segments[0].baseStartBeat ?? segments[0].startBeat;
    const newSegmentIds: string[] = [];

    for (const copied of segments) {
      const targetBarRelative = copied.barIndex - baseBar;
      const targetBarIndex = offsetBarIndex + targetBarRelative;
      const targetBar = bars[targetBarIndex];
      if (!targetBar) continue;

      const capacity = getBarBeats(targetBar, project.timeSignature);
      // Compute the adjusted startBeat: keep the original relative spacing
      // between segments, then shift the whole group so the first segment
      // lands at the mouse-cursor beat (targetStartBeat).
      const adjustedStartBeat = copied.startBeat - baseStartBeat + targetStartBeat;
      const newSegment: ChordSegment = {
        ...copied.segment,
        id: generateId(),
        startBeat: adjustedStartBeat,
      };

      bars = mapBar(bars, targetBar.id, PHRASE_TRACK_KEY, chords =>
        placedIn(chords, newSegment, adjustedStartBeat, capacity)
      );
      newSegmentIds.push(newSegment.id);
    }

    set({ project: applyPhraseBars(project, surface.phrase.id, bars) });
    return newSegmentIds.length > 0 ? newSegmentIds : null;
  },

  // -------------------------------------------------------------------------
  // Phrases and their placements
  // -------------------------------------------------------------------------

  editingPhraseId: null,
  editingClipId: null,

  openClip: (clipId: string) => {
    const project = get().project;
    if (!project) return;
    const clip = project.clips.find(c => c.id === clipId);
    if (!clip) return;
    if (!phraseById(project.phrases, clip.phraseId)) return;
    set({ editingPhraseId: clip.phraseId, editingClipId: clip.id });
    // A phrase names no instrument, so the editor takes its sound from the row the
    // block was opened on — which is also the one the user is listening to.
    selectTrackForPhrase(clip.trackId);
    showView('phrase');
  },

  openPhrase: (phraseId: string) => {
    const project = get().project;
    if (!project) return;
    if (!phraseById(project.phrases, phraseId)) return;
    const clip = project.clips.find(c => c.phraseId === phraseId);
    set({ editingPhraseId: phraseId, editingClipId: clip?.id ?? null });
    if (clip) selectTrackForPhrase(clip.trackId);
    showView('phrase');
  },

  closePhrase: () => {
    set({ editingPhraseId: null, editingClipId: null });
    showView('arrangement');
  },

  /**
   * Create a phrase and place it — dragging out a block on an empty stretch of a row.
   *
   * Refuses rather than nudging when the span is taken. The gesture drew a specific
   * place; putting the block somewhere else instead would answer a question the user
   * did not ask.
   */
  addPhraseClip: (trackId: string, startBar: number, lengthBars: number) => {
    const project = get().project;
    if (!project) return null;
    if (!project.tracks.some(t => t.id === trackId)) return null;
    if (!Number.isInteger(startBar) || startBar < 0) return null;

    const phrase = createPhrase(
      nextPhraseName(project.phrases),
      lengthBars,
      phraseColorAt(project.phrases.length)
    );
    const phrases = [...project.phrases, phrase];
    const clip: PhraseClip = { id: generateId(), phraseId: phrase.id, trackId, startBar };
    if (!canPlaceClip(project.clips, phrases, clip)) return null;

    set({ project: recompiled({ ...project, phrases, clips: [...project.clips, clip] }) });
    return clip.id;
  },

  /** Place an existing phrase again — a linked placement, sharing one definition. */
  placePhrase: (phraseId: string, trackId: string, startBar: number) => {
    const project = get().project;
    if (!project) return null;
    if (!project.tracks.some(t => t.id === trackId)) return null;
    if (!phraseById(project.phrases, phraseId)) return null;

    const clip: PhraseClip = { id: generateId(), phraseId, trackId, startBar };
    if (!canPlaceClip(project.clips, project.phrases, clip)) return null;

    set({ project: recompiled({ ...project, clips: [...project.clips, clip] }) });
    return clip.id;
  },

  linkClip: (clipId: string, trackId: string, startBar: number) => {
    const project = get().project;
    if (!project) return null;
    const source = project.clips.find(c => c.id === clipId);
    if (!source) return null;
    return get().placePhrase(source.phraseId, trackId, startBar);
  },

  /**
   * Copy a placement *and* its phrase, so the copy can be edited alone.
   *
   * The opposite of `linkClip`, and `makeClipUnique` taken up front: the split happens
   * at the moment the copy is made, rather than after the user discovers they changed
   * the chorus they were trying to leave alone.
   *
   * The phrase is only added once the clip is known to fit, so a duplicate that lands
   * on an occupied span leaves no orphan copy behind in the library.
   */
  duplicateClip: (clipId: string, trackId: string, startBar: number) => {
    const project = get().project;
    if (!project) return null;
    if (!project.tracks.some(t => t.id === trackId)) return null;
    const source = project.clips.find(c => c.id === clipId);
    if (!source) return null;
    const phrase = phraseById(project.phrases, source.phraseId);
    if (!phrase) return null;

    const copy = clonePhrase(phrase, uniquePhraseName(project.phrases, phrase.name));
    const phrases = [...project.phrases, copy];
    const clip: PhraseClip = { id: generateId(), phraseId: copy.id, trackId, startBar };
    if (!canPlaceClip(project.clips, phrases, clip)) return null;

    set({ project: recompiled({ ...project, phrases, clips: [...project.clips, clip] }) });
    return clip.id;
  },

  /**
   * Give one placement a private copy of its phrase.
   *
   * The point of linked placements is that fixing the chorus fixes every chorus; the
   * point of this is the moment the last chorus wants a different ending. A phrase with
   * only one placement is left alone — it is already unique, and copying it would leave
   * an identical orphan behind in the library for nothing.
   */
  makeClipUnique: (clipId: string) => {
    const project = get().project;
    if (!project) return;
    const clip = project.clips.find(c => c.id === clipId);
    if (!clip) return;
    const phrase = phraseById(project.phrases, clip.phraseId);
    if (!phrase) return;
    if (project.clips.filter(c => c.phraseId === phrase.id).length < 2) return;

    const copy = clonePhrase(phrase, uniquePhraseName(project.phrases, phrase.name));
    set({
      project: recompiled({
        ...project,
        phrases: [...project.phrases, copy],
        clips: project.clips.map(c => (c.id === clipId ? { ...c, phraseId: copy.id } : c)),
      }),
      // Follow the block that was just split, so the next edit lands on the copy the
      // user made it for rather than on the original they were trying to leave alone.
      editingPhraseId: get().editingPhraseId === phrase.id ? copy.id : get().editingPhraseId,
    });
  },

  /**
   * Move a placement to another bar, another row, or both.
   *
   * A move onto an occupied span is refused outright and the block stays where it was.
   * There is nothing to trim — a phrase is as long as it is — so the alternative would
   * be deleting whatever was already there, which is a great deal to lose for a drag
   * that went one bar too far.
   */
  moveClip: (clipId: string, trackId: string, startBar: number) => {
    const project = get().project;
    if (!project) return;
    const clip = project.clips.find(c => c.id === clipId);
    if (!clip) return;
    if (!project.tracks.some(t => t.id === trackId)) return;
    if (clip.trackId === trackId && clip.startBar === startBar) return;
    if (!canPlaceClip(project.clips, project.phrases, { ...clip, trackId, startBar })) return;

    set({
      project: recompiled({
        ...project,
        clips: project.clips.map(c => (c.id === clipId ? { ...c, trackId, startBar } : c)),
      }),
    });
  },

  /** Remove a placement. Its phrase survives, unplaced, in the library. */
  removeClip: (clipId: string) => {
    const project = get().project;
    if (!project) return;
    if (!project.clips.some(c => c.id === clipId)) return;
    set({
      project: recompiled({ ...project, clips: project.clips.filter(c => c.id !== clipId) }),
    });
  },

  renamePhrase: (phraseId: string, name: string) => {
    const project = get().project;
    if (!project) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const phrase = phraseById(project.phrases, phraseId);
    if (!phrase || phrase.name === trimmed) return;
    set({
      project: {
        ...project,
        phrases: project.phrases.map(p => (p.id === phraseId ? { ...p, name: trimmed } : p)),
        updatedAt: new Date(),
      },
    });
  },

  setPhraseColor: (phraseId: string, color: string) => {
    const project = get().project;
    if (!project) return;
    const phrase = phraseById(project.phrases, phraseId);
    if (!phrase || phrase.color === color) return;
    set({
      project: {
        ...project,
        phrases: project.phrases.map(p => (p.id === phraseId ? { ...p, color } : p)),
        updatedAt: new Date(),
      },
    });
  },

  /**
   * Grow or shrink a phrase — the resize grip on a block.
   *
   * Every placement changes length at once, because they are all the one phrase. A
   * placement the growth runs into is pushed along by `relocateOverlaps` rather than
   * the resize being refused: unlike a drag, which names a destination, a resize names
   * only a length, and there is a way to honour it that costs nothing.
   */
  setPhraseLength: (phraseId: string, lengthBars: number) => {
    const project = get().project;
    if (!project) return;
    const phrase = phraseById(project.phrases, phraseId);
    if (!phrase || !Number.isFinite(lengthBars)) return;
    const resized = resizePhrase(phrase, lengthBars);
    if (resized === phrase) return;

    set({
      project: recompiled({
        ...project,
        phrases: project.phrases.map(p => (p.id === phraseId ? resized : p)),
      }),
    });
  },

  /**
   * Make room inside a phrase — the insert-bars menu on the phrase editor's ruler.
   *
   * The phrase-side counterpart of `insertBar`, and it means the same thing one level
   * down: the bars from the clicked one on slide along, carrying their blocks and the
   * phrase's curves with them, and what is left behind is silence. Where `insertBar`
   * moves the placements so the song underneath them does not change, this changes the
   * placements' *length* — they are all the one phrase, so every one of them grows.
   *
   * Refuses nothing, for the reason `removePhraseBarAt` gives: a phrase's bars carry
   * only its own material. A placement the growth runs into is pushed along by
   * `relocateOverlaps` inside `recompiled`, exactly as it is for `setPhraseLength`.
   */
  insertPhraseBarsAt: (phraseId: string, index: number, count: number) => {
    const project = get().project;
    if (!project) return;
    const phrase = phraseById(project.phrases, phraseId);
    if (!phrase || !Number.isFinite(index) || !Number.isFinite(count)) return;
    const grown = insertPhraseBars(phrase, index, count, project.timeSignature);
    if (grown === phrase) return;

    set({
      project: recompiled({
        ...project,
        phrases: project.phrases.map(p => (p.id === phraseId ? grown : p)),
      }),
    });
  },

  /**
   * Take one bar out of a phrase — Remove Bar, with a phrase open.
   *
   * The bar cursor sits on a phrase bar while the editor is up, so the panel's button
   * has to mean that bar and not the song bar underneath it, which belongs to whatever
   * else is playing at the same time.
   *
   * Unlike `removeBar`, this refuses nothing: a phrase's bars carry only its own
   * material, so there is no placement over them to be orphaned. The one bar it will
   * not take is the last, which `removePhraseBar` guards. The metre goes in because
   * the phrase's curves close up with its bars, and they are measured in beats.
   */
  removePhraseBarAt: (phraseId: string, barId: string) => {
    const project = get().project;
    if (!project) return;
    const phrase = phraseById(project.phrases, phraseId);
    if (!phrase) return;
    const shortened = removePhraseBar(phrase, barId, project.timeSignature);
    if (shortened === phrase) return;

    set({
      project: recompiled({
        ...project,
        phrases: project.phrases.map(p => (p.id === phraseId ? shortened : p)),
      }),
    });
  },

  /**
   * Take a run of bars out of a phrase — Remove on the phrase editor's ruler menu.
   *
   * `removePhraseBarAt` by position and length, and it refuses on the same terms:
   * nothing, except a run that would leave the phrase with no bars at all.
   */
  removePhraseBarsAt: (phraseId: string, index: number, count: number) => {
    const project = get().project;
    if (!project) return;
    const phrase = phraseById(project.phrases, phraseId);
    if (!phrase || !Number.isFinite(index) || !Number.isFinite(count)) return;
    const shortened = removePhraseBars(phrase, index, count, project.timeSignature);
    if (shortened === phrase) return;

    set({
      project: recompiled({
        ...project,
        phrases: project.phrases.map(p => (p.id === phraseId ? shortened : p)),
      }),
    });
  },

  /** Remove a phrase outright, and with it every placement of it. */
  removePhrase: (phraseId: string) => {
    const project = get().project;
    if (!project) return;
    if (!phraseById(project.phrases, phraseId)) return;
    set({
      project: recompiled({
        ...project,
        phrases: project.phrases.filter(p => p.id !== phraseId),
        clips: project.clips.filter(c => c.phraseId !== phraseId),
      }),
      editingPhraseId: get().editingPhraseId === phraseId ? null : get().editingPhraseId,
      editingClipId: get().editingPhraseId === phraseId ? null : get().editingClipId,
    });
  },

  resetProject: () => {
    set({ project: null, editingPhraseId: null, editingClipId: null });
    showView('arrangement');
    // The auto-save described a project that no longer exists, so it goes with it —
    // otherwise the next start-up would offer to recover the piece just discarded.
    clearLocalStorage();
  },

  // Recording gate: execute `fn` while recording mode is active — pushState
  // in the middleware is silenced so only the key-up recordSegment commits
  // a single history entry for the whole take.
  withRecording: (fn: () => void) => {
    if (recordingGate) {
      recordingGate(true);
      try {
        fn();
      } finally {
        recordingGate(false);
      }
    } else {
      fn();
    }
  },
}));
