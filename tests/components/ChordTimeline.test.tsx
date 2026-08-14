import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  createEvent,
  within,
  act,
  cleanup,
} from '@testing-library/react';
import { ChordTimeline } from '@/components/ChordTimeline';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { getPaletteItems } from '@/engine/palette';
import type { PaletteItem } from '@/engine/palette';
import { type MelodicFormula } from '@/engine/formulas';
import { emptyLibrary, serializeLibrary, withGroup } from '@/engine/formulaLibrary';
import { formulaLibraryStore } from '@/store/formulaLibraryStore';
import type { ChordSegment } from '@/types/music';
import { barChords, barNotes, DEFAULT_SNAP_BEATS } from '@/engine/timeline';
import { PIANO_KEYS_WIDTH, PIXELS_PER_BEAT } from '@/utils/constants';

/** Two formulas to drag, written here rather than fetched from a library. */
const TORCULUS: MelodicFormula = {
  id: 'torculus',
  name: 'Torculus',
  steps: [
    { degree: 0, beats: 1 },
    { degree: 1, beats: 1 },
    { degree: 0, beats: 1 },
  ],
};

const ARCH: MelodicFormula = {
  id: 'arch',
  name: 'Arch',
  steps: [0, 1, 2, 3, 2, 1, 0].map(degree => ({ degree, beats: 1 })),
};

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

function tracks() {
  return projectStore.getState().project!.tracks;
}

/** The instrument the timeline is editing — the Piano every project starts with. */
function trackId(): string {
  return tracks()[0].id;
}

function segments(): ChordSegment[] {
  return bars().flatMap(b => barChords(b, trackId()));
}

/** `id@start` for a bar's blocks, so placement assertions read at a glance. */
function layout(barIndex: number): string[] {
  return barChords(bars()[barIndex], trackId()).map(c => `${c.id}@${c.startBeat}`);
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

/** One bar's sub-lane row. Lane 0 is the only one most tests care about. */
function laneEl(barId: string, lane = 0): HTMLElement {
  return screen.getByTestId(`timeline-lane-${barId}-${lane}`);
}

/**
 * Drop a palette item into a bar's lane at `beat` beats from that bar's start.
 * jsdom reports a zeroed bounding rect, so clientX is the offset within the lane.
 */
function dropAt(barId: string, item: PaletteItem, beat: number, lane = 0) {
  const target = laneEl(barId, lane);
  const dataTransfer = makeDataTransfer(item);
  fireDrag(target, 'dragOver', dataTransfer, beat * PIXELS_PER_BEAT);
  fireDrag(target, 'drop', dataTransfer, beat * PIXELS_PER_BEAT);
}

/** The dragged-formula counterpart of `makeDataTransfer`. */
function makeFormulaDataTransfer(formula: MelodicFormula) {
  const data: Record<string, string> = {
    'application/x-melodic-formula': JSON.stringify(formula),
    'text/plain': formula.id,
  };
  return {
    setData: vi.fn(),
    getData: (type: string) => data[type] ?? '',
    types: Object.keys(data),
    dropEffect: 'none',
  };
}

/** Drop a whole formula into a bar's lane at `beat` beats from that bar's start. */
function dropFormulaAt(barId: string, formula: MelodicFormula, beat: number, lane = 0) {
  const target = laneEl(barId, lane);
  const dataTransfer = makeFormulaDataTransfer(formula);
  fireDrag(target, 'dragOver', dataTransfer, beat * PIXELS_PER_BEAT);
  fireDrag(target, 'drop', dataTransfer, beat * PIXELS_PER_BEAT);
}

/**
 * Drag a block from `fromBeat` to `toBeat` with the pointer.
 *
 * `document.elementFromPoint` is stubbed to the destination lane: jsdom has no
 * layout engine, so hit-testing has to be told what the pointer is over.
 */
function dragBlock(
  segmentId: string,
  toBarId: string,
  fromBeat: number,
  toBeat: number,
  toLane = 0
) {
  const block = screen.getByTestId(`chord-block-${segmentId}`);
  const target = laneEl(toBarId, toLane);
  document.elementFromPoint = () => target;

  fireEvent.pointerDown(block, { clientX: fromBeat * PIXELS_PER_BEAT, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: toBeat * PIXELS_PER_BEAT, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: toBeat * PIXELS_PER_BEAT, pointerId: 1 });
}

/** The ids currently selected, in selection order. */
function selected(): string[] {
  return selectionStore.getState().selectedSegmentIds;
}

/**
 * Press a block, the gesture that selects it. Selection happens on pointerdown, not
 * on click, so that no re-render can move the node out from under the gesture.
 */
function press(segmentId: string, modifiers: Partial<PointerEventInit> = {}) {
  fireEvent.pointerDown(screen.getByTestId(`chord-block-${segmentId}`), {
    clientX: 0,
    pointerId: 1,
    ...modifiers,
  });
  fireEvent.pointerUp(window, { clientX: 0, pointerId: 1 });
}

describe('ChordTimeline', () => {
  const originalElementFromPoint = document.elementFromPoint;

  beforeEach(() => {
    selectionStore.getState().clearSelection();
    editorStore.setState({
      snapBeats: DEFAULT_SNAP_BEATS,
      pixelsPerBeat: PIXELS_PER_BEAT,
      scrollX: 0,
      maxScrollX: 0,
      viewportWidth: 0,
      showAutomation: true,
      paletteScale: { root: 'C', type: 'major' },
      paletteOctave: 4,
      formulaStartDegree: 0,
      draggingFormulaId: null,
    });
    projectStore.getState().createProject();
    projectStore.getState().addBar();
    projectStore.getState().addBar();
    // The timeline edits one instrument, so it needs one selected to show lanes.
    selectionStore.getState().selectTrack(trackId());
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
    expect(barNotes(bars()[0], trackId()).map(n => n.pitch)).toEqual([60, 64, 67]);
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
        '1/32',
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

    it("draws the metre's own subdivisions even at a whole-beat grid", () => {
      render(<ChordTimeline />);
      const el = screen.getByTestId(`timeline-bar-${bars()[0].id}`);
      // 4/4 is simple: an eighth between each of the four quarter-note beats. These
      // are the metre's, not the snap grid's, so they are drawn regardless of snap.
      expect(within(el).getAllByTestId('subdivision-line')).toHaveLength(4);
    });

    it('draws a line on every thirty-second at the finest grid', () => {
      editorStore.getState().setSnapBeats(0.125);
      render(<ChordTimeline />);
      const el = screen.getByTestId(`timeline-bar-${bars()[0].id}`);
      // Thirty-two thirty-seconds in a 4/4 bar, less the four that are already
      // beat lines.
      expect(within(el).getAllByTestId('subdivision-line')).toHaveLength(28);
    });

    it('snaps a drop to the nearest thirty-second at 1/32', () => {
      editorStore.getState().setSnapBeats(0.125);
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 1.4);
      expect(segments()[0].startBeat).toBe(1.375);
    });
  });

  describe('zoom', () => {
    it('offers the zoom levels as percentages of the default scale', () => {
      render(<ChordTimeline />);
      const select = screen.getByLabelText('Zoom') as HTMLSelectElement;
      expect([...select.options].map(o => o.text)).toEqual(['50%', '100%', '200%', '400%']);
    });

    it('records the chosen level so every pane shares it', () => {
      render(<ChordTimeline />);
      fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '160' } });
      expect(editorStore.getState().pixelsPerBeat).toBe(160);
    });

    it('widens the bars it draws when zoomed in', () => {
      const widthOf = () =>
        screen.getByTestId(`timeline-bar-${bars()[0].id}`).style.width;

      const { unmount } = render(<ChordTimeline />);
      expect(widthOf()).toBe(`${4 * PIXELS_PER_BEAT}px`);
      unmount();

      editorStore.getState().setPixelsPerBeat(160);
      render(<ChordTimeline />);
      expect(widthOf()).toBe(`${4 * 160}px`);
    });
  });

  describe('metre', () => {
    /** Give the first bar its own time signature and render. */
    function renderWithMeter(beatsPerMeasure: number, beatUnit: number) {
      act(() => {
        projectStore.getState().setBarTimeSignature(bars()[0].id, { beatsPerMeasure, beatUnit });
      });
      render(<ChordTimeline />);
      return screen.getByTestId(`timeline-bar-${bars()[0].id}`);
    }

    it('gives a 6/8 bar the same width as a 3/4 bar', () => {
      const threeFour = renderWithMeter(3, 4);
      const width = threeFour.style.width;
      cleanup();

      const sixEight = renderWithMeter(6, 8);
      // Six eighths and three quarters are the same length, so the bars match.
      expect(sixEight.style.width).toBe(width);
      expect(width).toBe(`${3 * PIXELS_PER_BEAT}px`);
    });

    it('counts a 3/4 bar in three and a 6/8 bar in two', () => {
      const threeFour = renderWithMeter(3, 4);
      expect(within(threeFour).getAllByTestId('beat-line')).toHaveLength(3);
      cleanup();

      const sixEight = renderWithMeter(6, 8);
      // Compound duple: two dotted-quarter beats, not six quarters and not three.
      expect(within(sixEight).getAllByTestId('beat-line')).toHaveLength(2);
    });

    it('groups a 6/8 bar into threes and a 3/4 bar into twos', () => {
      const threeFour = renderWithMeter(3, 4);
      // One eighth inside each of three beats.
      expect(within(threeFour).getAllByTestId('subdivision-line')).toHaveLength(3);
      cleanup();

      const sixEight = renderWithMeter(6, 8);
      // Two eighths inside each of two beats — the same six eighths, grouped
      // differently, which is the whole difference between the two metres.
      expect(within(sixEight).getAllByTestId('subdivision-line')).toHaveLength(4);
    });

    it('says how each metre counts in the bar header', () => {
      const threeFour = renderWithMeter(3, 4);
      expect(within(threeFour).getByTestId('bar-meter')).toHaveTextContent(
        '3 beats · 3 quarters'
      );
      cleanup();

      const sixEight = renderWithMeter(6, 8);
      expect(within(sixEight).getByTestId('bar-meter')).toHaveTextContent(
        '2 beats · 6 eighths'
      );
    });
  });

  describe('placement', () => {
    it('leaves the space before a dropped block empty', () => {
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 2);

      expect(segments()[0].startBeat).toBe(2);
      expect(barNotes(bars()[0], trackId()).every(n => n.startBeat === 2)).toBe(true);
    });

    it('pushes the block it is dropped on to the right', () => {
      render(<ChordTimeline />);
      const items = cMajorChords();
      dropAt(bars()[0].id, items[0], 0); // C
      dropAt(bars()[0].id, items[4], 0); // G, on top of it

      expect(segments().map(s => s.root)).toEqual(['G', 'C']);
      expect(layout(0).map(s => s.split('@')[1])).toEqual(['0', '1']);
    });

    it('holds a drop past the bar line to the last onset the bar has', () => {
      // The block may hang over the bar line, but it has to begin inside the bar
      // that caught the drop.
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 9);
      expect(segments()[0].startBeat).toBe(3.875);
    });
  });

  describe('dropping a melodic formula', () => {
    /** `pitch@bar:start` per block, in project order. */
    function phrase(): string[] {
      return bars().flatMap((bar, index) =>
        barChords(bar, trackId()).map(c => `${c.pitch}@${index}:${c.startBeat}`)
      );
    }

    it('creates one note block per step of the formula', () => {
      render(<ChordTimeline />);
      dropFormulaAt(bars()[0].id, TORCULUS, 0);

      expect(segments()).toHaveLength(3);
      expect(segments().every(s => s.kind === 'note')).toBe(true);
      expect(phrase()).toEqual(['60@0:0', '62@0:1', '60@0:2']);
    });

    it('realizes the phrase in the palette’s key and register', () => {
      editorStore.setState({
        paletteScale: { root: 'A', type: 'naturalMinor' },
        paletteOctave: 5,
      });
      render(<ChordTimeline />);
      dropFormulaAt(bars()[0].id, TORCULUS, 0);

      expect(segments().map(s => s.pitch)).toEqual([81, 83, 81]);
      expect(segments()[0].scale).toEqual({ root: 'A', type: 'naturalMinor' });
    });

    it('moves the whole shape when the start degree moves', () => {
      editorStore.setState({ formulaStartDegree: 4 });
      render(<ChordTimeline />);
      dropFormulaAt(bars()[0].id, TORCULUS, 0);

      expect(segments().map(s => s.pitch)).toEqual([67, 69, 67]);
    });

    it('spills a phrase longer than the bar into the bars that follow', () => {
      render(<ChordTimeline />);
      // Seven beats of arch dropped on beat 2 of a 4/4 bar: two notes fit, the
      // rest belong to the bars after it.
      dropFormulaAt(bars()[0].id, ARCH, 2);

      expect(segments()).toHaveLength(7);
      expect(phrase()).toEqual([
        '60@0:2',
        '62@0:3',
        '64@1:0',
        '65@1:1',
        '64@1:2',
        '62@1:3',
        '60@2:0',
      ]);
    });

    it('appends the bars a phrase running off the end of the project needs', () => {
      render(<ChordTimeline />);
      const barsBefore = bars().length;
      dropFormulaAt(bars()[barsBefore - 1].id, ARCH, 2);

      // Two beats fit in the bar that caught it; the remaining five need two more.
      expect(bars()).toHaveLength(barsBefore + 2);
      expect(segments()).toHaveLength(7);
      expect(phrase()[6]).toBe(`60@${barsBefore + 1}:0`);
    });

    it('puts the whole phrase in the lane it was dropped on', () => {
      projectStore.getState().setTrackLaneCount(trackId(), 2);
      render(<ChordTimeline />);
      dropFormulaAt(bars()[0].id, TORCULUS, 0, 1);

      expect(segments().map(s => s.lane)).toEqual([1, 1, 1]);
    });

    it('selects the phrase it just dropped', () => {
      render(<ChordTimeline />);
      dropFormulaAt(bars()[0].id, TORCULUS, 0);

      expect(selectionStore.getState().selectedSegmentIds).toEqual(
        segments().map(s => s.id)
      );
    });

    it('writes the project once, so the phrase is a single undo step', () => {
      render(<ChordTimeline />);
      let writes = 0;
      const unsubscribe = projectStore.subscribe(() => {
        writes += 1;
      });
      dropFormulaAt(bars()[0].id, ARCH, 0);
      unsubscribe();

      expect(writes).toBe(1);
    });

    it('sizes the drop caret to the length of the phrase being dragged', () => {
      // The payload is unreadable during a dragover, so the caret measures the
      // formula by id — which means it has to be in an open library.
      const library = withGroup(emptyLibrary('Test'), {
        id: 'g1',
        name: 'Test group',
        formulas: [ARCH],
      });
      formulaLibraryStore.setState({
        libraries: [{ id: 'l1', library, ref: null, savedText: serializeLibrary(library) }],
        selectedLibraryId: 'l1',
        selectedGroupId: 'g1',
      });
      editorStore.setState({ draggingFormulaId: 'arch' });
      render(<ChordTimeline />);
      const target = laneEl(bars()[0].id);
      fireDrag(target, 'dragOver', makeFormulaDataTransfer(ARCH), 0);

      expect(screen.getByTestId('drop-indicator')).toHaveStyle({
        width: `${7 * PIXELS_PER_BEAT}px`,
      });
    });

    it('ignores a malformed formula payload rather than corrupting the timeline', () => {
      render(<ChordTimeline />);
      const target = laneEl(bars()[0].id);
      const dataTransfer = {
        setData: vi.fn(),
        getData: (type: string) =>
          type === 'application/x-melodic-formula' ? 'not json' : '',
        types: ['application/x-melodic-formula'],
        dropEffect: 'none',
      };
      fireDrag(target, 'drop', dataTransfer, 0);

      expect(segments()).toHaveLength(0);
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

      expect(barChords(bars()[0], trackId())).toHaveLength(0);
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

    it('selects the block it grabbed, so the drag and the selection agree', () => {
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 0);
      const id = segments()[0].id;
      selectionStore.getState().clearSelection();

      dragBlock(id, bars()[0].id, 0, 2);

      expect(selected()).toEqual([id]);
      expect(segments()[0].startBeat).toBe(2);
    });

    it('selects on a press that never moved', () => {
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 0);
      const id = segments()[0].id;

      const block = screen.getByTestId(`chord-block-${id}`);
      fireEvent.pointerDown(block, { clientX: 0, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 0, pointerId: 1 });

      expect(selected()).toEqual([id]);
    });

    it('moves every selected block by the same delta', () => {
      render(<ChordTimeline />);
      const items = cMajorChords();
      dropAt(bars()[0].id, items[0], 0);
      dropAt(bars()[0].id, items[4], 2);
      const [first, second] = segments().map(s => s.id);
      selectionStore.getState().setSelectedSegments([first, second]);

      // Grab the first and pull it one beat right; the second must follow.
      dragBlock(first, bars()[0].id, 0, 1);

      expect(layout(0)).toEqual([`${first}@1`, `${second}@3`]);
    });

    it('carries a whole selection across a bar line', () => {
      render(<ChordTimeline />);
      const items = cMajorChords();
      dropAt(bars()[0].id, items[0], 1);
      dropAt(bars()[0].id, items[4], 2);
      const [first, second] = segments().map(s => s.id);
      selectionStore.getState().setSelectedSegments([first, second]);

      dragBlock(first, bars()[1].id, 1, 0);

      expect(barChords(bars()[0], trackId())).toHaveLength(0);
      expect(layout(1)).toEqual([`${first}@0`, `${second}@1`]);
    });

    /** Four blocks filling bar 1, one per beat. */
    function fullBar(): string[] {
      const items = cMajorChords();
      for (let beat = 0; beat < 4; beat++) dropAt(bars()[0].id, items[beat], beat);
      return segments().map(s => s.id);
    }

    // Clamping each block's landing separately used to pile them onto the same beat,
    // and the commit then rippled them apart in reverse: C D E F came back F E D C.
    // The delta is what gets clamped, so the selection keeps its shape or stays put.
    it('does not reverse a selection dragged into the bar line', () => {
      render(<ChordTimeline />);
      const ids = fullBar();
      selectionStore.getState().setSelectedSegments(ids);

      // Far past the end of the bar: the last block already sits against the line,
      // so the whole selection has nowhere to go.
      dragBlock(ids[0], bars()[0].id, 0, 6);

      expect(layout(0)).toEqual(ids.map((id, beat) => `${id}@${beat}`));
    });

    it('keeps the order of a selection dragged past the start of the bar', () => {
      render(<ChordTimeline />);
      const items = cMajorChords();
      dropAt(bars()[0].id, items[0], 1);
      dropAt(bars()[0].id, items[1], 2);
      dropAt(bars()[0].id, items[2], 3);
      const ids = segments().map(s => s.id);
      selectionStore.getState().setSelectedSegments(ids);

      // Three beats left, but the leftmost block only has one to give.
      dragBlock(ids[0], bars()[0].id, 1, -2);

      expect(layout(0)).toEqual([`${ids[0]}@0`, `${ids[1]}@1`, `${ids[2]}@2`]);
    });
  });

  describe('selecting several blocks', () => {
    /** Three blocks in bar 1, at beats 0, 1 and 2. */
    function threeBlocks(): string[] {
      const items = cMajorChords();
      dropAt(bars()[0].id, items[0], 0);
      dropAt(bars()[0].id, items[1], 1);
      dropAt(bars()[0].id, items[2], 2);
      return segments().map(s => s.id);
    }

    // The reported bug: a press on any block but the last did nothing, because the
    // drag preview reordered the lane and the browser retargeted the click to it.
    // Selection now happens on pointerdown, which no re-render can move out from
    // under the gesture.
    it('selects any block in a bar, not only the last', () => {
      render(<ChordTimeline />);
      const [first, middle, last] = threeBlocks();

      press(first);
      expect(selected()).toEqual([first]);

      press(middle);
      expect(selected()).toEqual([middle]);

      press(last);
      expect(selected()).toEqual([last]);
    });

    it('adds and removes a block with Ctrl+click', () => {
      render(<ChordTimeline />);
      const [first, middle, last] = threeBlocks();

      press(first);
      press(last, { ctrlKey: true });
      expect(selected()).toEqual([first, last]);

      press(middle, { metaKey: true });
      expect(selected()).toEqual([first, last, middle]);

      press(last, { ctrlKey: true });
      expect(selected()).toEqual([first, middle]);
    });

    it('selects an inclusive range with Shift+click, across bars', () => {
      render(<ChordTimeline />);
      const [first, middle, last] = threeBlocks();
      dropAt(bars()[1].id, cMajorChords()[3], 0);
      const fourth = segments()[3].id;

      press(middle);
      press(fourth, { shiftKey: true });

      expect(selected()).toEqual([middle, last, fourth]);
    });

    it('keeps a multi-selection when one of its blocks is pressed', () => {
      render(<ChordTimeline />);
      const [first, middle, last] = threeBlocks();
      selectionStore.getState().setSelectedSegments([first, last]);

      press(last);
      expect(selected()).toEqual([first, last]);

      // A press on a block outside the selection replaces it.
      press(middle);
      expect(selected()).toEqual([middle]);
    });

    it('re-anchors a range on the last block pressed, selected or not', () => {
      render(<ChordTimeline />);
      const [first, middle, last] = threeBlocks();

      // A press on a block that is already the whole selection changes nothing
      // about it — but it is still where the next Shift range starts.
      press(last);
      press(last);
      press(first, { shiftKey: true });

      expect(selected()).toEqual([first, middle, last]);
    });

    it('clears the block selection on a press in empty lane space', () => {
      render(<ChordTimeline />);
      const [first, , last] = threeBlocks();
      selectionStore.getState().setSelectedSegments([first, last]);

      fireEvent.pointerDown(laneEl(bars()[1].id));

      expect(selected()).toEqual([]);
      expect(selectionStore.getState().selectedBarId).toBe(bars()[1].id);
    });

    it('drops a deleted block from the selection', () => {
      render(<ChordTimeline />);
      const [first, middle, last] = threeBlocks();
      selectionStore.getState().setSelectedSegments([first, middle, last]);

      fireEvent.click(screen.getAllByLabelText('Remove segment')[1]);

      expect(selected()).toEqual([first, last]);
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
    expect(barNotes(bars()[0], trackId()).map(n => n.pitch)).toEqual([64]);
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
    const pitches = barNotes(bars()[0], trackId()).map(n => n.pitch);
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

  it('selects a bar when its lane is pressed', () => {
    render(<ChordTimeline />);
    fireEvent.pointerDown(laneEl(bars()[1].id));
    expect(selectionStore.getState().selectedBarId).toBe(bars()[1].id);
  });

  it('selects a segment when it is pressed, along with its bar', () => {
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[0], 0);
    const id = segments()[0].id;

    press(id);

    expect(selected()).toEqual([id]);
    expect(selectionStore.getState().selectedBarId).toBe(bars()[0].id);
  });

  it('removes a segment via its remove button', () => {
    render(<ChordTimeline />);
    dropAt(bars()[0].id, cMajorChords()[0], 0);

    fireEvent.click(screen.getByLabelText('Remove segment'));

    expect(segments()).toHaveLength(0);
    expect(barNotes(bars()[0], trackId())).toHaveLength(0);
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

  describe('velocity shading', () => {
    it('draws a block that has never been given one at full brightness', () => {
      // The guarantee that matters: every project written before velocity could
      // be edited looks exactly as it did.
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 0);

      expect(screen.getByTestId(`chord-block-${segments()[0].id}`)).toHaveStyle({
        filter: 'brightness(1)',
      });
    });

    it('dims a quiet block and lifts a loud one', () => {
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 0);
      dropAt(bars()[0].id, cMajorChords()[4], 1);
      const [quiet, loud] = segments();

      act(() => projectStore.getState().setSegmentVelocity(quiet.id, 20));
      act(() => projectStore.getState().setSegmentVelocity(loud.id, 127));

      const brightness = (id: string) =>
        Number(
          /brightness\(([\d.]+)\)/.exec(
            screen.getByTestId(`chord-block-${id}`).style.filter
          )![1]
        );
      expect(brightness(quiet.id)).toBeLessThan(1);
      expect(brightness(loud.id)).toBeGreaterThan(1);
    });

    it('states the velocity in the label, so it is not said by colour alone', () => {
      render(<ChordTimeline />);
      dropAt(bars()[0].id, cMajorChords()[0], 0);
      const id = segments()[0].id;

      act(() => projectStore.getState().setSegmentVelocity(id, 40));

      expect(screen.getByTestId(`chord-block-${id}`)).toHaveAccessibleName(/velocity 40$/);
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
    expect(barNotes(bars()[0], trackId())[0].duration).toBe(2);
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

  // A sub-lane is a row, and a row exists only so that two blocks can occupy the
  // same beats. Everything above this point works one lane deep, which is what
  // every project looks like until something has to sound at the same time as
  // something else.
  describe('sub-lanes', () => {
    /** Put a recorded note block on the timeline, as MIDI recording would. */
    function record(id: string, pitch: number, lane: number, startBeat = 0) {
      projectStore.getState().recordSegment(trackId(), startBeat, {
        id,
        kind: 'note',
        pitch,
        lane,
        startBeat,
        duration: 2,
      } satisfies ChordSegment);
    }

    it('shows one row until an instrument needs a second', () => {
      render(<ChordTimeline />);
      expect(laneEl(bars()[0].id)).toBeInTheDocument();
      expect(screen.queryByTestId(`timeline-lane-${bars()[0].id}-1`)).not.toBeInTheDocument();
    });

    it('grows a row when a block is recorded into a lane the track lacks', () => {
      record('lo', 60, 0);
      record('hi', 64, 1);
      render(<ChordTimeline />);

      expect(tracks()[0].laneCount).toBe(2);
      expect(screen.getByTestId(`timeline-lane-${bars()[0].id}-1`)).toBeInTheDocument();
    });

    it('keeps two blocks on the same beat instead of rippling them apart', () => {
      record('lo', 60, 0);
      record('hi', 64, 1);
      render(<ChordTimeline />);

      expect(segments().map(s => s.startBeat)).toEqual([0, 0]);
    });

    it('draws each block in its own row', () => {
      record('lo', 60, 0);
      record('hi', 64, 1);
      render(<ChordTimeline />);

      const barId = bars()[0].id;
      expect(within(laneEl(barId, 0)).getByTestId('chord-block-lo')).toBeInTheDocument();
      expect(within(laneEl(barId, 1)).getByTestId('chord-block-hi')).toBeInTheDocument();
    });

    it('drops a palette block into the row it was dropped on', () => {
      record('lo', 60, 0);
      render(<ChordTimeline />);

      fireEvent.click(screen.getByLabelText('Add lane'));
      dropAt(bars()[0].id, cMajorChords()[0], 0, 1);

      const dropped = segments().find(s => s.id !== 'lo')!;
      expect(dropped.lane).toBe(1);
      expect(dropped.startBeat).toBe(0);
    });

    it('drags a block from one row to another', () => {
      record('lo', 60, 0);
      render(<ChordTimeline />);

      fireEvent.click(screen.getByLabelText('Add lane'));
      dragBlock('lo', bars()[0].id, 0, 0, 1);

      expect(segments()[0].lane).toBe(1);
    });

    it('adds and removes a row from the gutter', () => {
      render(<ChordTimeline />);

      fireEvent.click(screen.getByLabelText('Add lane'));
      expect(tracks()[0].laneCount).toBe(2);

      fireEvent.click(screen.getByLabelText('Remove lane'));
      expect(tracks()[0].laneCount).toBe(1);
    });

    it('refuses to remove a row that still holds blocks', () => {
      record('lo', 60, 0);
      record('hi', 64, 1);
      render(<ChordTimeline />);

      expect(screen.getByLabelText('Remove lane')).toBeDisabled();
      expect(tracks()[0].laneCount).toBe(2);
    });

    it('generates the notes both rows sound', () => {
      record('lo', 60, 0);
      record('hi', 64, 1);
      render(<ChordTimeline />);

      expect(barNotes(bars()[0], trackId()).map(n => n.pitch).sort()).toEqual([60, 64]);
    });
  });

  it('offers no Add Chord, chord-symbol field or Auto-Fill control', () => {
    render(<ChordTimeline />);
    expect(screen.queryByText(/add chord/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/auto-fill/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  describe('volume automation lane', () => {
    it('shows the lane under the bars by default', () => {
      render(<ChordTimeline />);

      expect(screen.getByTestId('automation-lane')).toBeInTheDocument();
      // Labelled in the gutter, which is outside the scroll container so the label
      // stays put while the lane beside it scrolls.
      expect(within(screen.getByTestId('timeline-gutter')).getByText('Volume')).toBeInTheDocument();
    });

    it('hides the lane, and its gutter label, when toggled off', () => {
      render(<ChordTimeline />);

      fireEvent.click(screen.getByLabelText('Automation lanes'));

      expect(screen.queryByTestId('automation-lane')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('timeline-gutter')).queryByText('Volume')).toBeNull();
    });

    it('reports its state on the toggle, so it reads as pressed', () => {
      render(<ChordTimeline />);
      const toggle = screen.getByLabelText('Automation lanes');

      expect(toggle).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
    });

    it('spans the whole project, on the same axis as the ruler', () => {
      render(<ChordTimeline />);

      const width = `${8 * PIXELS_PER_BEAT}px`;
      expect(screen.getByTestId('timeline-ruler')).toHaveStyle({ width });
      expect(screen.getByTestId('automation-lane')).toHaveStyle({ width });
    });

    describe('clearing the curve', () => {
      const clearLabel = () => `Clear volume curve for ${tracks()[0].name}`;

      it('offers nothing to clear until there is a curve', () => {
        render(<ChordTimeline />);

        expect(screen.queryByLabelText(clearLabel())).not.toBeInTheDocument();
      });

      it('offers a Clear once a point exists', () => {
        projectStore.getState().addVolumePoint(trackId(), 2, 0.5);
        render(<ChordTimeline />);

        expect(screen.getByLabelText(clearLabel())).toBeInTheDocument();
      });

      it('removes every point, handing the instrument back to its fader', () => {
        projectStore.getState().addVolumePoint(trackId(), 2, 0.5);
        projectStore.getState().addVolumePoint(trackId(), 6, 0.2);
        render(<ChordTimeline />);

        fireEvent.click(screen.getByLabelText(clearLabel()));

        expect(tracks()[0].volumeAutomation).toBeUndefined();
        expect(screen.getByTestId('automation-flat-line')).toBeInTheDocument();
        expect(screen.queryByTestId('automation-curve')).not.toBeInTheDocument();
      });

      it('takes itself away once there is nothing left to clear', () => {
        projectStore.getState().addVolumePoint(trackId(), 2, 0.5);
        render(<ChordTimeline />);

        fireEvent.click(screen.getByLabelText(clearLabel()));

        expect(screen.queryByLabelText(clearLabel())).not.toBeInTheDocument();
      });

      it('clears only the selected instrument', () => {
        const other = projectStore.getState().addTrack('Strings')!;
        projectStore.getState().addVolumePoint(other, 2, 0.5);
        projectStore.getState().addVolumePoint(trackId(), 4, 0.25);
        render(<ChordTimeline />);

        fireEvent.click(screen.getByLabelText(clearLabel()));

        expect(tracks()[0].volumeAutomation).toBeUndefined();
        expect(tracks().find(t => t.id === other)!.volumeAutomation).toEqual([
          { beat: 2, value: 0.5 },
        ]);
      });

    });

    // The timeline edits one instrument at a time, and the curve belongs to that one.
    it('follows the selected instrument', () => {
      const first = trackId();
      projectStore.getState().addVolumePoint(first, 2, 0.5);
      const second = projectStore.getState().addTrack('Strings')!;

      render(<ChordTimeline />);
      expect(screen.getByTestId('automation-point-0')).toBeInTheDocument();

      act(() => selectionStore.getState().selectTrack(second));
      expect(screen.queryByTestId('automation-point-0')).not.toBeInTheDocument();
      expect(screen.getByTestId('automation-flat-line')).toBeInTheDocument();
    });
  });
});
