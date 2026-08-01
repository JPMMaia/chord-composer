import { create } from 'zustand';
import type {
  Project,
  Bar,
  ChordSegment,
  NoteName,
  Scale,
  ScaleType,
  TimeSignature,
} from '@/types/music';
import { generateId } from '@/utils/id';
import {
  clampToBar,
  getBarBeats,
  getTotalBeats,
  isValidTimeSignature,
  MIN_SEGMENT_BEATS,
  placeSegmentInBar,
  refitBars,
  removeSegmentById,
  resizeSegment,
  withStartBeats,
} from '@/engine/timeline';
import {
  cycleSegmentInversion,
  generateNotesFromSegments,
  retuneSegmentsToScale,
  shiftSegmentOctave,
  stepSegmentInScale,
} from '@/engine/chordOperations';
import {
  DEFAULT_BPM,
  DEFAULT_TIME_SIGNATURE,
  DEFAULT_KEY,
  DEFAULT_KEY_MODE,
} from '@/utils/constants';

interface ProjectState {
  project: Project | null;
  createProject: () => void;
  loadProject: (project: Project) => void;
  setBpm: (bpm: number) => void;
  setTimeSignature: (ts: TimeSignature) => void;
  setKey: (key: NoteName, mode?: 'major' | 'minor') => void;
  addBar: () => void;
  removeBar: (barId: string) => void;
  updateBarScale: (barId: string, scale: { root: NoteName; type: ScaleType }) => void;
  setBarTimeSignature: (barId: string, ts: TimeSignature) => void;
  insertSegment: (barId: string, startBeat: number, segment: ChordSegment) => void;
  removeSegment: (segmentId: string) => void;
  moveSegment: (segmentId: string, targetBarId: string, startBeat: number) => void;
  resizeSegmentDuration: (segmentId: string, duration: number) => void;
  stepSegmentPitch: (segmentId: string, direction: -1 | 1) => void;
  shiftSegmentOctave: (segmentId: string, direction: -1 | 1) => void;
  cycleSegmentInversion: (segmentId: string) => void;
  setLoopRegion: (start: number | null, end: number | null) => void;
  toggleLoopEnabled: () => void;
  resetProject: () => void;
}

/** Octave the generated chord roots sit in — the middle-C octave. */
const GENERATED_NOTE_OCTAVE = 4;

/**
 * Regenerate every bar's notes from its segments.
 *
 * `bar.notes` is derived state: this is what keeps the piano roll in step with the
 * chord panel. Running it over all bars rather than only the edited one is what makes
 * overflow correct — a segment pushed across a bar line changes two bars at once.
 */
function withGeneratedNotes(bars: Bar[], projectTs: TimeSignature): Bar[] {
  return bars.map(bar => ({
    ...bar,
    notes: generateNotesFromSegments(bar, projectTs, GENERATED_NOTE_OCTAVE),
  }));
}

/**
 * Rebuild the project from a set of bars: refit them so every segment sits inside
 * its bar without overlapping, then resync the derived notes. Every segment mutation
 * funnels through here so no caller can skip either step.
 */
function applyBars(project: Project, bars: Bar[]): Project {
  const refitted = refitBars(bars, project.timeSignature);
  return {
    ...project,
    bars: withGeneratedNotes(refitted, project.timeSignature),
    updatedAt: new Date(),
  };
}

/**
 * Rewrite one bar's segments, leaving every other bar alone. The refit that follows
 * still sees the whole project, so a change here can still spill into later bars.
 */
function mapBar(bars: Bar[], barId: string, fn: (bar: Bar) => ChordSegment[]): Bar[] {
  return bars.map(bar => (bar.id === barId ? { ...bar, chords: fn(bar) } : bar));
}

/**
 * Drop `segment` into a bar at `startBeat`, rippling whatever it lands on.
 *
 * Blocks the ripple pushes off the end are parked at the bar line rather than
 * discarded; the refit that follows is what carries them into the next bar.
 */
function placedIn(bar: Bar, segment: ChordSegment, startBeat: number, capacity: number) {
  const { kept, overflow } = placeSegmentInBar(
    bar.chords,
    segment,
    clampToBar(startBeat, segment.duration, capacity),
    capacity
  );
  return [...kept, ...overflow.map(s => ({ ...s, startBeat: capacity }))];
}

/**
 * Rewrite a single segment in place, leaving where it sits alone.
 *
 * The transform is handed the scale of the bar the segment actually lives in,
 * which is what lets "the next note of the scale" mean the right thing in a
 * project whose bars are in different keys. Only the derived notes are resynced:
 * none of these edits moves a block along the timeline, so unlike `applyBars`
 * there is nothing here for `refitBars` to refit.
 *
 * Returns null when no bar holds the segment, so the caller can leave the store
 * untouched rather than publishing an identical project.
 */
function withTransformedSegment(
  project: Project,
  segmentId: string,
  transform: (segment: ChordSegment, scale: Scale) => ChordSegment
): Project | null {
  const owner = project.bars.find(b => b.chords.some(c => c.id === segmentId));
  if (!owner) return null;

  const bars = project.bars.map(bar =>
    bar.id === owner.id
      ? {
          ...bar,
          chords: bar.chords.map(c => (c.id === segmentId ? transform(c, bar.scale) : c)),
        }
      : bar
  );

  return {
    ...project,
    bars: withGeneratedNotes(bars, project.timeSignature),
    updatedAt: new Date(),
  };
}

const createInitialProject = (): Project => ({
  id: generateId(),
  name: 'Untitled',
  bpm: DEFAULT_BPM,
  timeSignature: DEFAULT_TIME_SIGNATURE,
  key: DEFAULT_KEY,
  keyMode: DEFAULT_KEY_MODE,
  tracks: [],
  bars: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});

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
        bars: project.bars.map(bar => ({ ...bar, chords: withStartBeats(bar.chords) })),
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
      scale: { root: project.key, type: project.keyMode === 'minor' ? 'naturalMinor' : 'major' },
      chords: [],
      notes: [],
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

  updateBarScale: (barId: string, scale: { root: NoteName; type: ScaleType }) => {
    const project = get().project;
    if (!project) return;
    const barIndex = project.bars.findIndex(b => b.id === barId);
    if (barIndex === -1) {
      throw new Error('Bar not found');
    }
    const newBars = project.bars.map((b, i) => {
      if (i !== barIndex) return b;
      const nextScale = { root: scale.root, type: scale.type };
      // Diatonic segments name a scale degree, so a change of scale has to move them
      // onto the new key's chord for that degree — and their notes with them.
      return {
        ...b,
        scale: nextScale,
        chords: retuneSegmentsToScale(b.chords, b.scale, nextScale),
      };
    });
    set({
      project: {
        ...project,
        bars: withGeneratedNotes(newBars, project.timeSignature),
        updatedAt: new Date(),
      },
    });
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

  insertSegment: (barId: string, startBeat: number, segment: ChordSegment) => {
    const project = get().project;
    if (!project) return;
    const target = project.bars.find(b => b.id === barId);
    // A drop that missed every bar is a sloppy gesture, not an error.
    if (!target) return;

    const capacity = getBarBeats(target, project.timeSignature);
    const bars = mapBar(project.bars, barId, bar =>
      placedIn(bar, segment, startBeat, capacity)
    );
    set({ project: applyBars(project, bars) });
  },

  removeSegment: (segmentId: string) => {
    const project = get().project;
    if (!project) return;
    // The space it occupied stays empty — a deleted block leaves a rest behind.
    const bars = project.bars.map(bar => ({
      ...bar,
      chords: removeSegmentById(withStartBeats(bar.chords), segmentId),
    }));
    set({ project: applyBars(project, bars) });
  },

  moveSegment: (segmentId: string, targetBarId: string, startBeat: number) => {
    const project = get().project;
    if (!project) return;

    const source = project.bars.find(b => b.chords.some(c => c.id === segmentId));
    const target = project.bars.find(b => b.id === targetBarId);
    if (!source || !target) return;

    const moved = source.chords.find(c => c.id === segmentId)!;
    const capacity = getBarBeats(target, project.timeSignature);

    // Lift it out of its old bar first, so a move within one bar does not see a
    // stale copy of itself to ripple against.
    const lifted = project.bars.map(bar =>
      bar.id === source.id
        ? { ...bar, chords: removeSegmentById(withStartBeats(bar.chords), segmentId) }
        : bar
    );

    const bars = mapBar(lifted, targetBarId, bar =>
      placedIn(bar, moved, startBeat, capacity)
    );
    set({ project: applyBars(project, bars) });
  },

  resizeSegmentDuration: (segmentId: string, duration: number) => {
    const project = get().project;
    if (!project) return;
    const owner = project.bars.find(b => b.chords.some(c => c.id === segmentId));
    if (!owner) return;

    const chords = withStartBeats(owner.chords);
    // A block grows into the space in front of it, not into the whole bar: it is
    // pinned where it sits, so the bar line is what caps it.
    const start = chords.find(c => c.id === segmentId)!.startBeat!;
    const maxBeats = getBarBeats(owner, project.timeSignature) - start;

    const bars = mapBar(project.bars, owner.id, () =>
      resizeSegment(chords, segmentId, duration, maxBeats)
    );
    set({ project: applyBars(project, bars) });
  },

  /** Move the segment one step along its bar's scale — the up and down arrows. */
  stepSegmentPitch: (segmentId: string, direction: -1 | 1) => {
    const project = get().project;
    if (!project) return;
    const next = withTransformedSegment(project, segmentId, (segment, scale) =>
      stepSegmentInScale(segment, scale, direction)
    );
    if (next) set({ project: next });
  },

  /** Move the segment a whole octave — the + and - keys. */
  shiftSegmentOctave: (segmentId: string, direction: -1 | 1) => {
    const project = get().project;
    if (!project) return;
    const next = withTransformedSegment(project, segmentId, segment =>
      shiftSegmentOctave(segment, direction)
    );
    if (next) set({ project: next });
  },

  /** Advance a chord to its next inversion, wrapping to root position — the `i` key. */
  cycleSegmentInversion: (segmentId: string) => {
    const project = get().project;
    if (!project) return;
    const next = withTransformedSegment(project, segmentId, cycleSegmentInversion);
    if (next) set({ project: next });
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
}));
