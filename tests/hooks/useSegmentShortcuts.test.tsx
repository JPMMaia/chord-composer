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

  describe('with several segments selected', () => {
    /**
     * One chord in each bar, with bar 2 rekeyed to G major — so a shortcut that
     * reached for a single shared scale would be caught here.
     */
    function chordInEachBar(): [ChordSegment, ChordSegment] {
      state().addBar();
      const bars = state().project!.bars;
      state().updateBarScale(bars[1].id, { root: 'G', type: 'major' });

      const first = placeChord({ id: 'seg-1' });
      const second: ChordSegment = {
        id: 'seg-2',
        kind: 'chord',
        root: 'G',
        quality: 'major',
        romanNumeral: 'I',
        chordSymbol: 'G',
        octave: 4,
        duration: 1,
      };
      state().insertSegment(state().project!.bars[1].id, 0, second);
      selectionStore.getState().setSelectedSegments([first.id, second.id]);
      return [first, second];
    }

    it('steps every selected chord within its own bar’s scale', () => {
      const [first, second] = chordInEachBar();
      renderHook(() => useSegmentShortcuts());

      fireEvent.keyDown(window, { key: 'ArrowUp' });

      expect(segmentOf(first.id)).toMatchObject({ root: 'D', romanNumeral: 'ii' });
      expect(segmentOf(second.id)).toMatchObject({ root: 'A', romanNumeral: 'ii' });
    });

    it('shifts every selected chord an octave', () => {
      const [first, second] = chordInEachBar();
      renderHook(() => useSegmentShortcuts());

      fireEvent.keyDown(window, { key: '+' });

      expect(segmentOf(first.id).octave).toBe(5);
      expect(segmentOf(second.id).octave).toBe(5);
    });

    it('cycles every selected chord’s inversion', () => {
      const [first, second] = chordInEachBar();
      renderHook(() => useSegmentShortcuts());

      fireEvent.keyDown(window, { key: 'i' });

      expect(segmentOf(first.id).inversion).toBe(1);
      expect(segmentOf(second.id).inversion).toBe(1);
    });

    it('applies the whole selection in a single store write', () => {
      chordInEachBar();
      renderHook(() => useSegmentShortcuts());
      const before = state().project;

      fireEvent.keyDown(window, { key: 'ArrowUp' });

      // One new project object, not one per selected block: a keypress is one
      // visual step and one undo entry.
      const after = state().project;
      expect(after).not.toBe(before);
      expect(after!.bars[0].chords[0].root).toBe('D');
      expect(after!.bars[1].chords[0].root).toBe('A');
    });
  });

  describe('selection shortcuts', () => {
    it('selects every block in the project on Ctrl+A', () => {
      chordsInBothBars();
      renderHook(() => useSegmentShortcuts());

      fireEvent.keyDown(window, { key: 'a', ctrlKey: true });

      expect(selectionStore.getState().selectedSegmentIds).toEqual(['seg-1', 'seg-2']);
    });

    it('selects all on Cmd+A too, from an empty selection', () => {
      chordsInBothBars();
      selectionStore.getState().clearSegmentSelection();
      renderHook(() => useSegmentShortcuts());

      fireEvent.keyDown(window, { key: 'A', metaKey: true });

      expect(selectionStore.getState().selectedSegmentIds).toHaveLength(2);
    });

    it('leaves Ctrl+A alone inside a text field', () => {
      chordsInBothBars();
      renderHook(() => useSegmentShortcuts());

      const input = document.createElement('input');
      document.body.appendChild(input);
      fireEvent.keyDown(input, { key: 'a', ctrlKey: true });

      expect(selectionStore.getState().selectedSegmentIds).toEqual([]);
      input.remove();
    });

    it('clears the selection on Escape', () => {
      const segment = placeChord();
      selectionStore.getState().selectSegment(segment.id);
      renderHook(() => useSegmentShortcuts());

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(selectionStore.getState().selectedSegmentIds).toEqual([]);
    });
  });
});

/** A chord at the start of each of the two bars, ids `seg-1` and `seg-2`. */
function chordsInBothBars(): void {
  const state = () => projectStore.getState();
  state().addBar();
  const base: Omit<ChordSegment, 'id'> = {
    kind: 'chord',
    root: 'C',
    quality: 'major',
    romanNumeral: 'I',
    chordSymbol: 'C',
    octave: 4,
    duration: 1,
  };
  state().insertSegment(state().project!.bars[0].id, 0, { ...base, id: 'seg-1' });
  state().insertSegment(state().project!.bars[1].id, 0, { ...base, id: 'seg-2' });
}
