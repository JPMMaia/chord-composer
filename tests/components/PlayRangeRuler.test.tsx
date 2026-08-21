import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PlayRangeRuler } from '@/components/PlayRangeRuler';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { DEFAULT_SNAP_BEATS } from '@/engine/timeline';
import { clipEndBar } from '@/engine/phrases';
import { PIXELS_PER_BEAT } from '@/utils/constants';

/**
 * The ruler, driven as each of its two surfaces drives it.
 *
 * It states no beats of its own: the range comes in as a prop and goes out through
 * `onRangeChange`. Most of what follows wires it the way the arrangement does — the
 * song's bars, the song's range in absolute beats — because that is where every
 * gesture below was written. The last block wires it the way the phrase editor does,
 * to the beats of one phrase, and checks that the same gestures land there instead.
 */

const state = () => projectStore.getState();

/** The song's bars, which is what this ruler measures. */
function bars() {
  return state().project!.bars;
}

/**
 * The ruler as the arrangement mounts it: subscribed, so a range it sets comes back
 * through the store and is drawn.
 */
const SongRuler: React.FC = () => {
  const project = projectStore(s => s.project);
  const setLoopRegion = projectStore(s => s.setLoopRegion);
  const insertBar = projectStore(s => s.insertBar);
  const removeBars = projectStore(s => s.removeBars);
  if (!project) return null;

  const blocked = (barIndex: number, count: number): string | null => {
    const span = Math.min(Math.max(1, Math.trunc(count)), project.bars.length - barIndex);
    if (span >= project.bars.length) return 'The song keeps at least one bar';
    const end = barIndex + span;
    return project.clips.some(c => c.startBar < end && clipEndBar(c, project.phrases) > barIndex)
      ? 'Something is playing over these bars — move or delete it first'
      : null;
  };

  return (
    <PlayRangeRuler
      bars={project.bars}
      timeSignature={project.timeSignature}
      range={
        project.loopStart !== undefined && project.loopEnd !== undefined
          ? { start: project.loopStart, end: project.loopEnd }
          : null
      }
      onRangeChange={setLoopRegion}
      onInsertBars={insertBar}
      onRemoveBars={removeBars}
      removeBlockedReason={blocked}
    />
  );
};

function renderRuler() {
  return render(<SongRuler />);
}

describe('PlayRangeRuler', () => {
  beforeEach(() => {
    state().resetProject();
    state().createProject();
    state().addBar();
    state().addBar();
    selectionStore.getState().clearSelection();
    editorStore.setState({
      snapBeats: DEFAULT_SNAP_BEATS,
      pixelsPerBeat: PIXELS_PER_BEAT,
      scrollX: 0,
    });
  });

  afterEach(cleanup);

  describe('play range', () => {
    const loop = () => {
      const { loopStart, loopEnd } = state().project!;
      return [loopStart, loopEnd];
    };

    it('sets the range from a drag across the ruler', () => {
      renderRuler();
      dragRuler(1, 5);

      expect(loop()).toEqual([1, 5]);
      expect(screen.getByTestId('loop-range')).toHaveStyle({
        left: `${1 * PIXELS_PER_BEAT}px`,
        width: `${4 * PIXELS_PER_BEAT}px`,
      });
    });

    it('reads a backwards drag as the same range', () => {
      renderRuler();
      dragRuler(6, 2);

      expect(loop()).toEqual([2, 6]);
    });

    it('snaps the range to the grid', () => {
      editorStore.getState().setSnapBeats(0.5);
      renderRuler();
      dragRuler(0.9, 3.4);

      expect(loop()).toEqual([1, 3.5]);
    });

    it('clears the range on a click that never moved', () => {
      renderRuler();
      dragRuler(1, 5);

      const ruler = screen.getByTestId('timeline-ruler');
      fireEvent.pointerDown(ruler, { clientX: 3 * PIXELS_PER_BEAT, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 3 * PIXELS_PER_BEAT, pointerId: 1 });

      expect(loop()).toEqual([undefined, undefined]);
      expect(screen.queryByTestId('loop-range')).not.toBeInTheDocument();
    });

    it('resizes the range by its end handle, leaving the start put', () => {
      renderRuler();
      dragRuler(1, 5);

      const handle = screen.getByRole('button', { name: 'Loop end' });
      fireEvent.pointerDown(handle, { clientX: 5 * PIXELS_PER_BEAT, pointerId: 1 });
      fireEvent.pointerMove(window, { clientX: 7 * PIXELS_PER_BEAT, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 7 * PIXELS_PER_BEAT, pointerId: 1 });

      expect(loop()).toEqual([1, 7]);
    });

    it('renders no range until one is drawn', () => {
      renderRuler();
      expect(screen.queryByTestId('loop-range')).not.toBeInTheDocument();
    });
  });

  describe('insert bars (ruler context menu)', () => {
    /**
     * Right-click the ruler at an absolute beat; jsdom zeroes the rect, so clientX
     * reads as beats.
     */
    function rightClickRuler(beat: number) {
      const ruler = screen.getByTestId('timeline-ruler');
      fireEvent.contextMenu(ruler, { clientX: beat * PIXELS_PER_BEAT });
    }

    it('opens the insert menu with a default count of 1 on right-click', () => {
      renderRuler();
      expect(screen.queryByTestId('bar-menu')).not.toBeInTheDocument();

      rightClickRuler(1);

      expect(screen.getByTestId('bar-menu')).toBeInTheDocument();
      expect(screen.getByTestId('bar-menu-count')).toHaveValue(1);
    });

    it('inserts the chosen number of empty bars before the right-clicked bar', () => {
      renderRuler();
      rightClickRuler(4);

      fireEvent.change(screen.getByTestId('bar-menu-count'), { target: { value: '2' } });
      fireEvent.click(screen.getByTestId('insert-bars'));

      expect(bars()).toHaveLength(4);
      expect(bars()[1].content).toEqual({});
      expect(bars()[2].content).toEqual({});
    });

    it('right-clicking bar 1 inserts at the start', () => {
      renderRuler();
      rightClickRuler(0);
      fireEvent.click(screen.getByTestId('insert-bars'));

      expect(bars()).toHaveLength(3);
      expect(bars()[0].content).toEqual({});
    });

    it('closes the menu on cancel without inserting', () => {
      renderRuler();
      rightClickRuler(0);
      fireEvent.click(screen.getByTestId('bar-menu-cancel'));

      expect(screen.queryByTestId('bar-menu')).not.toBeInTheDocument();
      expect(bars()).toHaveLength(2);
    });

    /**
     * The other half of the same menu.
     *
     * Insert puts its bars *before* the clicked one; Remove takes the clicked one and
     * the rest of the count after it, so a count reads from the bar pointed at either
     * way.
     */
    describe('remove', () => {
      it('takes the clicked bar and the ones after it away', () => {
        state().addBar();
        state().addBar();
        renderRuler();
        const kept = bars()[0].id;

        rightClickRuler(4);
        fireEvent.change(screen.getByTestId('bar-menu-count'), { target: { value: '2' } });
        fireEvent.click(screen.getByTestId('remove-bars'));

        expect(bars()).toHaveLength(2);
        expect(bars()[0].id).toBe(kept);
        expect(bars().map(b => b.barIndex)).toEqual([0, 1]);
      });

      // The song would have no bar cursor left, and so no way back to Add Bar.
      it('refuses to take every bar, and says why', () => {
        renderRuler();
        rightClickRuler(0);
        fireEvent.change(screen.getByTestId('bar-menu-count'), { target: { value: '2' } });

        const remove = screen.getByTestId('remove-bars');
        expect(remove).toBeDisabled();
        expect(remove).toHaveAttribute('title', 'The song keeps at least one bar');
        expect(bars()).toHaveLength(2);
      });

      // A placement is as long as its phrase and cannot be trimmed, so the grid would
      // grow straight back underneath it on the next compile.
      it('refuses a bar something is playing over', () => {
        state().addBar();
        state().addBar();
        state().addPhraseClip(state().project!.tracks[0].id, 1, 2);
        renderRuler();

        rightClickRuler(4);
        expect(screen.getByTestId('remove-bars')).toBeDisabled();

        // Bar 4 is clear of it, so the same menu offers the same button live.
        fireEvent.click(screen.getByTestId('bar-menu-cancel'));
        rightClickRuler(12);
        expect(screen.getByTestId('remove-bars')).toBeEnabled();
      });

      // Asked afresh on every render, so a count typed up into trouble disables it.
      it('re-asks as the count changes', () => {
        state().addBar();
        state().addBar();
        state().addPhraseClip(state().project!.tracks[0].id, 3, 1);
        renderRuler();

        rightClickRuler(4);
        expect(screen.getByTestId('remove-bars')).toBeEnabled();

        fireEvent.change(screen.getByTestId('bar-menu-count'), { target: { value: '3' } });
        expect(screen.getByTestId('remove-bars')).toBeDisabled();
      });
    });
  });

  /**
   * The other surface: one phrase's own bars, and the stretch of it being auditioned.
   *
   * The same gestures, landing somewhere else entirely — which is the whole point of
   * the range having been lifted out of the component.
   */
  describe('driven by a phrase', () => {
    /** Two bars of phrase, and a spy standing in for `setPhraseLoop`. */
    function renderPhraseRuler(range: { start: number; end: number } | null = null) {
      const onRangeChange = vi.fn();
      const project = state().project!;
      render(
        <PlayRangeRuler
          bars={project.bars.slice(0, 2)}
          timeSignature={project.timeSignature}
          range={range}
          onRangeChange={onRangeChange}
        />
      );
      return onRangeChange;
    }

    it('reports a drag in the beats it was given', () => {
      const onRangeChange = renderPhraseRuler();
      dragRuler(1, 5);

      expect(onRangeChange).toHaveBeenCalledWith(1, 5);
    });

    it('draws the range it is handed, with no store behind it', () => {
      renderPhraseRuler({ start: 2, end: 6 });

      expect(screen.getByTestId('loop-range')).toHaveStyle({
        left: `${2 * PIXELS_PER_BEAT}px`,
        width: `${4 * PIXELS_PER_BEAT}px`,
      });
    });

    it('clears with nulls on a click that never moved', () => {
      const onRangeChange = renderPhraseRuler({ start: 2, end: 6 });

      const ruler = screen.getByTestId('timeline-ruler');
      fireEvent.pointerDown(ruler, { clientX: 3 * PIXELS_PER_BEAT, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 3 * PIXELS_PER_BEAT, pointerId: 1 });

      expect(onRangeChange).toHaveBeenCalledWith(null, null);
    });

    // The menu is the surface's, not the ruler's: a surface that hands in no bar
    // actions has none to offer, and the right-click falls through to nothing.
    it('offers no bar menu without bar actions', () => {
      renderPhraseRuler();
      fireEvent.contextMenu(screen.getByTestId('timeline-ruler'), { clientX: 0 });

      expect(screen.queryByTestId('bar-menu')).not.toBeInTheDocument();
    });
  });
});

/** Drag across the ruler. jsdom zeroes the rect, so clientX reads as beats. */
function dragRuler(fromBeat: number, toBeat: number) {
  const ruler = screen.getByTestId('timeline-ruler');
  fireEvent.pointerDown(ruler, { clientX: fromBeat * PIXELS_PER_BEAT, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: toBeat * PIXELS_PER_BEAT, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: toBeat * PIXELS_PER_BEAT, pointerId: 1 });
}
