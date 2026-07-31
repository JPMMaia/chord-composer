import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, createEvent, within } from '@testing-library/react';
import { ChordTimeline, PIXELS_PER_BEAT } from '@/components/ChordTimeline';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { getPaletteItems } from '@/engine/palette';
import type { PaletteItem } from '@/engine/palette';
import type { ChordSegment } from '@/types/music';
import { PIANO_KEYS_WIDTH } from '@/utils/constants';

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

describe('ChordTimeline', () => {
  beforeEach(() => {
    selectionStore.getState().clearSelection();
    projectStore.getState().createProject();
    projectStore.getState().addBar();
    projectStore.getState().addBar();
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

  it('pushes the fifth segment of a 4/4 bar into the next bar', () => {
    render(<ChordTimeline />);
    const items = cMajorChords();
    for (let i = 0; i < 5; i++) {
      dropAt(bars()[0].id, items[i], 4);
    }

    expect(bars()[0].chords).toHaveLength(4);
    expect(bars()[1].chords).toHaveLength(1);
  });

  it('inserts before a segment when dropped on its left half', () => {
    render(<ChordTimeline />);
    const items = cMajorChords();
    dropAt(bars()[0].id, items[4], 0); // G
    dropAt(bars()[0].id, items[0], 0.25); // C, onto the left half of G

    expect(segments().map(s => s.root)).toEqual(['C', 'G']);
  });

  it('renders a block per segment, labelled with its symbol and numeral', () => {
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[1], 0);

    const block = screen.getByTestId(`chord-block-${segments()[0].id}`);
    expect(within(block).getByText('Dm')).toBeInTheDocument();
    expect(within(block).getByText('ii')).toBeInTheDocument();
  });

  it('renders a note segment with its note name', () => {
    render(<ChordTimeline />);
    const noteItem = getPaletteItems({ root: 'C', type: 'major' }, 'notes')[2]; // E
    dropAt(bars()[0].id, noteItem, 0);

    const block = screen.getByTestId(`chord-block-${segments()[0].id}`);
    expect(within(block).getByText('E')).toBeInTheDocument();
    expect(bars()[0].notes.map(n => n.pitch)).toEqual([64]);
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
    dropAt(bars()[0].id, items[4], 4); // G, after it

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

  it('reorders a segment with the arrow keys', () => {
    render(<ChordTimeline />);
    const items = cMajorChords();
    dropAt(bars()[0].id, items[0], 0); // C
    dropAt(bars()[0].id, items[4], 4); // G

    const first = screen.getByTestId(`chord-block-${segments()[0].id}`);
    fireEvent.keyDown(first, { key: 'ArrowRight' });

    expect(segments().map(s => s.root)).toEqual(['G', 'C']);
  });

  it('reserves a gutter matching the piano roll key column, so bar 1 lines up', () => {
    render(<ChordTimeline />);

    const gutter = screen.getByTestId('timeline-gutter');
    expect(gutter).toHaveStyle({ width: `${PIANO_KEYS_WIDTH}px` });
    // The gutter must sit outside the scrolling lanes, as the piano roll's key
    // column does, or scrolling would slide bar 1 out from under the grid.
    expect(gutter.parentElement).not.toBe(screen.getByTestId('timeline-scroll'));
  });

  it('offers no Add Chord, chord-symbol field or Auto-Fill control', () => {
    render(<ChordTimeline />);
    expect(screen.queryByText(/add chord/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/auto-fill/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
