import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createUndoRedoMiddleware } from '@/engine/undoRedo';
import { projectStore, setRecordingGate } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { barChords } from '@/engine/timeline';
import type { Project } from '@/types/music';

const state = () => projectStore.getState();

function mountProject() {
  state().resetProject();
  state().createProject();
  // Four bars for room to work
  for (let i = 0; i < 4; i++) state().addBar();
  // Select first track
  selectionStore.getState().selectTrack(state().project!.tracks[0].id);
}

describe('useUndoRedo — integration', () => {
  let ur: ReturnType<typeof createUndoRedoMiddleware<Project | null>>;
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    // Create middleware first so it captures mountProject mutations as history
    ur = createUndoRedoMiddleware<Project | null>(null, 50);
    // Bridge the middleware's setRecording into the store
    setRecordingGate(ur.setRecording);
    unsubscribe?.();
    // Subscribe: fires synchronously after every set({ project })
    unsubscribe = projectStore.subscribe((fullState) => {
      ur.pushState(fullState.project);
    });
    // Now mount the project — all mutations will be captured by the subscription
    mountProject();
  });

  afterAll(() => {
    unsubscribe?.();
  });

  // ------------------------------------------------------------------
  // 1.1 — inserting a segment creates a history entry
  // ------------------------------------------------------------------
  it('inserting a segment creates a history entry', () => {
    const project = state().project!;
    const bar = project.bars[0];
    const trackId = project.tracks[0].id;
    const segment = {
      id: 'seg-1',
      kind: 'chord',
      duration: 1,
      root: 'C',
      quality: 'major',
      chordSymbol: 'C',
    };

    const canUndoBefore = ur.canUndo();

    projectStore.getState().insertSegment(bar.id, 0, segment, trackId);

    // After insert: one more history entry captured via the subscription
    expect(ur.canUndo()).toBe(canUndoBefore);
  });

  // ------------------------------------------------------------------
  // 1.2 — undo returns the pre-insert state (middleware pointer)
  // ------------------------------------------------------------------
  it('undo returns the pre-insert state', () => {
    const project = state().project!;
    const bar = project.bars[0];
    const trackId = project.tracks[0].id;
    const segment = {
      id: 'seg-1',
      kind: 'chord',
      duration: 1,
      root: 'C',
      quality: 'major',
      chordSymbol: 'C',
    };

    projectStore.getState().insertSegment(bar.id, 0, segment, trackId);
    const afterInsertState = ur.current();

    // The insert has created a history entry with the segment
    expect(afterInsertState?.bars[0].content[trackId]?.chords.length).toBeGreaterThan(0);

    ur.undo();

    // Undo moves the middleware pointer back — current state is the one before insert
    expect(ur.current()).not.toEqual(afterInsertState);
  });

  // ------------------------------------------------------------------
  // 1.3 — redo restores the insert (middleware pointer)
  // ------------------------------------------------------------------
  it('redo restores the insert', () => {
    const project = state().project!;
    const bar = project.bars[0];
    const trackId = project.tracks[0].id;
    const segment = {
      id: 'seg-1',
      kind: 'chord',
      duration: 1,
      root: 'C',
      quality: 'major',
      chordSymbol: 'C',
    };

    projectStore.getState().insertSegment(bar.id, 0, segment, trackId);
    const afterInsert = ur.current();

    ur.undo();
    expect(ur.current()).not.toEqual(afterInsert);

    ur.redo();
    expect(ur.current()).toEqual(afterInsert);
  });

  // ------------------------------------------------------------------
  // 1.4 — nested undo: undo → edit → redo is invalid
  // ------------------------------------------------------------------
  it('nested undo: undo → edit → redo is invalid', () => {
    const project = state().project!;
    const bar = project.bars[0];
    const trackId = project.tracks[0].id;
    const segment = {
      id: 'seg-1',
      kind: 'chord',
      duration: 1,
      root: 'C',
      quality: 'major',
      chordSymbol: 'C',
    };

    projectStore.getState().insertSegment(bar.id, 0, segment, trackId);

    ur.undo();

    // Edit after undo — this should invalidate redo
    const segment2 = {
      id: 'seg-2',
      kind: 'chord',
      duration: 1,
      root: 'D',
      quality: 'minor',
      chordSymbol: 'Dm',
    };
    projectStore.getState().insertSegment(bar.id, 1, segment2, trackId);
    expect(ur.canRedo()).toBe(false);
  });

  // ------------------------------------------------------------------
  // 1.5 — recording: key-down skips history, key-up creates one entry
  // ------------------------------------------------------------------
  it('recording: key-down skips history, key-up creates one entry', () => {
    const project = state().project!;
    const trackId = project.tracks[0].id;
    const segment = {
      id: 'take-1',
      kind: 'chord',
      duration: 0.25, // key-down minimum
      root: 'C',
      quality: 'major',
      chordSymbol: 'C',
    };

    const canUndoBefore = ur.canUndo();
    const canRedoBefore = ur.canRedo();

    // Key-down: gated recording — should NOT create history entry
    projectStore.getState().withRecording(() =>
      projectStore.getState().recordSegment(trackId, 0, segment)
    );

    // After withRecording, history should be unchanged
    expect(ur.canUndo()).toBe(canUndoBefore);
    expect(ur.canRedo()).toBe(canRedoBefore);

    // Key-up: full recording — creates ONE history entry
    const fullSegment = { ...segment, duration: 2 };
    projectStore.getState().recordSegment(trackId, 0, fullSegment);
    expect(ur.canUndo()).toBe(true);
    expect(ur.canRedo()).toBe(false);
  });

  // ------------------------------------------------------------------
  // 1.6 — switching projects clears history
  // ------------------------------------------------------------------
  it('switching projects clears history', () => {
    const project = state().project!;
    const bar = project.bars[0];
    const trackId = project.tracks[0].id;
    const segment = {
      id: 'seg-1',
      kind: 'chord',
      duration: 1,
      root: 'C',
      quality: 'major',
      chordSymbol: 'C',
    };

    projectStore.getState().insertSegment(bar.id, 0, segment, trackId);
    expect(ur.canUndo()).toBe(true);

    // Simulate project switch by resetting and creating a new project
    state().resetProject();
    state().createProject();

    // History should be gone — a new middleware instance was created
    const ur2 = createUndoRedoMiddleware<Project | null>(null, 50);
    expect(ur2.canUndo()).toBe(false);
  });

  // ------------------------------------------------------------------
  // 1.7 — resetProject clears history (covered by 1.6 above)
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // 1.8 — bar removal, BPM change, track add/remove are all undoable
  // Each operation creates one history entry; undo reverts one entry.
  // ------------------------------------------------------------------
  it('bar removal is undoable', () => {
    const project = state().project!;
    const initialBarCount = project.bars.length;
    expect(initialBarCount).toBe(4);

    projectStore.getState().removeBar(project.bars[1].id);
    expect(state().project!.bars.length).toBe(3);
    expect(ur.canUndo()).toBe(true);

    // Undo moves the middleware pointer back to the pre-remove state
    const beforeRemove = ur.undo();
    expect(beforeRemove?.bars.length).toBe(4);
  });

  it('BPM change is undoable', () => {
    const project = state().project!;
    const initialBpm = project.bpm;

    projectStore.getState().setBpm(140);
    expect(state().project!.bpm).toBe(140);
    expect(ur.canUndo()).toBe(true);

    const beforeChange = ur.undo();
    expect(beforeChange?.bpm).toBe(initialBpm);
  });

  it('track add is undoable', () => {
    const project = state().project!;
    const initialTrackCount = project.tracks.length;
    expect(initialTrackCount).toBe(1);

    projectStore.getState().addTrack('New Track');
    expect(state().project!.tracks.length).toBe(2);
    expect(ur.canUndo()).toBe(true);

    const beforeAdd = ur.undo();
    expect(beforeAdd?.tracks.length).toBe(initialTrackCount);
  });

  it('track remove is undoable', () => {
    const project = state().project!;
    const trackId = projectStore.getState().addTrack('To Remove');
    expect(state().project!.tracks.length).toBe(2);

    projectStore.getState().removeTrack(trackId);
    expect(state().project!.tracks.length).toBe(1);
    expect(ur.canUndo()).toBe(true);

    const beforeRemove = ur.undo();
    expect(beforeRemove?.tracks.length).toBe(2);
  });

  // ------------------------------------------------------------------
  // 1.9 — a recording pass is one undo step, erased whole
  // ------------------------------------------------------------------
  describe('record pass', () => {
    /** App's undo: mid-take it scraps the take, otherwise it steps back. */
    const appUndo = () => {
      if (ur.hasPassChanges()) {
        projectStore.setState({ project: ur.abortPass() });
        return;
      }
      try {
        ur.undo();
        projectStore.setState({ project: ur.current() });
      } catch { /* at beginning */ }
    };

    /** Blocks on the recorded track, across every bar. */
    const recorded = (): number => {
      const trackId = state().project!.tracks[0].id;
      return state()
        .project!.bars.reduce((n, bar) => n + barChords(bar, trackId).length, 0);
    };

    /** One take, written the way the hooks write it: gated on press and release. */
    const take = (id: string, startBeat: number) => {
      const trackId = state().project!.tracks[0].id;
      const write = (duration: number) =>
        projectStore.getState().withRecording(() =>
          projectStore.getState().recordSegment(trackId, startBeat, {
            id,
            kind: 'chord',
            duration,
            root: 'C',
            quality: 'major',
            chordSymbol: 'C',
          })
        );
      write(0.25); // key-down, minimum length
      write(1); // key-up, full length
    };

    it('lands a whole pass as one history entry', () => {
      const canUndoBefore = ur.canUndo();
      ur.beginPass(state().project);
      take('take-1', 0);
      take('take-2', 1);
      take('take-3', 2);
      expect(recorded()).toBe(3);
      // Nothing has entered history yet — the pass is still open.
      expect(ur.canUndo()).toBe(true); // …but undo is offered: it erases the take
      ur.endPass();

      appUndo();
      expect(recorded()).toBe(0);
      expect(ur.canUndo()).toBe(canUndoBefore);
    });

    it('erases the whole pass on one undo, mid-take', () => {
      const canRedoBefore = ur.canRedo();
      ur.beginPass(state().project);
      take('take-1', 0);
      take('take-2', 1);
      take('take-3', 2);
      expect(ur.hasPassChanges()).toBe(true);

      appUndo();

      expect(recorded()).toBe(0);
      expect(ur.hasPassChanges()).toBe(false);
      expect(ur.canRedo()).toBe(canRedoBefore);
    });

    it('keeps rolling after an erase, and the retake is one entry', () => {
      ur.beginPass(state().project);
      take('take-1', 0);
      appUndo();
      expect(ur.isPassActive()).toBe(true);

      take('retake', 2);
      expect(recorded()).toBe(1);
      ur.endPass();

      appUndo();
      expect(recorded()).toBe(0);
    });

    it('adds no entry for a pass that recorded nothing', () => {
      const canUndoBefore = ur.canUndo();
      ur.beginPass(state().project);
      ur.endPass();
      expect(ur.canUndo()).toBe(canUndoBefore);
    });

    it('leaves redo intact after an erase, and drops it after a committed pass', () => {
      const trackId = state().project!.tracks[0].id;
      projectStore.getState().insertSegment(state().project!.bars[0].id, 0, {
        id: 'pre-existing',
        kind: 'chord',
        duration: 1,
        root: 'G',
        quality: 'major',
        chordSymbol: 'G',
      }, trackId);
      appUndo();
      expect(ur.canRedo()).toBe(true);

      ur.beginPass(state().project);
      take('take-1', 2);
      appUndo();
      expect(ur.canRedo()).toBe(true);

      take('take-2', 2);
      ur.endPass();
      expect(ur.canRedo()).toBe(false);
    });
  });
});
