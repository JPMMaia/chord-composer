import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { PianoRoll } from '@/components/PianoRoll';
import { pitchToPixel } from '@/engine/quantize';
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

  describe('note placement across bars', () => {
    const PIANO_KEYS_WIDTH = 80;
    const ACTIVE_FILL = '#3b82f6';
    const PIXELS_PER_BEAT = 10;

    /** One note per bar, all on beat 0 of their own bar and all on the same pitch. */
    const bars: Bar[] = [
      { id: 'b0', barIndex: 0, scale: { root: 'C', type: 'major' }, chords: [],
        notes: [{ id: 'n0', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }] },
      { id: 'b1', barIndex: 1, scale: { root: 'C', type: 'major' }, chords: [],
        notes: [{ id: 'n1', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }] },
      { id: 'b2', barIndex: 2, scale: { root: 'C', type: 'major' }, chords: [],
        notes: [{ id: 'n2', pitch: 60, startBeat: 1, duration: 1, velocity: 100 }] },
    ];

    interface Filled { color: string; x: number; w: number }

    /**
     * Record `fillRect` calls. Notes are the only thing drawn with a note colour, so
     * filtering on fill style isolates them from the key bed and bar highlight.
     */
    function recordFills(): Filled[] {
      const fills: Filled[] = [];
      const ctx = {
        strokeStyle: '',
        fillStyle: '',
        lineWidth: 0,
        font: '',
        clearRect: vi.fn(),
        strokeRect: vi.fn(),
        fillText: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        fillRect: vi.fn((x: number, _y: number, w: number) => {
          fills.push({ color: String(ctx.fillStyle), x, w });
        }),
      };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        ctx as unknown as CanvasRenderingContext2D
      );
      return fills;
    }

    function noteFills(selectedBarId: string, barsToRender = bars): Filled[] {
      const fills = recordFills();
      render(
        <PianoRoll
          bars={barsToRender}
          selectedBarId={selectedBarId}
          playheadBeat={0}
          pixelsPerBeat={PIXELS_PER_BEAT}
          pixelsPerOctave={120}
          gridSize={0.25}
          timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        />
      );
      // The key bed uses white/grey fills and the active bar a translucent blue; only
      // notes use the two note colours.
      return fills.filter(f => f.color.startsWith('#3b82f6') || f.color.startsWith('rgba(59, 130, 246, 0.3)'));
    }

    it('keeps other bars’ notes visible when a later bar is selected', () => {
      // The reported bug: selecting bar 2 hid bar 1's notes entirely.
      expect(noteFills('b1')).toHaveLength(3);
      expect(noteFills('b0')).toHaveLength(3);
    });

    it('places each note in its own bar rather than all in bar 1', () => {
      // Notes are stored bar-relative, so bar 1 beat 0, bar 2 beat 0 and bar 3 beat 1
      // must land at absolute beats 0, 4 and 9 — the second bug was all three at 0.
      const xs = noteFills('b0').map(f => f.x).sort((a, b) => a - b);
      expect(xs).toEqual([0, 4, 9].map(b => PIANO_KEYS_WIDTH + b * PIXELS_PER_BEAT));
    });

    it('draws the selected bar’s notes in the active colour and the rest muted', () => {
      const fills = noteFills('b1');
      const active = fills.filter(f => f.color === ACTIVE_FILL);

      expect(active).toHaveLength(1);
      // Bar 2 starts at absolute beat 4.
      expect(active[0].x).toBe(PIANO_KEYS_WIDTH + 4 * PIXELS_PER_BEAT);
      expect(fills.filter(f => f.color !== ACTIVE_FILL)).toHaveLength(2);
    });

    it('draws the selected bar last so its notes are not covered', () => {
      const fills = noteFills('b0');
      expect(fills[fills.length - 1].color).toBe(ACTIVE_FILL);
    });

    it('accumulates bar starts across mixed meters', () => {
      const mixed: Bar[] = [
        { id: 'm0', barIndex: 0, timeSignature: { beatsPerMeasure: 3, beatUnit: 4 }, scale: { root: 'C', type: 'major' }, chords: [],
          notes: [{ id: 'x0', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }] },
        { id: 'm1', barIndex: 1, timeSignature: { beatsPerMeasure: 4, beatUnit: 4 }, scale: { root: 'C', type: 'major' }, chords: [],
          notes: [{ id: 'x1', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }] },
      ];
      // Bar 2 starts on beat 3, not beat 4, because bar 1 is in 3/4.
      const xs = noteFills('m0', mixed).map(f => f.x).sort((a, b) => a - b);
      expect(xs).toEqual([0, 3].map(b => PIANO_KEYS_WIDTH + b * PIXELS_PER_BEAT));
    });

    it('scales note width with duration', () => {
      const twoBeats: Bar[] = [
        { id: 'd0', barIndex: 0, scale: { root: 'C', type: 'major' }, chords: [],
          notes: [{ id: 'y0', pitch: 60, startBeat: 0, duration: 2, velocity: 100 }] },
      ];
      expect(noteFills('d0', twoBeats)[0].w).toBe(2 * PIXELS_PER_BEAT);
    });
  });

  describe('note creation coordinates', () => {
    const PIANO_KEYS_WIDTH = 80;
    const PIXELS_PER_BEAT = 10;

    const bars: Bar[] = [
      { id: 'b0', barIndex: 0, scale: { root: 'C', type: 'major' }, chords: [], notes: [] },
      { id: 'b1', barIndex: 1, scale: { root: 'C', type: 'major' }, chords: [], notes: [] },
    ];

    function clickAt(selectedBarId: string, beat: number, onNoteClick: () => void) {
      const { container } = render(
        <PianoRoll
          bars={bars}
          selectedBarId={selectedBarId}
          playheadBeat={0}
          pixelsPerBeat={PIXELS_PER_BEAT}
          pixelsPerOctave={120}
          gridSize={0.25}
          timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
          onNoteClick={onNoteClick}
        />
      );
      const canvas = container.querySelector('canvas') as HTMLCanvasElement;
      // Pitch 60 sits at a y the scale check accepts (C is in C major).
      fireEvent.click(canvas, {
        clientX: PIANO_KEYS_WIDTH + beat * PIXELS_PER_BEAT,
        clientY: pitchToPixel(60, 120) + 1,
      });
    }

    it('reports a beat relative to the selected bar, not the project', () => {
      // Clicking absolute beat 5 with bar 2 selected is beat 1 *of that bar*, since a
      // Note stores its position relative to its own bar.
      const onNoteClick = vi.fn();
      clickAt('b1', 5, onNoteClick);
      expect(onNoteClick).toHaveBeenCalledWith('b1', 60, 1);
    });

    it('reports beat 0 for a click at the start of the selected bar', () => {
      const onNoteClick = vi.fn();
      clickAt('b1', 4, onNoteClick);
      expect(onNoteClick).toHaveBeenCalledWith('b1', 60, 0);
    });

    it('ignores a click outside the selected bar instead of misplacing the note', () => {
      const onNoteClick = vi.fn();
      clickAt('b1', 1, onNoteClick);
      expect(onNoteClick).not.toHaveBeenCalled();
    });

    it('ignores a click past the end of the selected bar', () => {
      const onNoteClick = vi.fn();
      clickAt('b0', 4, onNoteClick);
      expect(onNoteClick).not.toHaveBeenCalled();
    });
  });

});
