import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, createEvent, within, act } from '@testing-library/react';
import { ChordTimeline } from '@/components/ChordTimeline';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { getPaletteItems } from '@/engine/palette';
import type { PaletteItem } from '@/engine/palette';
import type { ChordSegment } from '@/types/music';
import { DEFAULT_SNAP_BEATS } from '@/engine/timeline';
import { PIANO_KEYS_WIDTH, PIXELS_PER_BEAT } from '@/utils/constants';

/** Minimal stand-in for the DataTransfer jsdom does not implement. */
function makeDataTransfer(item: PaletteItem) {
  const data: Record<string, string> = {
    'application/x-palette-item': JSON.stringify(item),
    'text/plain': item.id,
  };
  return {
    setData: vi.fn(),
    getData: (type: string) => data[type] ?? '',
    types: Object.keys(data),
    dropEffect: 'none',
  };
}

const cMajorChords = () => getPaletteItems({ root: 'C', type: 'major' }, 'chords');

function bars() {
  return projectStore.getState().project!.bars;
}

function segments(): ChordSegment[] {
  return bars().flatMap(b => b.chords);
}

/** `id@start` for a bar's blocks, so placement assertions read at a glance. */
function layout(barIndex: number): string[] {
  return bars()[barIndex].chords.map(c => `${c.id}@${c.startBeat}`);
}

/**
 * Fire a drag event carrying a real `clientX`.
 *
 * `fireEvent.drop(el, { clientX })` silently loses the coordinate: jsdom has no
 * `DragEvent`, so Testing Library falls back to a plain `Event` whose init ignores
 * mouse properties. Building the event and defining `clientX` on it works.
 */
function fireDrag(el: HTMLElement, type: 'dragOver' | 'drop', dataTransfer: unknown, clientX: number) {
  const event = createEvent[type](el, { dataTransfer });
  Object.defineProperty(event, 'clientX', { value: clientX });
  fireEvent(el, event);
}

/**
 * Drop a palette item into a bar's lane at `beat` beats from that bar's start.
 * jsdom reports a zeroed bounding rect, so clientX is the offset within the lane.
 */
function dropAt(barId: string, item: PaletteItem, beat: number) {
  const lane = screen.getByTestId(`timeline-lane-${barId}`);
  const dataTransfer = makeDataTransfer(item);
  fireDrag(lane, 'dragOver', dataTransfer, beat * PIXELS_PER_BEAT);
  fireDrag(lane, 'drop', dataTransfer, beat * PIXELS_PER_BEAT);
}

/**
 * Drag a block from `fromBeat` to `toBeat` with the pointer.
 *
 * `document.elementFromPoint` is stubbed to the destination lane: jsdom has no
 * layout engine, so hit-testing has to be told what the pointer is over.
 */
function dragBlock(segmentId: string, toBarId: string, fromBeat: number, toBeat: number) {
  const block = screen.getByTestId(`chord-block-${segmentId}`);
  const target = screen.getByTestId(`timeline-lane-${toBarId}`);
  document.elementFromPoint = () => target;

  fireEvent.pointerDown(block, { clientX: fromBeat * PIXELS_PER_BEAT, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: toBeat * PIXELS_PER_BEAT, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: toBeat * PIXELS_PER_BEAT, pointerId: 1 });
}

describe('ChordTimeline', () => {
  const originalElementFromPoint = document.elementFromPoint;

  beforeEach(() => {
    selectionStore.getState().clearSelection();
    editorStore.setState({
      snapBeats: DEFAULT_SNAP_BEATS,
      scrollX: 0,
      maxScrollX: 0,
      viewportWidth: 0,
    });
    projectStore.getState().createProject();
    projectStore.getState().addBar();
    projectStore.getState().addBar();
  });

  afterEach(() => {
    document.elementFromPoint = originalElementFromPoint;
  });

  it('renders one bar element per bar, numbered from 1', () => {
    render(<ChordTimeline />);
    expect(screen.getByText('Bar 1')).toBeInTheDocument();
    expect(screen.getByText('Bar 2')).toBeInTheDocument();
    for (const bar of bars()) {
      expect(screen.getByTestId(`timeline-bar-${bar.id}`)).toBeInTheDocument();
    }
  });

  it('draws one beat gridline per beat and sizes the bar to its capacity', () => {
    render(<ChordTimeline />);
    const bar = bars()[0];
    const el = screen.getByTestId(`timeline-bar-${bar.id}`);

    expect(within(el).getAllByTestId('beat-line')).toHaveLength(4);
    expect(el).toHaveStyle({ width: `${4 * PIXELS_PER_BEAT}px` });
  });

  it('draws bar lines as overlays, so a lane starts on its bar’s beat', () => {
    render(<ChordTimeline />);
    const all = bars();

    // A CSS border would sit *inside* the bar's box, pushing the lane — and every
    // beat line, block and drop position in it — two pixels right of the beat the
    // piano roll draws below. One line per bar, plus the closing one.
    for (const bar of all) {
      const el = screen.getByTestId(`timeline-bar-${bar.id}`);
      expect(el.className).not.toMatch(/border-[lr]-2/);
      // Tailwind's stylesheet is not loaded under jsdom, so the class is the
      // observable proof that the line is taken out of the flow.
      expect(within(el).getAllByTestId('bar-line')[0].className).toMatch(/\babsolute\b/);
    }
    expect(screen.getAllByTestId('bar-line')).toHaveLength(all.length + 1);
  });

  it('narrows a bar and drops its gridlines when its time signature changes', () => {
    render(<ChordTimeline />);
    const bar = bars()[0];

    fireEvent.change(screen.getByLabelText('Time signature for bar 1'), {
      target: { value: '3/4' },
    });

    expect(projectStore.getState().project!.bars[0].timeSignature).toEqual({
      beatsPerMeasure: 3,
      beatUnit: 4,
    });
    const el = screen.getByTestId(`timeline-bar-${bar.id}`);
    expect(within(el).getAllByTestId('beat-line')).toHaveLength(3);
    expect(el).toHaveStyle({ width: `${3 * PIXELS_PER_BEAT}px` });
  });

  it('inserts a one-beat segment when a palette item is dropped', () => {
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[0], 0);

    expect(segments()).toHaveLength(1);
    expect(segments()[0]).toMatchObject({ kind: 'chord', root: 'C', duration: 1 });
  });

  it('regenerates the bar notes so the piano roll follows the drop', () => {
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[0], 0);

    // C major triad in the middle-C octave.
    expect(bars()[0].notes.map(n => n.pitch)).toEqual([60, 64, 67]);
  });

  describe('grid snapping', () => {
    it('offers the snap resolutions as note values', () => {
      render(<ChordTimeline />);
      const select = screen.getByLabelText('Snap') as HTMLSelectElement;
      expect([...select.options].map(o => o.text)).toEqual([
        '1/1',
        '1/2',
        '1/4',
        '1/8',
        '1/16',
      ]);
    });

    it('records the chosen resolution so every gesture shares it', () => {
      render(<ChordTimeline />);
      fireEvent.change(screen.getByLabelText('Snap'), { target: { value: '0.5' } });
      expect(editorStore.getState().snapBeats).toBe(0.5);
    });

    it('snaps a drop to the nearest whole beat at 1/4', () => {
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 1.4);
      expect(segments()[0].startBeat).toBe(1);
    });

    it('snaps a drop to the nearest half beat at 1/8', () => {
      editorStore.getState().setSnapBeats(0.5);
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 1.4);
      expect(segments()[0].startBeat).toBe(1.5);
    });

    it('draws subdivision lines when the grid is finer than a beat', () => {
      editorStore.getState().setSnapBeats(0.5);
      render(<ChordTimeline />);
      const el = screen.getByTestId(`timeline-bar-${bars()[0].id}`);
      // Four beats at 1/8: a line on each half beat that is not already a beat line.
      expect(within(el).getAllByTestId('subdivision-line')).toHaveLength(4);
    });

    it('draws no subdivision lines at a whole-beat grid', () => {
      render(<ChordTimeline />);
      const el = screen.getByTestId(`timeline-bar-${bars()[0].id}`);
      expect(within(el).queryAllByTestId('subdivision-line')).toHaveLength(0);
    });
  });

  describe('placement', () => {
    it('leaves the space before a dropped block empty', () => {
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 2);

      expect(segments()[0].startBeat).toBe(2);
      expect(bars()[0].notes.every(n => n.startBeat === 2)).toBe(true);
    });

    it('pushes the block it is dropped on to the right', () => {
      render(<ChordTimeline />);
      const items = cMajorChords();
      dropAt(bars()[0].id, items[0], 0); // C
      dropAt(bars()[0].id, items[4], 0); // G, on top of it

      expect(segments().map(s => s.root)).toEqual(['G', 'C']);
      expect(layout(0).map(s => s.split('@')[1])).toEqual(['0', '1']);
    });

    it('clamps a drop that would cross the bar line', () => {
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 9);
      expect(segments()[0].startBeat).toBe(3);
    });
  });

  describe('dragging a block', () => {
    it('moves a block to the beat it was dragged to', () => {
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 0);
      const id = segments()[0].id;

      dragBlock(id, bars()[0].id, 0, 2);

      expect(segments()[0].startBeat).toBe(2);
    });

    it('snaps the drag to the grid', () => {
      editorStore.getState().setSnapBeats(0.5);
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 0);
      const id = segments()[0].id;

      dragBlock(id, bars()[0].id, 0, 1.4);

      expect(segments()[0].startBeat).toBe(1.5);
    });

    it('moves a block into another bar', () => {
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 0);
      const id = segments()[0].id;

      dragBlock(id, bars()[1].id, 0, 1);

      expect(bars()[0].chords).toHaveLength(0);
      expect(layout(1)).toEqual([`${id}@1`]);
    });

    it('keeps the grab point under the pointer instead of jumping', () => {
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 0);
      const id = segments()[0].id;

      // Grabbed halfway along the block, dragged two beats right.
      dragBlock(id, bars()[0].id, 0.5, 2.5);

      expect(segments()[0].startBeat).toBe(2);
    });

    it('does not select the block when the gesture was a drag', () => {
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 0);
      const id = segments()[0].id;
      selectionStore.getState().clearSelection();

      dragBlock(id, bars()[0].id, 0, 2);
      fireEvent.click(screen.getByTestId(`chord-block-${id}`));

      expect(selectionStore.getState().selectedSegmentId).toBeNull();
    });

    it('still selects on a click that never moved', () => {
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 0);
      const id = segments()[0].id;

      const block = screen.getByTestId(`chord-block-${id}`);
      fireEvent.pointerDown(block, { clientX: 0, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 0, pointerId: 1 });
      fireEvent.click(block);

      expect(selectionStore.getState().selectedSegmentId).toBe(id);
    });
  });

  it('renders a block per segment, labelled with its symbol and numeral', () => {
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[1], 0);

    const block = screen.getByTestId(`chord-block-${segments()[0].id}`);
    expect(within(block).getByText('Dm')).toBeInTheDocument();
    expect(within(block).getByText('ii')).toBeInTheDocument();
  });

  it('renders a note segment with its note name and octave', () => {
    render(<ChordTimeline />);
    const noteItem = getPaletteItems({ root: 'C', type: 'major' }, 'notes')[2]; // E
    dropAt(bars()[0].id, noteItem, 0);

    const block = screen.getByTestId(`chord-block-${segments()[0].id}`);
    expect(within(block).getByText('E4')).toBeInTheDocument();
    expect(bars()[0].notes.map(n => n.pitch)).toEqual([64]);
  });

  it('badges a chord segment with its octave, but not a note segment', () => {
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[0], 0);
    dropAt(bars()[0].id, getPaletteItems({ root: 'C', type: 'major' }, 'notes')[0], 2);

    const [chord, note] = segments();
    expect(screen.getByTestId(`octave-badge-${chord.id}`)).toHaveTextContent('oct 4');
    expect(screen.queryByTestId(`octave-badge-${note.id}`)).not.toBeInTheDocument();
  });

  it('shows different badges for chords dropped from different octaves', () => {
    const scale = { root: 'C', type: 'major' } as const;
    render(<ChordTimeline />);
    dropAt(bars()[0].id, getPaletteItems(scale, 'chords', 3)[0], 0);
    dropAt(bars()[0].id, getPaletteItems(scale, 'chords', 6)[0], 2);

    const [low, high] = segments();
    expect(screen.getByTestId(`octave-badge-${low.id}`)).toHaveTextContent('oct 3');
    expect(screen.getByTestId(`octave-badge-${high.id}`)).toHaveTextContent('oct 6');
    // And the generated notes really are three octaves apart.
    const pitches = bars()[0].notes.map(n => n.pitch);
    expect(pitches.slice(3)).toEqual(pitches.slice(0, 3).map(p => p + 36));
  });

  it('marks an inverted chord beside its octave, and says nothing in root position', () => {
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[0], 0);
    const chord = segments()[0];

    expect(screen.getByTestId(`octave-badge-${chord.id}`)).toHaveTextContent(/^oct 4$/);

    act(() => projectStore.getState().cycleSegmentInversion(chord.id));
    expect(screen.getByTestId(`octave-badge-${chord.id}`)).toHaveTextContent('oct 4 · 1st');

    act(() => projectStore.getState().cycleSegmentInversion(chord.id));
    expect(screen.getByTestId(`octave-badge-${chord.id}`)).toHaveTextContent('oct 4 · 2nd');

    // The badge is a visual shorthand, so the voicing has to be spelt out for
    // anyone reading the block through the accessible name instead.
    expect(screen.getByTestId(`chord-block-${chord.id}`)).toHaveAttribute(
      'aria-label',
      'Chord C octave 4 2nd inversion'
    );
  });

  it('selects a bar when it is clicked', () => {
    render(<ChordTimeline />);
    fireEvent.click(screen.getByTestId(`timeline-lane-${bars()[1].id}`));
    expect(selectionStore.getState().selectedBarId).toBe(bars()[1].id);
  });

  it('selects a segment when it is clicked', () => {
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[0], 0);
    const id = segments()[0].id;

    fireEvent.click(screen.getByTestId(`chord-block-${id}`));

    expect(selectionStore.getState().selectedSegmentId).toBe(id);
    expect(selectionStore.getState().selectedBarId).toBe(bars()[0].id);
  });

  it('removes a segment via its remove button', () => {
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[0], 0);

    fireEvent.click(screen.getByLabelText('Remove segment'));

    expect(segments()).toHaveLength(0);
    expect(bars()[0].notes).toHaveLength(0);
  });

  it('sizes each block to its duration and places it at its start beat', () => {
    render(<ChordTimeline />);
    const items = cMajorChords();
    dropAt(bars()[0].id, items[0], 0); // C
    dropAt(bars()[0].id, items[4], 1); // G, after it

    const [c, g] = segments();
    expect(screen.getByTestId(`chord-block-${c.id}`)).toHaveStyle({
      left: '0px',
      width: `${PIXELS_PER_BEAT}px`,
    });
    expect(screen.getByTestId(`chord-block-${g.id}`)).toHaveStyle({
      left: `${PIXELS_PER_BEAT}px`,
      width: `${PIXELS_PER_BEAT}px`,
    });
  });

  it('positions a block dropped into empty space at its own beat', () => {
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[0], 3);

    expect(screen.getByTestId(`chord-block-${segments()[0].id}`)).toHaveStyle({
      left: `${3 * PIXELS_PER_BEAT}px`,
    });
  });

  it('resizes a segment by dragging its right edge', () => {
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[0], 0);
    const id = segments()[0].id;

    const handle = screen.getByTestId(`resize-handle-${id}`);
    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: PIXELS_PER_BEAT, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: PIXELS_PER_BEAT, pointerId: 1 });

    expect(segments()[0].duration).toBe(2);
    expect(bars()[0].notes[0].duration).toBe(2);
    // The block must widen with it, or the timeline stops matching the piano roll.
    expect(screen.getByTestId(`chord-block-${id}`)).toHaveStyle({
      width: `${2 * PIXELS_PER_BEAT}px`,
    });
  });

  it('nudges a segment by one snap step with the arrow keys', () => {
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[0], 1);
    const id = segments()[0].id;
    const block = screen.getByTestId(`chord-block-${id}`);

    fireEvent.keyDown(block, { key: 'ArrowRight' });
    expect(segments()[0].startBeat).toBe(2);

    fireEvent.keyDown(screen.getByTestId(`chord-block-${id}`), { key: 'ArrowLeft' });
    expect(segments()[0].startBeat).toBe(1);
  });

  it('nudges by the current snap resolution, not always a whole beat', () => {
    editorStore.getState().setSnapBeats(0.5);
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[0], 1);

    fireEvent.keyDown(screen.getByTestId(`chord-block-${segments()[0].id}`), {
      key: 'ArrowRight',
    });
    expect(segments()[0].startBeat).toBe(1.5);
  });

  it('reserves a gutter matching the piano roll key column, so bar 1 lines up', () => {
    render(<ChordTimeline />);

    const gutter = screen.getByTestId('timeline-gutter');
    expect(gutter).toHaveStyle({ width: `${PIANO_KEYS_WIDTH}px` });
    // The gutter must sit outside the scrolling lanes, as the piano roll's key
    // column does, or scrolling would slide bar 1 out from under the grid.
    expect(gutter.parentElement).not.toBe(screen.getByTestId('timeline-scroll'));
  });

  describe('shared horizontal scroll', () => {
    /** jsdom has no layout, so `scrollLeft` needs a backing store to be observable. */
    function stubScrollLeft(element: HTMLElement) {
      let value = 0;
      Object.defineProperty(element, 'scrollLeft', {
        configurable: true,
        get: () => value,
        set: (next: number) => {
          value = next;
        },
      });
    }

    it('publishes its scroll position to the shared offset', () => {
      editorStore.getState().setScrollExtent(2000, 800);
      render(<ChordTimeline />);

      const scroller = screen.getByTestId('timeline-scroll');
      stubScrollLeft(scroller);
      scroller.scrollLeft = 240;
      fireEvent.scroll(scroller);

      expect(editorStore.getState().scrollX).toBe(240);
    });

    it('follows the shared offset when the piano roll or the scrollbar moves it', () => {
      editorStore.getState().setScrollExtent(2000, 800);
      render(<ChordTimeline />);

      const scroller = screen.getByTestId('timeline-scroll');
      stubScrollLeft(scroller);

      act(() => {
        editorStore.getState().setScrollX(600);
      });

      expect(scroller.scrollLeft).toBe(600);
    });

    it('draws no scrollbar of its own — the editor has one at the bottom', () => {
      render(<ChordTimeline />);
      const scroller = screen.getByTestId('timeline-scroll');
      // Still scrollable, so wheel and trackpad keep working over the lanes.
      expect(scroller.className).toContain('overflow-x-auto');
      expect(scroller.className).toContain('scrollbar-hidden');
    });
  });

  describe('play range', () => {
    const loop = () => {
      const { loopStart, loopEnd } = projectStore.getState().project!;
      return [loopStart, loopEnd];
    };

    /** Drag across the ruler. jsdom zeroes the rect, so clientX reads as beats. */
    function dragRuler(fromBeat: number, toBeat: number) {
      const ruler = screen.getByTestId('timeline-ruler');
      fireEvent.pointerDown(ruler, { clientX: fromBeat * PIXELS_PER_BEAT, pointerId: 1 });
      fireEvent.pointerMove(window, { clientX: toBeat * PIXELS_PER_BEAT, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: toBeat * PIXELS_PER_BEAT, pointerId: 1 });
    }

    it('sets the range from a drag across the ruler', () => {
      render(<ChordTimeline />);
      dragRuler(1, 5);

      expect(loop()).toEqual([1, 5]);
      expect(screen.getByTestId('loop-range')).toHaveStyle({
        left: `${1 * PIXELS_PER_BEAT}px`,
        width: `${4 * PIXELS_PER_BEAT}px`,
      });
    });

    it('reads a backwards drag as the same range', () => {
      render(<ChordTimeline />);
      dragRuler(6, 2);

      expect(loop()).toEqual([2, 6]);
    });

    it('snaps the range to the grid', () => {
      editorStore.getState().setSnapBeats(0.5);
      render(<ChordTimeline />);
      dragRuler(0.9, 3.4);

      expect(loop()).toEqual([1, 3.5]);
    });

    it('clears the range on a click that never moved', () => {
      render(<ChordTimeline />);
      dragRuler(1, 5);

      const ruler = screen.getByTestId('timeline-ruler');
      fireEvent.pointerDown(ruler, { clientX: 3 * PIXELS_PER_BEAT, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 3 * PIXELS_PER_BEAT, pointerId: 1 });

      expect(loop()).toEqual([undefined, undefined]);
      expect(screen.queryByTestId('loop-range')).not.toBeInTheDocument();
    });

    it('resizes the range by its end handle, leaving the start put', () => {
      render(<ChordTimeline />);
      dragRuler(1, 5);

      const handle = screen.getByRole('button', { name: 'Loop end' });
      fireEvent.pointerDown(handle, { clientX: 5 * PIXELS_PER_BEAT, pointerId: 1 });
      fireEvent.pointerMove(window, { clientX: 7 * PIXELS_PER_BEAT, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 7 * PIXELS_PER_BEAT, pointerId: 1 });

      expect(loop()).toEqual([1, 7]);
    });

    it('renders no range until one is drawn', () => {
      render(<ChordTimeline />);
      expect(screen.queryByTestId('loop-range')).not.toBeInTheDocument();
    });
  });

  it('offers no Add Chord, chord-symbol field or Auto-Fill control', () => {
    render(<ChordTimeline />);
    expect(screen.queryByText(/add chord/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/auto-fill/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
