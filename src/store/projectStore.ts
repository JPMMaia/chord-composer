import { create } from 'zustand';
import type {
  Project,
  Bar,
  ChordSegment,
  NoteName,
  ScaleType,
  TimeSignature,
} from '@/types/music';
import { generateId } from '@/utils/id';
import {
  flattenSegments,
  getBarBeats,
  insertSegmentAt,
  isValidTimeSignature,
  reflowSegments,
  removeSegmentById,
  resizeSegment,
} from '@/engine/timeline';
import {
  generateNotesFromSegments,
  reorderChords,
  retuneSegmentsToScale,
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
  insertSegment: (index: number, segment: ChordSegment) => void;
  removeSegment: (segmentId: string) => void;
  moveSegment: (fromIndex: number, toIndex: number) => void;
  resizeSegmentDuration: (segmentId: string, duration: number) => void;
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
 * Rebuild the project from a flat segment list: reflow it onto bars, then resync
 * the derived notes. Every segment mutation funnels through here so no caller can
 * skip either step.
 */
function applySegments(project: Project, segments: ChordSegment[]): Project {
  const bars = reflowSegments(segments, project.bars, project.timeSignature);
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
    set({ project });
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
    set({ project: applySegments({ ...project, bars }, flattenSegments(bars)) });
  },

  insertSegment: (index: number, segment: ChordSegment) => {
    const project = get().project;
    if (!project) return;
    const segments = insertSegmentAt(flattenSegments(project.bars), segment, index);
    set({ project: applySegments(project, segments) });
  },

  removeSegment: (segmentId: string) => {
    const project = get().project;
    if (!project) return;
    const segments = removeSegmentById(flattenSegments(project.bars), segmentId);
    set({ project: applySegments(project, segments) });
  },

  moveSegment: (fromIndex: number, toIndex: number) => {
    const project = get().project;
    if (!project) return;
    const segments = flattenSegments(project.bars);
    // Out-of-range drags are a normal outcome of a sloppy drop, not an error.
    if (
      fromIndex < 0 ||
      fromIndex >= segments.length ||
      toIndex < 0 ||
      toIndex >= segments.length
    ) {
      return;
    }
    set({ project: applySegments(project, reorderChords(segments, fromIndex, toIndex)) });
  },

  resizeSegmentDuration: (segmentId: string, duration: number) => {
    const project = get().project;
    if (!project) return;
    const owner = project.bars.find(b => b.chords.some(c => c.id === segmentId));
    if (!owner) return;
    // A segment can never outgrow the bar it lives in; beyond that the reflow decides
    // which bar it ends up in.
    const maxBeats = getBarBeats(owner, project.timeSignature);
    const segments = resizeSegment(flattenSegments(project.bars), segmentId, duration, maxBeats);
    set({ project: applySegments(project, segments) });
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
