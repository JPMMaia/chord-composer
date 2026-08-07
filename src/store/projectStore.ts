import { create } from 'zustand';
import type {
  Bar,
  ChordSegment,
  NoteName,
  Project,
  Scale,
  SegmentBreak,
  SpacingPreset,
  TimeSignature,
  Track,
} from '@/types/music';
import type { CopiedSegment } from './clipboardStore';
import { generateId } from '@/utils/id';
import {
  barChords,
  clampStartToBar,
  clearRange,
  findSegment,
  getBarIndexAtBeat,
  getBarBeats,
  getBarStartBeat,
  getTotalBeats,
  isValidTimeSignature,
  mapBarChords,
  MIN_SEGMENT_BEATS,
  placeSegmentInBar,
  refitBars,
  removeSegmentById,
  resizeSegment,
  withoutTrackContent,
  withStartBeats,
} from '@/engine/timeline';
import {
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

/** Gate set by App.tsx to silence middleware pushState during recording takes. */
let recordingGate: ((active: boolean) => void) | undefined;

/** Call from App.tsx to bridge the middleware's setRecording into the store. */
export function setRecordingGate(fn: (active: boolean) => void) {
  recordingGate = fn;
}

/** One block's destination in a batch move. */
export interface SegmentMove {
  segmentId: string;
  targetBarId: string;
  startBeat: number;
}

interface ProjectState {
  project: Project | null;
  createProject: () => void;
  loadProject: (project: Project) => void;
  setBpm: (bpm: number) => void;
  setTimeSignature: (ts: TimeSignature) => void;
  setKey: (key: NoteName, mode?: 'major' | 'minor') => void;
  addBar: () => void;
  removeBar: (barId: string) => void;
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
  moveSegment: (segmentId: string, targetBarId: string, startBeat: number) => void;
  moveSegments: (moves: SegmentMove[]) => void;
  resizeSegmentDuration: (segmentId: string, duration: number) => void;
  // Instruments. Tracks live here rather than in a store of their own so they
  // ride along with undo, autosave and project load like everything else.
  /** Returns the new instrument's id, so the caller can select it. */
  addTrack: (name?: string) => string | null;
  removeTrack: (trackId: string) => void;
  renameTrack: (trackId: string, name: string) => void;
  setTrackInstrument: (trackId: string, instrument: string) => void;
  setTrackVolume: (trackId: string, volume: number) => void;
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
  clearSegmentVoicing: (segmentId: string) => void;
  setSegmentsInversion: (segmentIds: string[], inversion: number) => void;
  setSegmentsSpacing: (segmentIds: string[], preset: SpacingPreset) => void;
  setSegmentsToneOffset: (segmentIds: string[], tone: number, offsetOctaves: number) => void;
  toggleSegmentsDoubling: (segmentIds: string[], tone: number, octaves: 1 | -1) => void;
  setSegmentsBreak: (segmentIds: string[], spec: SegmentBreak | null) => void;
  clearSegmentsVoicing: (segmentIds: string[]) => void;
  convertSegmentsKind: (
    segmentIds: string[],
    target: import('@/engine/chordOperations').SegmentKindTarget
  ) => void;
  setLoopRegion: (start: number | null, end: number | null) => void;
  /** Clone an instrument and all its chord segments. Returns the new instrument's id. */
  duplicateTrack: (sourceTrackId: string) => string | null;
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
function applyBars(project: Project, bars: Bar[]): Project {
  const trackIds = project.tracks.map(t => t.id);
  const refitted = refitBars(bars, project.timeSignature, trackIds);
  return {
    ...project,
    bars: withGeneratedNotes(refitted, project.timeSignature, keyScale(project)),
    updatedAt: new Date(),
  };
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

/** The instrument whose content holds a segment, or null if no instrument does. */
function trackIdOfSegment(bars: Bar[], segmentId: string): string | null {
  return findSegment(bars, segmentId)?.trackId ?? null;
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
  segmentIds: string[],
  transform: (segment: ChordSegment, scale: Scale) => ChordSegment
): Project | null {
  const targets = new Set(segmentIds);
  if (targets.size === 0) return null;

  // Searches every instrument's content rather than being told which one to look
  // in: a selection is always within one instrument, but finding the ids is cheap
  // and saves threading a track id through the keyboard-shortcut hooks.
  let matched = false;
  const bars = project.bars.map(bar => {
    const content = Object.entries(bar.content);
    if (!content.some(([, c]) => c.chords.some(s => targets.has(s.id)))) return bar;
    matched = true;
    return {
      ...bar,
      content: Object.fromEntries(
        content.map(([trackId, trackContent]) => [
          trackId,
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

  return {
    ...project,
    bars: withGeneratedNotes(bars, project.timeSignature, keyScale(project)),
    updatedAt: new Date(),
  };
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
  bars: [],
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
  set({
    project: {
      ...project,
      tracks: project.tracks.map(t => (t.id === trackId ? { ...t, ...patch(t) } : t)),
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
    // them is what those files always meant.
    set({
      project: {
        ...project,
        bars: project.bars.map(bar => ({
          ...bar,
          content: Object.fromEntries(
            Object.entries(bar.content).map(([trackId, content]) => [
              trackId,
              { ...content, chords: withStartBeats(content.chords) },
            ])
          ),
        })),
      },
    });
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
    set({
      project: {
        ...project,
        bars: [...project.bars, newBar],
        updatedAt: new Date(),
      },
    });
  },

  removeBar: (barId: string) => {
    const project = get().project;
    if (!project) return;
    const barIndex = project.bars.findIndex(b => b.id === barId);
    if (barIndex === -1) {
      throw new Error('Bar not found');
    }
    const newBars = project.bars.filter(b => b.id !== barId).map((b, i) => ({ ...b, barIndex: i }));
    set({
      project: {
        ...project,
        bars: newBars,
        updatedAt: new Date(),
      },
    });
  },

  setSegmentsScale: (segmentIds: string[], patch: Partial<Scale>) => {
    const project = get().project;
    if (!project) return;
    // Diatonic segments name a scale degree, so a change of key has to move them
    // onto the new key's chord for that degree — and their notes with them. Only
    // the selected blocks move; their neighbours keep the key they were written in.
    const next = withTransformedSegments(project, segmentIds, (segment, current) => {
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
    // The bar's capacity just changed, so its contents may no longer fit.
    set({ project: applyBars(project, bars) });
  },

  insertSegment: (barId: string, startBeat: number, segment: ChordSegment, trackId: string) => {
    const project = get().project;
    if (!project) return;
    const target = project.bars.find(b => b.id === barId);
    // A drop that missed every bar is a sloppy gesture, not an error.
    if (!target) return;
    // Likewise a drop with no instrument to land on.
    if (!project.tracks.some(t => t.id === trackId)) return;

    const capacity = getBarBeats(target, project.timeSignature);
    const bars = mapBar(project.bars, barId, trackId, chords =>
      placedIn(chords, segment, startBeat, capacity)
    );
    set({ project: applyBars(project, bars) });
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
   */
  recordSegment: (trackId, startBeat, segment, onCommit) => {
    const project = get().project;
    if (!project) return;
    if (!project.tracks.some(t => t.id === trackId)) return;
    // Recording is bounded by the song: bars are added deliberately, not by holding
    // a key down past the last one.
    if (startBeat < 0 || startBeat >= getTotalBeats(project.bars, project.timeSignature)) return;

    const barIndex = getBarIndexAtBeat(project.bars, project.timeSignature, startBeat);
    const target = project.bars[barIndex];
    const offset = getBarStartBeat(project.bars, barIndex, project.timeSignature);

    const cleared = clearRange(
      project.bars,
      project.timeSignature,
      trackId,
      startBeat,
      startBeat + segment.duration,
      segment.id
    );
    // Lift any earlier copy of the take out first, so a shrinking one leaves no
    // stale remains behind for the ripple in `placedIn` to find.
    const lifted = cleared.map(bar =>
      trackId in bar.content
        ? mapBarChords(bar, trackId, chords =>
            removeSegmentById(withStartBeats(chords), segment.id)
          )
        : bar
    );

    const capacity = getBarBeats(target, project.timeSignature);
    const bars = mapBar(lifted, target.id, trackId, chords =>
      placedIn(chords, segment, startBeat - offset, capacity)
    );
    const next = applyBars(project, bars);
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

    // Grouped by instrument, because a segment id only means something inside the
    // track that holds it — and a selection may in principle span several.
    const byTrack = new Map<string, string[]>();
    for (const segmentId of segmentIds) {
      const trackId = trackIdOfSegment(project.bars, segmentId);
      if (!trackId) continue;
      const ids = byTrack.get(trackId);
      if (ids) ids.push(segmentId);
      else byTrack.set(trackId, [segmentId]);
    }
    if (byTrack.size === 0) return;

    let bars = project.bars;
    for (const [trackId, ids] of byTrack) {
      bars = bars.map(bar =>
        trackId in bar.content
          ? mapBarChords(bar, trackId, chords =>
              ids.reduce(
                (remaining, id) => removeSegmentById(remaining, id),
                withStartBeats(chords)
              )
            )
          : bar
      );
    }
    set({ project: applyBars(project, bars) });
  },

  moveSegment: (segmentId: string, targetBarId: string, startBeat: number) => {
    get().moveSegments([{ segmentId, targetBarId, startBeat }]);
  },

  /**
   * Reposition several blocks at once — what dragging a multi-selection commits.
   *
   * Every moved block is lifted out first, so blocks in the same bar never ripple
   * against stale copies of themselves or of each other. They are then placed in
   * ascending destination order, which makes the ripple deterministic regardless
   * of the order the caller listed them in, and the whole batch ends in a single
   * refit — one visual step, one history entry.
   */
  moveSegments: (moves: SegmentMove[]) => {
    const project = get().project;
    if (!project) return;
    if (moves.length === 0) return;

    const barIndexById = new Map(project.bars.map((bar, index) => [bar.id, index]));

    // A drag only ever moves blocks belonging to the instrument being edited, so
    // the whole batch is resolved against one track. It is found from the first
    // move that names a *live* segment, not simply the first move: a stale id is
    // skipped rather than being allowed to abandon the whole gesture.
    const trackId = moves.reduce<string | null>(
      (found, move) => found ?? trackIdOfSegment(project.bars, move.segmentId),
      null
    );
    if (!trackId) return;

    // Drop moves whose block or destination no longer exists rather than failing
    // the whole gesture: a stale selection is a sloppy state, not an error.
    const resolved = moves
      .map(move => ({
        move,
        segment: project.bars
          .flatMap(bar => withStartBeats(barChords(bar, trackId)))
          .find(c => c.id === move.segmentId),
      }))
      .filter(
        (entry): entry is { move: SegmentMove; segment: ChordSegment } =>
          entry.segment !== undefined && barIndexById.has(entry.move.targetBarId)
      );
    if (resolved.length === 0) return;

    const movedIds = new Set(resolved.map(entry => entry.move.segmentId));
    let bars = project.bars.map(bar =>
      trackId in bar.content
        ? mapBarChords(bar, trackId, chords =>
            withStartBeats(chords).filter(c => !movedIds.has(c.id))
          )
        : bar
    );

    const ordered = [...resolved].sort(
      (a, b) =>
        barIndexById.get(a.move.targetBarId)! - barIndexById.get(b.move.targetBarId)! ||
        a.move.startBeat - b.move.startBeat
    );

    for (const { move, segment } of ordered) {
      const target = bars.find(bar => bar.id === move.targetBarId)!;
      const capacity = getBarBeats(target, project.timeSignature);
      bars = mapBar(bars, move.targetBarId, trackId, chords =>
        placedIn(chords, segment, move.startBeat, capacity)
      );
    }

    set({ project: applyBars(project, bars) });
  },

  resizeSegmentDuration: (segmentId: string, duration: number) => {
    const project = get().project;
    if (!project) return;
    const trackId = trackIdOfSegment(project.bars, segmentId);
    if (!trackId) return;
    const owner = project.bars.find(b =>
      barChords(b, trackId).some(c => c.id === segmentId)
    );
    if (!owner) return;

    const chords = withStartBeats(barChords(owner, trackId));
    // A block grows into the space in front of it, and may run straight through the
    // bar line to do it — a chord held over the barline is ordinary music. What it
    // cannot outlast is the song, so the end of the last bar is the cap.
    const start = chords.find(c => c.id === segmentId)!.startBeat!;
    const absoluteStart =
      getBarStartBeat(project.bars, project.bars.indexOf(owner), project.timeSignature) + start;
    const maxBeats = getTotalBeats(project.bars, project.timeSignature) - absoluteStart;

    const bars = mapBar(project.bars, owner.id, trackId, () =>
      resizeSegment(chords, segmentId, duration, maxBeats)
    );
    set({ project: applyBars(project, bars) });
  },

  /** Move every named segment one step along its own bar's scale — the up and down arrows. */
  stepSegmentsPitch: (segmentIds: string[], direction: -1 | 1) => {
    const project = get().project;
    if (!project) return;
    const next = withTransformedSegments(project, segmentIds, (segment, scale) =>
      stepSegmentInScale(segment, scale, direction)
    );
    if (next) set({ project: next });
  },

  /** Move every named segment a whole octave — the + and - keys. */
  shiftSegmentsOctave: (segmentIds: string[], direction: -1 | 1) => {
    const project = get().project;
    if (!project) return;
    const next = withTransformedSegments(project, segmentIds, segment =>
      shiftSegmentOctave(segment, direction)
    );
    if (next) set({ project: next });
  },

  /** Advance each chord to its next inversion, wrapping to root position — the `i` key. */
  cycleSegmentsInversion: (segmentIds: string[]) => {
    const project = get().project;
    if (!project) return;
    const next = withTransformedSegments(project, segmentIds, cycleSegmentInversion);
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
    const next = withTransformedSegments(project, segmentIds, (segment, scale) =>
      withInversion(segment, scale, inversion)
    );
    if (next) set({ project: next });
  },

  /** Space each chord by a preset, seeding the per-tone offsets it implies. */
  setSegmentsSpacing: (segmentIds: string[], preset: SpacingPreset) => {
    const project = get().project;
    if (!project) return;
    const next = withTransformedSegments(project, segmentIds, (segment, scale) =>
      withSpacing(segment, scale, preset)
    );
    if (next) set({ project: next });
  },

  /** Move one chord tone by whole octaves, which makes the voicing custom. */
  setSegmentsToneOffset: (segmentIds: string[], tone: number, offsetOctaves: number) => {
    const project = get().project;
    if (!project) return;
    const next = withTransformedSegments(project, segmentIds, segment =>
      withToneOffset(segment, tone, offsetOctaves)
    );
    if (next) set({ project: next });
  },

  /** Add or remove a doubled copy of one chord tone. */
  toggleSegmentsDoubling: (segmentIds: string[], tone: number, octaves: 1 | -1) => {
    const project = get().project;
    if (!project) return;
    const next = withTransformedSegments(project, segmentIds, segment =>
      withToggledDoubling(segment, tone, octaves)
    );
    if (next) set({ project: next });
  },

  /** Arpeggiate or strum each chord; null returns it to a block chord. */
  setSegmentsBreak: (segmentIds: string[], spec: SegmentBreak | null) => {
    const project = get().project;
    if (!project) return;
    const next = withTransformedSegments(project, segmentIds, segment =>
      withBreak(segment, spec)
    );
    if (next) set({ project: next });
  },

  /** Return each chord to close position, sounded as a block. */
  clearSegmentsVoicing: (segmentIds: string[]) => {
    const project = get().project;
    if (!project) return;
    const next = withTransformedSegments(project, segmentIds, withoutVoicing);
    if (next) set({ project: next });
  },

  /** Convert segments between note, triad, and seventh kinds. */
  convertSegmentsKind: (segmentIds, target) => {
    const project = get().project;
    if (!project) return;
    const next = withTransformedSegments(project, segmentIds, (segment, scale) =>
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

  /** Remove an instrument and everything it played. */
  removeTrack: (trackId: string) => {
    const project = get().project;
    if (!project) return;
    if (!project.tracks.some(t => t.id === trackId)) return;
    set({
      project: {
        ...project,
        tracks: project.tracks.filter(t => t.id !== trackId),
        bars: withoutTrackContent(project.bars, trackId),
        updatedAt: new Date(),
      },
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
      instrument: source.instrument,
      volume: source.volume,
      pan: source.pan,
      muted: source.muted,
      solo: source.solo,
      visible: source.visible,
      color: trackColorAt(sourceIndex + 1),
    };

    // Build the tracks array with the copy inserted after the source.
    const newTracks = [
      ...project.tracks.slice(0, sourceIndex + 1),
      newTrack,
      ...project.tracks.slice(sourceIndex + 1),
    ];

    // Deep-copy chord segments for every bar that the source has content in.
    const newBars = project.bars.map(bar => {
      const sourceContent = bar.content[sourceTrackId];
      if (!sourceContent) return bar;

      const clonedChords = sourceContent.chords.map(seg => ({
        ...seg,
        id: generateId(),
      }));

      return {
        ...bar,
        content: {
          ...bar.content,
          [newId]: { chords: clonedChords, notes: [] },
        },
      };
    });

    const next = {
      ...project,
      tracks: newTracks,
    };

    set({ project: applyBars(next, newBars) });
    return newId;
  },

  /** Paste clipboard segments into the project at the given bar offset. */
  pasteSegments: (segments, trackId, offsetBarIndex, targetStartBeat = 0) => {
    const project = get().project;
    if (!project) return null;
    if (segments.length === 0) return null;
    if (!project.tracks.some(t => t.id === trackId)) return null;

    // Ensure enough bars exist for the paste destination.
    let bars = [...project.bars];
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

      bars = mapBar(bars, targetBar.id, trackId, chords =>
        placedIn(chords, newSegment, adjustedStartBeat, capacity)
      );
      newSegmentIds.push(newSegment.id);
    }

    set({ project: applyBars(project, bars) });
    return newSegmentIds.length > 0 ? newSegmentIds : null;
  },

  resetProject: () => {
    set({ project: null });
    // Clear autosave
    try {
      localStorage.removeItem('chord-composer-autosave');
    } catch {
      // Ignore localStorage errors
    }
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
