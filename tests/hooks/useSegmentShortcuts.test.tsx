import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, fireEvent } from '@testing-library/react';
import { useSegmentShortcuts } from '@/hooks/useSegmentShortcuts';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import type { ChordSegment } from '@/types/music';

const state = () => projectStore.getState();

/** A C major triad at octave 4, dropped at the start of the first bar. */
function placeChord(overrides: Partial<ChordSegment> = {}): ChordSegment {
  const segment: ChordSegment = {
    id: 'seg-1',
    kind: 'chord',
    root: 'C',
    quality: 'major',
    romanNumeral: 'I',
    chordSymbol: 'C',
    octave: 4,
    duration: 1,
    ...overrides,
  };
  state().insertSegment(state().project!.bars[0].id, 0, segment);
  return segment;
}

/** The live copy of a segment, after the store has rebuilt the project around it. */
const segmentOf = (id: string): ChordSegment =>
  state().project!.bars.flatMap(b => b.chords).find(c => c.id === id)!;

describe('useSegmentShortcuts', () => {
  beforeEach(() => {
    state().resetProject();
    state().createProject();
    state().addBar();
    selectionStore.getState().clearSelection();
  });

  it('steps the selected chord up a scale degree on ArrowUp', () => {
    const segment = placeChord();
    selectionStore.getState().selectSegment(segment.id);
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: 'ArrowUp' });

    expect(segmentOf(segment.id)).toMatchObject({ root: 'D', romanNumeral: 'ii' });
  });

  it('steps down on ArrowDown', () => {
    const segment = placeChord();
    selectionStore.getState().selectSegment(segment.id);
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: 'ArrowDown' });

    expect(segmentOf(segment.id)).toMatchObject({ root: 'B', romanNumeral: 'vii°', octave: 3 });
  });

  it('moves a note a full octave on +', () => {
    const segment = placeChord({ kind: 'note', pitch: 60, quality: undefined });
    selectionStore.getState().selectSegment(segment.id);
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: '+' });

    expect(segmentOf(segment.id).pitch).toBe(72);
  });

  it('accepts = and _ as the unshifted twins of + and -', () => {
    const segment = placeChord();
    selectionStore.getState().selectSegment(segment.id);
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: '=' });
    expect(segmentOf(segment.id).octave).toBe(5);

    fireEvent.keyDown(window, { key: '_' });
    expect(segmentOf(segment.id).octave).toBe(4);
  });

  it('cycles the inversion on i, in either case', () => {
    const segment = placeChord();
    selectionStore.getState().selectSegment(segment.id);
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: 'i' });
    expect(segmentOf(segment.id).inversion).toBe(1);

    fireEvent.keyDown(window, { key: 'I' });
    expect(segmentOf(segment.id).inversion).toBe(2);
  });

  it('leaves a dropdown its own arrow keys', () => {
    const segment = placeChord();
    selectionStore.getState().selectSegment(segment.id);
    renderHook(() => useSegmentShortcuts());

    const select = document.createElement('select');
    document.body.appendChild(select);
    fireEvent.keyDown(select, { key: 'ArrowUp' });

    expect(segmentOf(segment.id).root).toBe('C');
    select.remove();
  });

  it('lets Ctrl and Cmd combinations through untouched', () => {
    const segment = placeChord();
    selectionStore.getState().selectSegment(segment.id);
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: 'ArrowUp', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'i', metaKey: true });

    expect(segmentOf(segment.id).root).toBe('C');
    expect(segmentOf(segment.id).inversion).toBeUndefined();
  });

  it('does nothing with no segment selected', () => {
    const segment = placeChord();
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: 'ArrowUp' });

    expect(segmentOf(segment.id).root).toBe('C');
  });

  it('ignores keys it does not own', () => {
    const segment = placeChord();
    selectionStore.getState().selectSegment(segment.id);
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: 'x' });

    expect(segmentOf(segment.id)).toMatchObject({ root: 'C', octave: 4 });
  });
});
