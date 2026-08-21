import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, fireEvent } from '@testing-library/react';
import { useSegmentCopyPaste } from '@/hooks/useSegmentCopyPaste';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { clipboardStore } from '@/store/clipboardStore';
import { editorStore } from '@/store/editorStore';
import { createUndoRedoMiddleware } from '@/engine/undoRedo';
import type { Project } from '@/types/music';
import type { ChordSegment } from '@/types/music';
import { editableBars, openTestPhrase } from '../helpers/phrases';
import { PHRASE_TRACK_KEY } from '@/engine/phrases';

const state = () => projectStore.getState();

function mountProject() {
  state().resetProject();
  state().createProject();
  for (let i = 0; i < 4; i++) state().addBar();
  selectionStore.getState().selectTrack(state().project!.tracks[0].id);
  // Copy and paste act on the phrase being edited, so there has to be one open.
  openTestPhrase(state().project!.tracks[0].id, 4);
}

/** A chord in the first bar, ready to be copied. */
function placeAndCopyChord(overrides: Partial<ChordSegment> = {}): ChordSegment {
  const segment: ChordSegment = {
    id: 'seg-src',
    kind: 'chord',
    root: 'C',
    quality: 'major',
    romanNumeral: 'I',
    chordSymbol: 'C',
    octave: 4,
    duration: 1,
    ...overrides,
  };
  state().insertSegment(editableBars()[0].id, 0, segment, trackId());
  selectionStore.getState().selectSegment(segment.id);

  // Simulate Ctrl+C by calling copySegments directly (full UI key handling is
  // tested via the integration below)
  clipboardStore.getState().copySegments();
  return segment;
}

const trackId = (): string => state().project!.tracks[0].id;

describe('useSegmentCopyPaste', () => {
  let ur: ReturnType<typeof createUndoRedoMiddleware<Project | null>>;
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    ur = createUndoRedoMiddleware<Project | null>(null, 50);
    unsubscribe?.();
    // Subscribe: every project mutation is captured
    unsubscribe = projectStore.subscribe((fullState) => {
      ur.pushState(fullState.project);
    });
    mountProject();
    clipboardStore.getState().clear();
  });

  afterEach(() => {
    unsubscribe?.();
  });

  // ------------------------------------------------------------------
  // 3.5 — Ctrl+V paste is undoable (one history entry per paste)
  // ------------------------------------------------------------------
  it('paste is undoable', () => {
    const chord = placeAndCopyChord();
    renderHook(() => useSegmentCopyPaste());

    const chordCountBefore = ur.current()!.phrases[0].bars[0].content[PHRASE_TRACK_KEY]!.chords.length;

    // Simulate the paste key-down (pasteSegments is the store method)
    const pasteResult = state().pasteSegments(
      clipboardStore.getState().segments,
      trackId(),
      0,        // paste into bar 0
      2         // at beat 2
    );

    // Paste must have produced new segments
    expect(pasteResult).toBeDefined();
    expect(pasteResult!.length).toBeGreaterThan(0);

    const chordCountAfter = editableBars()[0].content[PHRASE_TRACK_KEY]!.chords.length;
    expect(chordCountAfter).toBeGreaterThan(chordCountBefore);

    // Undo restores the pre-paste state via middleware pointer
    ur.undo();
    expect(ur.current()?.bars[0].content[trackId()]!.chords.length).toBe(chordCountBefore);
  });

  it('undo after paste restores the pre-paste state', () => {
    placeAndCopyChord();
    renderHook(() => useSegmentCopyPaste());

    state().pasteSegments(
      clipboardStore.getState().segments,
      trackId(),
      0,
      2
    );

    const afterPaste = state().project;
    const barChordsAfter = afterPaste!.bars[0].content[trackId()]!.chords;
    expect(barChordsAfter.length).toBeGreaterThan(1); // original + pasted

    ur.undo();

    const afterUndo = ur.current();
    expect(afterUndo?.bars[0].content[trackId()]!.chords.length).toBe(1);
  });

  it('redo after undo restores the pasted segments', () => {
    placeAndCopyChord();
    renderHook(() => useSegmentCopyPaste());

    const newIds = state().pasteSegments(
      clipboardStore.getState().segments,
      trackId(),
      0,
      2
    );

    ur.undo();
    expect(ur.current()?.bars[0].content[trackId()]!.chords.length).toBe(1);

    ur.redo();
    const restored = ur.current();
    expect(restored?.bars[0].content[trackId()]!.chords.length).toBeGreaterThan(1);
  });

  it('paste into an empty selection is undoable too', () => {
    // resetProject clears history; createProject + addBar seed history[0]
    state().resetProject();
    state().createProject();
    for (let i = 0; i < 2; i++) state().addBar();
    selectionStore.getState().selectTrack(trackId());
    openTestPhrase(trackId(), 2);

    // Insert a chord and copy it
    const chord: ChordSegment = {
      id: 's1',
      kind: 'chord',
      root: 'D',
      quality: 'minor',
      romanNumeral: 'ii',
      chordSymbol: 'Dm',
      octave: 4,
      duration: 1,
    };
    state().insertSegment(editableBars()[0].id, 0, chord, trackId());
    selectionStore.getState().selectSegment(chord.id);
    clipboardStore.getState().copySegments();

    const chordCountBefore = ur.current()!.phrases[0].bars[0].content[PHRASE_TRACK_KEY]!.chords.length;

    renderHook(() => useSegmentCopyPaste());

    state().pasteSegments(
      clipboardStore.getState().segments,
      trackId(),
      0,
      1
    );

    expect(editableBars()[0].content[PHRASE_TRACK_KEY]!.chords.length).toBeGreaterThan(chordCountBefore);

    // Undo reverts to the state before paste
    ur.undo();
    expect(ur.current()?.bars[0].content[trackId()]!.chords.length).toBe(chordCountBefore);
  });

  it('Ctrl+V snaps the pasted segment to the editing grid', () => {
    placeAndCopyChord();
    renderHook(() => useSegmentCopyPaste());

    // A ruler starting at viewport x=0, so mouse x maps straight to pixels.
    const ruler = document.createElement('div');
    ruler.setAttribute('data-testid', 'timeline-ruler');
    ruler.getBoundingClientRect = () =>
      ({ left: 0, right: 10000, top: 0, bottom: 40, width: 10000, height: 40 }) as DOMRect;
    document.body.appendChild(ruler);

    const { pixelsPerBeat, snapBeats } = editorStore.getState();
    expect(snapBeats).toBe(1); // default grid: quarter notes

    // Park the cursor at beat 2.4 — deliberately between grid lines.
    fireEvent.mouseMove(window, { clientX: 2.4 * pixelsPerBeat });
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });

    const chords = editableBars()[0].content[PHRASE_TRACK_KEY]!.chords;
    expect(chords.length).toBe(2);
    const pasted = chords.find(c => c.id !== 'seg-src')!;
    expect(pasted.startBeat).toBe(2);

    ruler.remove();
  });

  it('multiple pastes each create one undo entry', () => {
    placeAndCopyChord();
    renderHook(() => useSegmentCopyPaste());

    // First paste
    state().pasteSegments(
      clipboardStore.getState().segments,
      trackId(),
      0,
      1
    );
    expect(ur.canUndo()).toBe(true);
    // 1 original + 1 pasted = 2
    expect(ur.current()?.bars[0].content[trackId()]!.chords.length).toBe(2);

    // Undo first paste — middleware pointer moves back
    ur.undo();
    expect(ur.current()?.bars[0].content[trackId()]!.chords.length).toBe(1);

    // Sync the store back (undo only moved the middleware pointer).
    // Without this, the second paste would add onto the store's still-modified project.
    projectStore.setState({ project: ur.current()! });

    // Second paste — creates its own history entry on a clean slate
    state().pasteSegments(
      clipboardStore.getState().segments,
      trackId(),
      0,
      2
    );
    expect(ur.canUndo()).toBe(true);
    // 1 original + 1 second-pasted = 2 (first paste's redo slot was cleared)
    expect(ur.current()?.bars[0].content[trackId()]!.chords.length).toBe(2);
  });
});
