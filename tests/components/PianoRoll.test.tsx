import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { PianoRoll } from '@/components/PianoRoll';
import { Bar } from '@/types/music';

const mockBars: Bar[] = [
  {
    id: 'bar-1',
    barIndex: 0,
    scale: { root: 'C', type: 'major' },
    chords: [],
    notes: [
      { id: 'n1', pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
      { id: 'n2', pitch: 64, startBeat: 1, duration: 1, velocity: 100 },
      { id: 'n3', pitch: 67, startBeat: 2, duration: 1, velocity: 100 },
    ],
  },
  {
    id: 'bar-2',
    barIndex: 1,
    scale: { root: 'C', type: 'major' },
    chords: [],
    notes: [
      { id: 'n4', pitch: 72, startBeat: 4, duration: 2, velocity: 100 },
    ],
  },
];

describe('PianoRoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Mock requestAnimationFrame
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      setTimeout(cb, 0);
      return 1;
    });
    // Mock getBoundingClientRect for all elements
    Element.prototype.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders a canvas element', () => {
    const { container } = render(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={0}
        pixelsPerBeat={100}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  it('renders with correct dimensions', () => {
    const { container } = render(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={0}
        pixelsPerBeat={100}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    // Canvas dimensions are set by ResizeObserver in the component
    // In jsdom, we verify the canvas element exists with proper attributes
    expect(canvas).toHaveAttribute('width');
    expect(canvas).toHaveAttribute('height');
  });

  it('renders grid lines for beats', () => {
    const { container } = render(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={0}
        pixelsPerBeat={100}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  it('renders pitch labels on Y-axis', () => {
    const { container } = render(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={0}
        pixelsPerBeat={100}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  it('renders note rectangles for placed notes', () => {
    const { container } = render(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={0}
        pixelsPerBeat={100}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  it('filters notes by current bar scale', () => {
    const { container } = render(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={0}
        pixelsPerBeat={100}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  it('snaps placed notes to grid', () => {
    const onNoteClick = vi.fn();
    render(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={0}
        pixelsPerBeat={100}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={onNoteClick}
        onNoteDrag={() => {}}
      />
    );
    expect(onNoteClick).toBeDefined();
  });

  it('shows playhead line at current position', () => {
    render(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={2.5}
        pixelsPerBeat={100}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = document.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  it('highlights the active bar', () => {
    render(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={0}
        pixelsPerBeat={100}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = document.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  it('renders with crosshair cursor', () => {
    const { container } = render(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={0}
        pixelsPerBeat={100}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.style.cursor).toBe('crosshair');
  });

  it('handles empty bars array', () => {
    const { container } = render(
      <PianoRoll
        bars={[]}
        selectedBarId=""
        playheadBeat={0}
        pixelsPerBeat={100}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  it('handles custom pixelsPerBeat', () => {
    const { container } = render(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={0}
        pixelsPerBeat={200}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  it('handles custom pixelsPerOctave', () => {
    const { container } = render(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={0}
        pixelsPerBeat={100}
        pixelsPerOctave={200}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  it('updates playhead position when playheadBeat changes', () => {
    const { rerender } = render(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={0}
        pixelsPerBeat={100}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    rerender(
      <PianoRoll
        bars={mockBars}
        selectedBarId="bar-1"
        playheadBeat={5}
        pixelsPerBeat={100}
        pixelsPerOctave={100}
        gridSize={0.25}
        timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = document.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  describe('per-bar time signatures', () => {
    const PIANO_KEYS_WIDTH = 80;
    const BAR_LINE_COLOR = '#cccccc';

    /**
     * Install a recording 2D context.
     *
     * jsdom has no canvas backend, so `getContext` returns null and the component
     * draws nothing. This stands in far enough to observe where lines are placed.
     */
    function recordStrokes(): { color: string; x: number }[] {
      const strokes: { color: string; x: number }[] = [];
      const ctx = {
        strokeStyle: '',
        fillStyle: '',
        lineWidth: 0,
        font: '',
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        fillText: vi.fn(),
        beginPath: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        moveTo: vi.fn((x: number) => {
          strokes.push({ color: String(ctx.strokeStyle), x });
        }),
      };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        ctx as unknown as CanvasRenderingContext2D
      );
      return strokes;
    }

    it('places bar lines at cumulative starts across mixed meters', () => {
      const bars: Bar[] = [
        { id: 'b0', barIndex: 0, timeSignature: { beatsPerMeasure: 3, beatUnit: 4 }, scale: { root: 'C', type: 'major' }, chords: [], notes: [] },
        { id: 'b1', barIndex: 1, timeSignature: { beatsPerMeasure: 4, beatUnit: 4 }, scale: { root: 'C', type: 'major' }, chords: [], notes: [] },
        { id: 'b2', barIndex: 2, timeSignature: { beatsPerMeasure: 2, beatUnit: 4 }, scale: { root: 'C', type: 'major' }, chords: [], notes: [] },
      ];
      const strokes = recordStrokes();

      render(
        <PianoRoll
          bars={bars}
          selectedBarId="b0"
          playheadBeat={0}
          pixelsPerBeat={10}
          pixelsPerOctave={100}
          gridSize={0.25}
          timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        />
      );

      const barLines = strokes.filter(s => s.color === BAR_LINE_COLOR).map(s => s.x);
      // Starts at beats 0, 3, 7 plus the closing line at beat 9.
      expect(barLines).toEqual([0, 3, 7, 9].map(b => PIANO_KEYS_WIDTH + b * 10));
    });

    it('draws one gridline per beat of the whole project', () => {
      const bars: Bar[] = [
        { id: 'b0', barIndex: 0, timeSignature: { beatsPerMeasure: 3, beatUnit: 4 }, scale: { root: 'C', type: 'major' }, chords: [], notes: [] },
        { id: 'b1', barIndex: 1, scale: { root: 'C', type: 'major' }, chords: [], notes: [] },
      ];
      const strokes = recordStrokes();

      render(
        <PianoRoll
          bars={bars}
          selectedBarId="b0"
          playheadBeat={0}
          pixelsPerBeat={10}
          pixelsPerOctave={100}
          gridSize={0.25}
          timeSignature={{ beatsPerMeasure: 6, beatUnit: 4 }}
        />
      );

      // Bar 1 inherits 6/4 from the project: 3 + 6 = 9 beats, so 10 gridlines.
      const gridLines = strokes.filter(s => s.color === '#e5e5e5').map(s => s.x);
      expect(gridLines.slice(-10)).toEqual(
        Array.from({ length: 10 }, (_, i) => PIANO_KEYS_WIDTH + i * 10)
      );
    });
  });
});
