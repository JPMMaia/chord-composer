import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, fireEvent, act } from '@testing-library/react';
import { useRecordShortcuts } from '@/hooks/useRecordShortcuts';
import { useRecordSession } from '@/hooks/useRecordSession';
import { createUndoRedoMiddleware } from '@/engine/undoRedo';
import { projectStore, setRecordingGate } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { barChords } from '@/engine/timeline';
import type { InstrumentPool } from '@/engine/instrumentPool';
import type { ChordSegment, Project } from '@/types/music';

/**
 * Ctrl+Z during a recording erases the take, not the last block of it.
 *
 * The whole App wiring, minus React's tree: real number-key shortcuts writing
 * through the real store, a real middleware subscribed to it, and the record
 * session opening and closing the pass off the transport.
 */

const state = () => projectStore.getState();
const trackId = (): string => state().project!.tracks[0].id;

/** Blocks on the recorded track, across every bar. */
function recorded(): string[] {
  const project = state().project!;
  const out: string[] = [];
  let barStart = 0;
  for (const bar of project.bars) {
    for (const c of barChords(bar, trackId())) {
      out.push(`${c.chordSymbol}@${barStart + (c.startBeat ?? 0)}`);
    }
    barStart += (bar.timeSignature ?? project.timeSignature).beatsPerMeasure;
  }
  return out;
}

const pool = {
  get: () => ({
    name: 'Mock',
    now: () => 0,
    load: async () => {},
    isLoaded: true,
    schedule: vi.fn(),
    sustain: () => () => {},
    stopAll: vi.fn(),
    setVolume: vi.fn(),
    dispose: vi.fn(),
  }),
} as unknown as InstrumentPool;

/** Song position in seconds. 120 BPM, so a beat is half a second. */
let songTime = 0;
const beatsIn = (beats: number) => {
  songTime = beats / 2;
};

const press = (digit: number) =>
  fireEvent.keyDown(window, { key: String(digit), code: `Digit${digit}` });
const release = (digit: number) =>
  fireEvent.keyUp(window, { key: String(digit), code: `Digit${digit}` });

/** Press and release a degree, one beat long. */
function playDegree(digit: number, atBeat: number) {
  beatsIn(atBeat);
  press(digit);
  beatsIn(atBeat + 1);
  release(digit);
}

describe('recording pass — Ctrl+Z erases the take', () => {
  let ur: ReturnType<typeof createUndoRedoMiddleware<Project | null>>;
  let unsubscribe: (() => void) | undefined;

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

  /** The hooks as App mounts them, driven by one `recording` flag. */
  function mount(recording = true) {
    return renderHook(
      ({ recording }: { recording: boolean }) => {
        useRecordShortcuts({
          isPlaying: recording,
          getSongTime: () => songTime,
          getPool: () => pool,
          record: (tId, startBeat, seg: ChordSegment) =>
            state().withRecording(() => state().recordSegment(tId, startBeat, seg)),
        });
        useRecordSession(recording, ur);
      },
      { initialProps: { recording } }
    );
  }

  beforeEach(() => {
    ur = createUndoRedoMiddleware<Project | null>(null, 50);
    setRecordingGate(ur.setRecording);
    unsubscribe?.();
    unsubscribe = projectStore.subscribe((full) => ur.pushState(full.project));

    state().resetProject();
    state().createProject();
    for (let i = 0; i < 3; i++) state().addBar();

    selectionStore.getState().clearSelection();
    selectionStore.getState().selectTrack(trackId());

    editorStore.setState({
      paletteScale: { root: 'C', type: 'major' },
      paletteMode: 'chords',
      paletteOctave: 4,
      recordArmed: true,
      recordQuantize: true,
      snapBeats: 1,
    });

    songTime = 0;
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
  });

  it('erases every block of the take on one undo', () => {
    mount();
    playDegree(1, 0);
    playDegree(2, 2);
    playDegree(3, 4);
    expect(recorded()).toHaveLength(3);

    appUndo();

    expect(recorded()).toEqual([]);
  });

  it('records again after the erase, and that retake is one undo step', () => {
    const { rerender } = mount();
    playDegree(1, 0);
    playDegree(2, 2);
    appUndo();
    expect(recorded()).toEqual([]);

    playDegree(4, 4);
    playDegree(5, 6);
    expect(recorded()).toHaveLength(2);

    // Stop: the pass closes and commits as a single entry.
    act(() => rerender({ recording: false }));
    expect(ur.canUndo()).toBe(true);

    appUndo();
    expect(recorded()).toEqual([]);
  });

  it('takes one undo to remove a finished pass, not one per take', () => {
    const { rerender } = mount();
    playDegree(1, 0);
    playDegree(2, 2);
    playDegree(3, 4);
    act(() => rerender({ recording: false }));

    appUndo();
    expect(recorded()).toEqual([]);
    // And nothing of the take is left behind a second press.
    appUndo();
    expect(recorded()).toEqual([]);
  });

  it('steps back over a pre-recording edit once the take is erased', () => {
    const bar = state().project!.bars[0];
    state().insertSegment(bar.id, 0, {
      id: 'pre-existing',
      kind: 'chord',
      duration: 1,
      root: 'G',
      quality: 'major',
      chordSymbol: 'G',
    } as ChordSegment, trackId());
    expect(recorded()).toEqual(['G@0']);

    mount();
    playDegree(2, 2);
    playDegree(3, 4);

    appUndo(); // erases the take, leaving the pre-recording edit
    expect(recorded()).toEqual(['G@0']);

    appUndo(); // now steps back over the edit itself
    expect(recorded()).toEqual([]);
  });

  it('adds no history entry for a pass that recorded nothing', () => {
    const canUndoBefore = ur.canUndo();
    const { rerender } = mount();
    act(() => rerender({ recording: false }));
    expect(ur.canUndo()).toBe(canUndoBefore);
  });
});
