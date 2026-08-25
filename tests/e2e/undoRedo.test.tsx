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
import { ChordTimeline } from '@/components/ChordTimeline';
import { PIXELS_PER_BEAT } from '@/utils/constants';
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

// ---------------------------------------------------------------------------
// Resizing a block is one edit, and one undo step.
//
// The store used to be written on every pointermove of the gesture, so a drag left
// behind one history entry per mouse-move: Ctrl+Z rewound a single move, which looks
// on screen exactly like undo doing nothing at all. A long drag also pushed the rest
// of the history out of the fifty-entry stack.
// ---------------------------------------------------------------------------

describe('E2E — undoing a chord-timeline resize', () => {
  let ur: ReturnType<typeof createUndoRedoMiddleware<Project | null>>;
  let unsub: (() => void) | undefined;

  const undo = () => {
    const prev = ur.undo();
    projectStore.setState({ project: prev });
  };

  beforeEach(() => {
    unsub?.();
    ur = createUndoRedoMiddleware<Project | null>(null, 50);
    setRecordingGate(ur.setRecording);
    unsub = projectStore.subscribe(fullState => ur.pushState(fullState.project));
    mountProject();
  });

  afterEach(() => {
    unsub?.();
    cleanup();
  });

  /** Put one one-beat block at the start of the open phrase, and hand back its id. */
  const placeBlock = (id: string): string => {
    const segment: ChordSegment = {
      id,
      kind: 'chord',
      duration: 1,
      root: 'C',
      quality: 'major',
      chordSymbol: 'C',
    };
    projectStore
      .getState()
      .insertSegment(editableBars()[0].id, 0, segment, projectStore.getState().project!.tracks[0].id);
    return id;
  };

  const duration = (id: string): number | undefined =>
    editableBars()
      .flatMap(bar => bar.content[PHRASE_TRACK_KEY]?.chords ?? [])
      .find(chord => chord.id === id)?.duration;

  /** Drag the block's right edge out to `beats`, in several moves like a real drag. */
  const resizeTo = (id: string, beats: number) => {
    fireEvent.pointerDown(screen.getByTestId(`resize-handle-${id}`), {
      clientX: 0,
      pointerId: 1,
      buttons: 1,
    });
    for (let x = 0.25; x <= beats - 1; x += 0.25) {
      fireEvent.pointerMove(window, { clientX: x * PIXELS_PER_BEAT, pointerId: 1, buttons: 1 });
    }
    fireEvent.pointerUp(window, { clientX: (beats - 1) * PIXELS_PER_BEAT, pointerId: 1 });
  };

  it('takes one undo to put a resized block back to the width it had', () => {
    const id = placeBlock('seg-e2e-resize');
    render(<ChordTimeline />);

    resizeTo(id, 3);
    expect(duration(id)).toBe(3);

    undo();
    expect(duration(id)).toBe(1);

    const next = ur.redo();
    projectStore.setState({ project: next });
    expect(duration(id)).toBe(3);
  });

  it('does not spend the rest of the history on one resize drag', () => {
    const id = placeBlock('seg-e2e-resize-history');
    render(<ChordTimeline />);

    resizeTo(id, 4);

    // Back past the resize, then past the insertion that came before it.
    undo();
    expect(duration(id)).toBe(1);
    undo();
    expect(duration(id)).toBeUndefined();
  });
});
