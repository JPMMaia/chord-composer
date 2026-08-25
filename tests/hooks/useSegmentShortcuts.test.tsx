import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, fireEvent } from '@testing-library/react';
import { useSegmentShortcuts } from '@/hooks/useSegmentShortcuts';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore, ZOOM_LEVELS } from '@/store/editorStore';
import { PIXELS_PER_BEAT } from '@/utils/constants';
import type { ChordSegment } from '@/types/music';
import type { InstrumentPool } from '@/engine/instrumentPool';
import { barChords } from '@/engine/timeline';
import { PHRASE_TRACK_KEY } from '@/engine/phrases';
import { editableBars, openTestPhrase } from '../helpers/phrases';

/** The instrument being edited — the Piano every project starts with. */
const trackId = (): string => projectStore.getState().project!.tracks[0].id;

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
  state().insertSegment(editableBars()[0].id, 0, segment, trackId());
  return segment;
}

/** The live copy of a segment, after the store has rebuilt the project around it. */
const segmentOf = (id: string): ChordSegment =>
  editableBars().flatMap(b => barChords(b, PHRASE_TRACK_KEY)).find(c => c.id === id)!;

describe('useSegmentShortcuts', () => {
  beforeEach(() => {
    state().resetProject();
    state().createProject();
    state().addBar();
    selectionStore.getState().clearSelection();
    // Select-all acts on the instrument the timeline is showing, so it needs one —
    // and on the phrase it is showing *of* that instrument, so it needs one open.
    selectionStore.getState().selectTrack(trackId());
    openTestPhrase(trackId(), 2);
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

  it('zooms the beat axis on Alt + and Alt -, from an empty selection', () => {
    // Alt rather than Ctrl: the browser claims Ctrl +/- for page zoom.
    editorStore.setState({ pixelsPerBeat: PIXELS_PER_BEAT });
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: '=', altKey: true });
    expect(editorStore.getState().pixelsPerBeat).toBe(ZOOM_LEVELS[2]);

    fireEvent.keyDown(window, { key: '-', altKey: true });
    expect(editorStore.getState().pixelsPerBeat).toBe(PIXELS_PER_BEAT);
  });

  it('leaves Ctrl + and Ctrl - to the browser', () => {
    editorStore.setState({ pixelsPerBeat: PIXELS_PER_BEAT });
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    fireEvent.keyDown(window, { key: '-', metaKey: true });

    expect(editorStore.getState().pixelsPerBeat).toBe(PIXELS_PER_BEAT);
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

  // ------------------------------------------------------------------
  // Phase 3, test 3.4 — Ctrl+Z is NOT intercepted by segment shortcuts
  // ------------------------------------------------------------------
  it('does not intercept Ctrl+Z (leaves it for undo/redo)', () => {
    const segment = placeChord();
    selectionStore.getState().selectSegment(segment.id);
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

    // Ctrl+Z should be silently ignored by this hook — no shortcut fires.
    expect(segmentOf(segment.id).root).toBe('C');
    expect(segmentOf(segment.id).inversion).toBeUndefined();
  });

  it('does not intercept Ctrl+Shift+Z (leaves it for redo)', () => {
    const segment = placeChord();
    selectionStore.getState().selectSegment(segment.id);
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });

    expect(segmentOf(segment.id).root).toBe('C');
  });

  it('does not intercept Ctrl+Y (leaves it for redo)', () => {
    const segment = placeChord();
    selectionStore.getState().selectSegment(segment.id);
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });

    expect(segmentOf(segment.id).root).toBe('C');
  });

  it('does not intercept Cmd+Z on Mac (leaves it for undo/redo)', () => {
    const segment = placeChord();
    selectionStore.getState().selectSegment(segment.id);
    renderHook(() => useSegmentShortcuts());

    fireEvent.keyDown(window, { key: 'z', metaKey: true });

    expect(segmentOf(segment.id).root).toBe('C');
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
     * One chord in each bar, the second written in G major — so a shortcut that
     * reached for a single shared scale would be caught here.
     */
    function chordInEachBar(): [ChordSegment, ChordSegment] {
      state().addBar();

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
        scale: { root: 'G', type: 'major' },
      };
      state().insertSegment(editableBars()[1].id, 0, second, trackId());
      selectionStore.getState().setSelectedSegments([first.id, second.id]);
      return [first, second];
    }

    it('steps every selected chord within its own key', () => {
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

    it('deletes every selected block on Delete', () => {
      const [first, second] = chordInEachBar();
      renderHook(() => useSegmentShortcuts());

      fireEvent.keyDown(window, { key: 'Delete' });

      expect(segmentOf(first.id)).toBeUndefined();
      expect(segmentOf(second.id)).toBeUndefined();
    });

    it('deletes the whole selection on Backspace too, in one store write', () => {
      chordInEachBar();
      renderHook(() => useSegmentShortcuts());
      const before = state().project;

      fireEvent.keyDown(window, { key: 'Backspace' });

      const after = state().project;
      expect(after).not.toBe(before);
      expect(barChords(after!.bars[0], trackId())).toEqual([]);
      expect(barChords(after!.bars[1], trackId())).toEqual([]);
    });

    it('drops the selection along with the blocks it named', () => {
      chordInEachBar();
      renderHook(() => useSegmentShortcuts());

      fireEvent.keyDown(window, { key: 'Delete' });

      expect(selectionStore.getState().selectedSegmentIds).toEqual([]);
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
      expect(barChords(after!.bars[0], trackId())[0].root).toBe('D');
      expect(barChords(after!.bars[1], trackId())[0].root).toBe('A');
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

  describe('sounding a pitch move', () => {
    /** Every pitch the fake instrument was asked to hold, and its stopper. */
    interface Held {
      midiNote: number;
      stop: ReturnType<typeof vi.fn>;
    }

    function fakePool() {
      const held: Held[] = [];
      const instrument = {
        now: () => 0,
        schedule: vi.fn(),
        sustain: ({ midiNote }: { midiNote: number }) => {
          const stop = vi.fn();
          held.push({ midiNote, stop });
          return stop;
        },
      };
      const pool = { get: vi.fn(() => instrument) };
      return {
        held,
        getPool: () => pool as unknown as InstrumentPool,
        pool,
      };
    }

    /** The pitches still ringing, in the order they were struck. */
    const sounding = (held: Held[]) =>
      held.filter(h => h.stop.mock.calls.length === 0).map(h => h.midiNote);

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sounds the chord it stepped to, not the one it stepped from', () => {
      const segment = placeChord();
      selectionStore.getState().selectSegment(segment.id);
      const { held, getPool } = fakePool();
      renderHook(() => useSegmentShortcuts({ getPool }));

      fireEvent.keyDown(window, { key: 'ArrowUp' });

      // C major stepped up a degree is D minor: the *new* voicing, read back out of
      // the store rather than from the segment the caller was holding.
      expect(sounding(held)).toEqual([62, 65, 69]);
    });

    it('sounds it on the instrument being edited', () => {
      const segment = placeChord();
      selectionStore.getState().selectSegment(segment.id);
      const { getPool, pool } = fakePool();
      renderHook(() => useSegmentShortcuts({ getPool }));

      fireEvent.keyDown(window, { key: 'ArrowUp' });

      expect(pool.get).toHaveBeenCalledWith(trackId());
    });

    it('sounds the octave move too', () => {
      const segment = placeChord({ kind: 'note', pitch: 60, quality: undefined });
      selectionStore.getState().selectSegment(segment.id);
      const { held, getPool } = fakePool();
      renderHook(() => useSegmentShortcuts({ getPool }));

      fireEvent.keyDown(window, { key: '+' });

      expect(sounding(held)).toEqual([72]);
    });

    // Holding the arrow key is a run up the scale, not a chord built out of every
    // step it passed through.
    it('releases the previous step before sounding the next', () => {
      const segment = placeChord({ kind: 'note', pitch: 60, quality: undefined });
      selectionStore.getState().selectSegment(segment.id);
      const { held, getPool } = fakePool();
      renderHook(() => useSegmentShortcuts({ getPool }));

      fireEvent.keyDown(window, { key: 'ArrowUp' });
      fireEvent.keyDown(window, { key: 'ArrowUp' });

      expect(held).toHaveLength(2);
      expect(held[0].stop).toHaveBeenCalled();
      expect(sounding(held)).toEqual([64]);
    });

    it('lets the preview go after a moment', () => {
      vi.useFakeTimers();
      const segment = placeChord();
      selectionStore.getState().selectSegment(segment.id);
      const { held, getPool } = fakePool();
      renderHook(() => useSegmentShortcuts({ getPool }));

      fireEvent.keyDown(window, { key: 'ArrowUp' });
      expect(sounding(held)).toHaveLength(3);

      vi.advanceTimersByTime(1000);
      expect(sounding(held)).toEqual([]);
    });

    it('leaves nothing ringing when the roll goes away', () => {
      const segment = placeChord();
      selectionStore.getState().selectSegment(segment.id);
      const { held, getPool } = fakePool();
      const { unmount } = renderHook(() => useSegmentShortcuts({ getPool }));

      fireEvent.keyDown(window, { key: 'ArrowUp' });
      unmount();

      expect(sounding(held)).toEqual([]);
    });

    // The graph comes up lazily, so the very first edit of a session can land before
    // there is anything to play it on. That edit still has to happen.
    it('still steps the pitch with the audio graph down', () => {
      const segment = placeChord();
      selectionStore.getState().selectSegment(segment.id);
      const ensureAudio = vi.fn(() => Promise.resolve({} as InstrumentPool));
      renderHook(() => useSegmentShortcuts({ getPool: () => null, ensureAudio }));

      fireEvent.keyDown(window, { key: 'ArrowUp' });

      expect(segmentOf(segment.id)).toMatchObject({ root: 'D' });
      expect(ensureAudio).toHaveBeenCalled();
    });

    it('steps silently when given no audio at all', () => {
      const segment = placeChord();
      selectionStore.getState().selectSegment(segment.id);
      renderHook(() => useSegmentShortcuts());

      expect(() => fireEvent.keyDown(window, { key: 'ArrowUp' })).not.toThrow();
      expect(segmentOf(segment.id)).toMatchObject({ root: 'D' });
    });

    it('says nothing about an inversion or a deletion', () => {
      const segment = placeChord();
      selectionStore.getState().selectSegment(segment.id);
      const { held, getPool } = fakePool();
      renderHook(() => useSegmentShortcuts({ getPool }));

      fireEvent.keyDown(window, { key: 'i' });
      fireEvent.keyDown(window, { key: 'Delete' });

      expect(held).toEqual([]);
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
  state().insertSegment(editableBars()[0].id, 0, { ...base, id: 'seg-1' }, trackId());
  state().insertSegment(editableBars()[1].id, 0, { ...base, id: 'seg-2' }, trackId());
}
