import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  projectStore,
  setRecordingGate,
} from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editableBars, openTestPhrase } from '../helpers/phrases';
import { PHRASE_TRACK_KEY } from '@/engine/phrases';
import { UndoRedoContext, type UndoRedoContextValue } from '@/context/undoRedoContext';
import { Transport } from '@/components/Transport';
import { createUndoRedoMiddleware } from '@/engine/undoRedo';
import type { Project, ChordSegment } from '@/types/music';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mount a minimal project inside the store (same as App's on-mount). */
function mountProject() {
  projectStore.getState().resetProject();
  projectStore.getState().createProject();
  for (let i = 0; i < 4; i++) projectStore.getState().addBar();
  // An insertion needs a phrase to land in, so the arrangement gets one over the
  // whole song — which is exactly what these tests assumed before phrases existed.
  openTestPhrase(projectStore.getState().project!.tracks[0].id, 4);
}

function renderTransportWithUndoRedo(ur: ReturnType<typeof createUndoRedoMiddleware<Project | null>>) {
  const ctx: UndoRedoContextValue = {
    undo: () => {
      const prev = ur.undo();
      if (prev) projectStore.setState({ project: prev });
    },
    redo: () => {
      const next = ur.redo();
      if (next) projectStore.setState({ project: next });
    },
    get canUndo() { return ur.canUndo(); },
    get canRedo() { return ur.canRedo(); },
  };

  return render(
    <UndoRedoContext.Provider value={ctx}>
      <Transport
        isPlaying={false}
        isPaused={false}
        bpm={120}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        musicalKey="C"
        keyMode="major" as const
        loopEnabled={false}
        loopRangeLabel={null}
        isMetronomeOn={false}
        isRecordArmed={false}
        canRecord={false}
        recordQuantize={true}
        onPlay={() => {}}
        onPause={() => {}}
        onStop={() => {}}
        onBpmChange={() => {}}
        onMetronomeToggle={() => {}}
        onLoopToggle={() => {}}
        onRecordToggle={() => {}}
        onQuantizeToggle={() => {}}
        onUndo={ctx.undo}
        onRedo={ctx.redo}
        canUndo={ctx.canUndo}
        canRedo={ctx.canRedo}
      />
    </UndoRedoContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// 2.7 — E2E: pressing undo button reverts the last operation
// ---------------------------------------------------------------------------

describe('E2E — Transport undo/redo buttons revert operations end-to-end', () => {
  let ur: ReturnType<typeof createUndoRedoMiddleware<Project | null>>;
  let unsub: (() => void) | undefined;

  beforeEach(() => {
    unsub?.();
    ur = createUndoRedoMiddleware<Project | null>(null, 50);
    setRecordingGate(ur.setRecording);
    unsub = projectStore.subscribe((fullState) => {
      ur.pushState(fullState.project);
    });
    mountProject();
  });

  afterEach(() => {
    unsub?.();
    cleanup();
  });

  it('undo button reverts a segment insertion', () => {
    const project = projectStore.getState().project!;
    const bar = editableBars()[0];
    const trackId = project.tracks[0].id;
    const segment: ChordSegment = {
      id: 'seg-e2e-undo',
      kind: 'chord',
      duration: 1,
      root: 'E',
      quality: 'minor',
      chordSymbol: 'Em',
    };

    // Insert a segment — captured by middleware via subscription
    projectStore.getState().insertSegment(bar.id, 0, segment, trackId);
    expect(ur.canUndo()).toBe(true);

    const chordsAfterInsert =
      projectStore.getState().project!.bars[0].content[trackId]?.chords.length ?? 0;
    expect(chordsAfterInsert).toBeGreaterThan(0);

    renderTransportWithUndoRedo(ur);

    // Undo button should be active
    const undoBtn = screen.getByLabelText('Undo');
    expect(undoBtn).not.toHaveClass('opacity-40');

    // Click undo button — the handler sets project back, triggering React re-render
    fireEvent.click(undoBtn);

    // Segment should be gone from the store
    const barAfterUndo = projectStore.getState().project!.bars[0];
    const chordsAfterUndo = barAfterUndo.content[trackId]?.chords.length ?? 0;
    expect(chordsAfterUndo).toBe(0);
  });

  it('undo then redo restores the inserted segment', () => {
    const project = projectStore.getState().project!;
    const bar = editableBars()[0];
    const trackId = project.tracks[0].id;
    const segment: ChordSegment = {
      id: 'seg-e2e-roundtrip',
      kind: 'chord',
      duration: 2,
      root: 'A',
      quality: 'major',
      chordSymbol: 'A',
    };

    projectStore.getState().insertSegment(bar.id, 0, segment, trackId);
    const chordsAfterInsert =
      projectStore.getState().project!.bars[0].content[trackId]?.chords.length ?? 0;
    expect(chordsAfterInsert).toBeGreaterThan(0);

    const { rerender } = renderTransportWithUndoRedo(ur);

    const undoBtn = screen.getByLabelText('Undo');
    const redoBtn = screen.getByLabelText('Redo');

    // Initially redo is disabled
    expect(redoBtn).toHaveClass('opacity-40');

    // Click undo
    fireEvent.click(undoBtn);

    // After undo, redo should be possible in the middleware
    expect(ur.canRedo()).toBe(true);

    // Re-render to update button disabled state
    rerender(renderTransportWithUndoRedo(ur).container.innerHTML ? null : null);

    // Verify undo moved pointer — segment removed
    const barAfterUndo = projectStore.getState().project!.bars[0];
    const chordsAfterUndo = barAfterUndo.content[trackId]?.chords.length ?? 0;
    expect(chordsAfterUndo).toBe(0);

    // Click redo via the middleware directly (testing the round-trip)
    const next = ur.redo();
    if (next) projectStore.setState({ project: next });

    // Segment should be back
    const barAfterRedo = projectStore.getState().project!.bars[0];
    const chordsAfterRedo = barAfterRedo.content[trackId]?.chords.length ?? 0;
    expect(chordsAfterRedo).toBe(chordsAfterInsert);
  });
});
