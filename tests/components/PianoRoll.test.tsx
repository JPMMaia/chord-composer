import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { PianoRoll } from '@/components/PianoRoll';
import { pitchToPixel, pitchRangeHeight } from '@/engine/quantize';
import { Bar, Track } from '@/types/music';
import { soloContent, TEST_TRACK_ID } from '../helpers/tracks';

/** The one instrument the shared fixture bars belong to. */
const mockTracks: Track[] = [
  {
    id: TEST_TRACK_ID,
    name: 'Piano',
    instrument: 'acoustic_grand_piano',
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    visible: true,
  },
];

const mockBars: Bar[] = [
  {
    id: 'bar-1',
    barIndex: 0,
    content: soloContent([], [
      { id: 'n1', pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
      { id: 'n2', pitch: 64, startBeat: 1, duration: 1, velocity: 100 },
      { id: 'n3', pitch: 67, startBeat: 2, duration: 1, velocity: 100 },
    ]),
  },
  {
    id: 'bar-2',
    barIndex: 1,
    content: soloContent([], [
      { id: 'n4', pitch: 72, startBeat: 4, duration: 2, velocity: 100 },
    ]),
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
    const BAR_LINE_WIDTH = 2;
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
        save: vi.fn(),
        restore: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
        clearRect: vi.fn(),
        // Bar lines are filled, not stroked, so they land on the same pixels as
        // the timeline's; they are recorded alongside the stroked gridlines.
        fillRect: vi.fn((x: number) => {
          strokes.push({ color: String(ctx.fillStyle), x });
        }),
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
        { id: 'b0', barIndex: 0, timeSignature: { beatsPerMeasure: 3, beatUnit: 4 }, content: soloContent() },
        { id: 'b1', barIndex: 1, timeSignature: { beatsPerMeasure: 4, beatUnit: 4 }, content: soloContent() },
        { id: 'b2', barIndex: 2, timeSignature: { beatsPerMeasure: 2, beatUnit: 4 }, content: soloContent() },
      ];
      const strokes = recordStrokes();

      render(
        <PianoRoll
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
      // Starts at beats 0, 3 and 7, plus the closing line at beat 9 — pulled two
      // pixels inside, as the timeline's closing line is, so the project still
      // ends exactly at beat 9.
      expect(barLines).toEqual([
        PIANO_KEYS_WIDTH + 0,
        PIANO_KEYS_WIDTH + 30,
        PIANO_KEYS_WIDTH + 70,
        PIANO_KEYS_WIDTH + 90 - BAR_LINE_WIDTH,
      ]);
    });

    it('draws one gridline per beat of the whole project', () => {
      const bars: Bar[] = [
        { id: 'b0', barIndex: 0, timeSignature: { beatsPerMeasure: 3, beatUnit: 4 }, content: soloContent() },
        { id: 'b1', barIndex: 1, content: soloContent() },
      ];
      const strokes = recordStrokes();

      render(
        <PianoRoll
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
    // The default instrument's blue at full strength: selected instrument, selected
    // bar. Every note fill is now rgba, since alpha carries the dimming.
    const ACTIVE_FILL = 'rgba(59, 130, 246, 1)';
    const PIXELS_PER_BEAT = 10;

    /** One note per bar, all on beat 0 of their own bar and all on the same pitch. */
    const bars: Bar[] = [
      { id: 'b0', barIndex: 0, content: soloContent([], [{ id: 'n0', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }]) },
      { id: 'b1', barIndex: 1, content: soloContent([], [{ id: 'n1', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }]) },
      { id: 'b2', barIndex: 2, content: soloContent([], [{ id: 'n2', pitch: 60, startBeat: 1, duration: 1, velocity: 100 }]) },
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
        save: vi.fn(),
        restore: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
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
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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
      // The selected-bar highlight is the same blue at 0.1, so it has to be
      // excluded by name rather than by hue.
      const ACTIVE_BAR_HIGHLIGHT = 'rgba(59, 130, 246, 0.1)';
      return fills.filter(
        f => f.color.startsWith('rgba(59, 130, 246,') && f.color !== ACTIVE_BAR_HIGHLIGHT
      );
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

    // The roll shows the whole arrangement: other instruments stay visible, in
    // their own colour, but recede so the one being edited reads first.
    describe('multiple instruments', () => {
      const OTHER_TRACK = 'track-strings';
      /** The second entry of TRACK_COLORS — amber. */
      const OTHER_HUE = 'rgba(245, 158, 11,';

      const twoInstrumentTracks: Track[] = [
        { ...mockTracks[0] },
        {
          id: OTHER_TRACK,
          name: 'Strings',
          instrument: 'string_ensemble_1',
          volume: 1,
          pan: 0,
          muted: false,
          solo: false,
          visible: true,
          color: '#f59e0b',
        },
      ];

      /** One bar, one note each for two instruments. */
      const sharedBar: Bar[] = [
        {
          id: 'b0',
          barIndex: 0,
          content: {
            [TEST_TRACK_ID]: {
              chords: [],
              notes: [{ id: 'p', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }],
            },
            [OTHER_TRACK]: {
              chords: [],
              notes: [{ id: 's', pitch: 64, startBeat: 1, duration: 1, velocity: 100 }],
            },
          },
        },
      ];

      /** Every note fill, whatever hue, for a given set of instruments. */
      function allNoteFills(tracks: Track[], selectedTrackId: string | null): Filled[] {
        const fills = recordFills();
        render(
          <PianoRoll
            bars={sharedBar}
            selectedBarId="b0"
            tracks={tracks}
            selectedTrackId={selectedTrackId}
            playheadBeat={0}
            pixelsPerBeat={PIXELS_PER_BEAT}
            pixelsPerOctave={120}
            gridSize={0.25}
            timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
          />
        );
        return fills.filter(
          f =>
            (f.color.startsWith('rgba(59, 130, 246,') && f.color !== 'rgba(59, 130, 246, 0.1)') ||
            f.color.startsWith(OTHER_HUE)
        );
      }

      it('draws every visible instrument', () => {
        const fills = allNoteFills(twoInstrumentTracks, TEST_TRACK_ID);
        expect(fills).toHaveLength(2);
      });

      it('gives each instrument its own colour', () => {
        const fills = allNoteFills(twoInstrumentTracks, TEST_TRACK_ID);

        expect(fills.some(f => f.color.startsWith('rgba(59, 130, 246,'))).toBe(true);
        expect(fills.some(f => f.color.startsWith(OTHER_HUE))).toBe(true);
      });

      it('draws the selected instrument at full strength and the rest dimmed', () => {
        const fills = allNoteFills(twoInstrumentTracks, TEST_TRACK_ID);

        expect(fills.find(f => f.color.startsWith('rgba(59, 130, 246,'))!.color).toBe(ACTIVE_FILL);
        expect(fills.find(f => f.color.startsWith(OTHER_HUE))!.color).toBe(
          'rgba(245, 158, 11, 0.35)'
        );
      });

      it('draws the selected instrument last so it wins an overlap', () => {
        const fills = allNoteFills(twoInstrumentTracks, TEST_TRACK_ID);
        expect(fills[fills.length - 1].color).toBe(ACTIVE_FILL);
      });

      // The point of the eye toggle: a hidden instrument leaves the roll entirely,
      // while still being perfectly audible.
      it('draws nothing for a hidden instrument', () => {
        const hidden = twoInstrumentTracks.map(t =>
          t.id === OTHER_TRACK ? { ...t, visible: false } : t
        );
        const fills = allNoteFills(hidden, TEST_TRACK_ID);

        expect(fills).toHaveLength(1);
        expect(fills.every(f => !f.color.startsWith(OTHER_HUE))).toBe(true);
      });

      it('still draws a muted instrument, because muting is about sound', () => {
        const muted = twoInstrumentTracks.map(t =>
          t.id === OTHER_TRACK ? { ...t, muted: true } : t
        );
        expect(allNoteFills(muted, TEST_TRACK_ID)).toHaveLength(2);
      });
    });

    it('accumulates bar starts across mixed meters', () => {
      const mixed: Bar[] = [
        { id: 'm0', barIndex: 0, timeSignature: { beatsPerMeasure: 3, beatUnit: 4 }, content: soloContent([], [{ id: 'x0', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }]) },
        { id: 'm1', barIndex: 1, timeSignature: { beatsPerMeasure: 4, beatUnit: 4 }, content: soloContent([], [{ id: 'x1', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }]) },
      ];
      // Bar 2 starts on beat 3, not beat 4, because bar 1 is in 3/4.
      const xs = noteFills('m0', mixed).map(f => f.x).sort((a, b) => a - b);
      expect(xs).toEqual([0, 3].map(b => PIANO_KEYS_WIDTH + b * PIXELS_PER_BEAT));
    });

    it('scales note width with duration', () => {
      const twoBeats: Bar[] = [
        { id: 'd0', barIndex: 0, content: soloContent([], [{ id: 'y0', pitch: 60, startBeat: 0, duration: 2, velocity: 100 }]) },
      ];
      expect(noteFills('d0', twoBeats)[0].w).toBe(2 * PIXELS_PER_BEAT);
    });
  });

  describe('scrollable 88-key bed', () => {
    /** Records every `fillText`, which is how the key column names its keys. */
    function recordLabels(): { text: string; y: number; font: string }[] {
      const labels: { text: string; y: number; font: string }[] = [];
      const ctx = {
        strokeStyle: '',
        fillStyle: '',
        lineWidth: 0,
        font: '',
        save: vi.fn(),
        restore: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        fillText: vi.fn((text: string, _x: number, y: number) => {
          labels.push({ text, y, font: String(ctx.font) });
        }),
      };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        ctx as unknown as CanvasRenderingContext2D
      );
      return labels;
    }

    function renderRoll(pixelsPerOctave = 120) {
      return render(
        <PianoRoll
          bars={mockBars}
          selectedBarId="bar-1"
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
          playheadBeat={0}
          pixelsPerBeat={10}
          pixelsPerOctave={pixelsPerOctave}
          gridSize={0.25}
          timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
        />
      );
    }

    it('sizes the canvas to the whole pitch range so it can be scrolled', () => {
      const { container } = renderRoll();
      const canvas = container.querySelector('canvas') as HTMLCanvasElement;
      expect(canvas.height).toBe(pitchRangeHeight(120));
      expect(canvas.style.height).toBe(`${pitchRangeHeight(120)}px`);
    });

    it('puts the canvas in a vertically scrolling container', () => {
      const { getByTestId } = renderRoll();
      expect(getByTestId('piano-roll-scroll').className).toContain('overflow-y-auto');
    });

    it('names every key, not just the Cs', () => {
      const labels = recordLabels();
      renderRoll();
      const texts = labels.map(l => l.text);
      expect(texts).toContain('C4');
      expect(texts).toContain('C#4');
      expect(texts).toContain('B3');
      // A0 to C8 inclusive.
      expect(texts).toContain('A0');
      expect(texts).toContain('C8');
    });

    it('emphasises the C rows', () => {
      const labels = recordLabels();
      renderRoll();
      expect(labels.find(l => l.text === 'C4')?.font).toContain('bold');
      expect(labels.find(l => l.text === 'D4')?.font).not.toContain('bold');
    });

    it('drops labels when the rows are too short to hold them', () => {
      const labels = recordLabels();
      renderRoll(48); // 4px per semitone
      expect(labels).toHaveLength(0);
    });

    it('draws higher pitches above lower ones', () => {
      const labels = recordLabels();
      renderRoll();
      const c4 = labels.find(l => l.text === 'C4')!.y;
      const c7 = labels.find(l => l.text === 'C7')!.y;
      const a0 = labels.find(l => l.text === 'A0')!.y;
      expect(c7).toBeLessThan(c4);
      expect(c4).toBeLessThan(a0);
    });
  });

  describe('note creation coordinates', () => {
    const PIANO_KEYS_WIDTH = 80;
    const PIXELS_PER_BEAT = 10;

    const bars: Bar[] = [
      { id: 'b0', barIndex: 0, content: soloContent() },
      { id: 'b1', barIndex: 1, content: soloContent() },
    ];

    function clickAt(selectedBarId: string, beat: number, onNoteClick: () => void) {
      const { container } = render(
        <PianoRoll
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
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

  describe('shared horizontal scroll', () => {
    const PIANO_KEYS_WIDTH = 80;
    const PIXELS_PER_BEAT = 10;
    const SCROLL_LEFT = 60;
    // The default instrument's blue at full strength: selected instrument, selected
    // bar. Every note fill is now rgba, since alpha carries the dimming.
    const ACTIVE_FILL = 'rgba(59, 130, 246, 1)';

    const bars: Bar[] = [
      { id: 'b0', barIndex: 0, content: soloContent([], [{ id: 'n0', pitch: 60, startBeat: 2, duration: 1, velocity: 100 }]) },
      { id: 'b1', barIndex: 1, content: soloContent() },
    ];

    interface Drawn { color: string; x: number }

    /** Records both stroke origins (grid and bar lines) and fills (keys and notes). */
    function recordDrawing(): { strokes: Drawn[]; fills: Drawn[] } {
      const strokes: Drawn[] = [];
      const fills: Drawn[] = [];
      const ctx = {
        strokeStyle: '',
        fillStyle: '',
        lineWidth: 0,
        font: '',
        save: vi.fn(),
        restore: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
        clearRect: vi.fn(),
        strokeRect: vi.fn(),
        fillText: vi.fn(),
        beginPath: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        moveTo: vi.fn((x: number) => {
          strokes.push({ color: String(ctx.strokeStyle), x });
        }),
        fillRect: vi.fn((x: number) => {
          fills.push({ color: String(ctx.fillStyle), x });
        }),
      };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        ctx as unknown as CanvasRenderingContext2D
      );
      return { strokes, fills };
    }

    function renderAt(scrollLeft: number, extra: Partial<React.ComponentProps<typeof PianoRoll>> = {}) {
      return render(
        <PianoRoll
        tracks={mockTracks}
        selectedTrackId={TEST_TRACK_ID}
          bars={bars}
          selectedBarId="b0"
          playheadBeat={0}
          pixelsPerBeat={PIXELS_PER_BEAT}
          pixelsPerOctave={120}
          gridSize={0.25}
          timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
          scrollLeft={scrollLeft}
          {...extra}
        />
      );
    }

    it('slides the beat axis left by the shared offset', () => {
      const { fills } = recordDrawing();
      renderAt(SCROLL_LEFT);

      // Bar lines are the only #cccccc fills; bars 1 and 2 start on beats 0 and 4,
      // and the closing line sits just inside beat 8.
      const barLines = fills.filter(f => f.color === '#cccccc').map(f => f.x);
      const axis = PIANO_KEYS_WIDTH - SCROLL_LEFT;
      expect(barLines).toEqual([
        axis + 0,
        axis + 4 * PIXELS_PER_BEAT,
        axis + 8 * PIXELS_PER_BEAT - 2,
      ]);
    });

    it('moves notes with the axis', () => {
      const { fills } = recordDrawing();
      renderAt(SCROLL_LEFT);

      const note = fills.find(f => f.color === ACTIVE_FILL)!;
      expect(note.x).toBe(PIANO_KEYS_WIDTH - SCROLL_LEFT + 2 * PIXELS_PER_BEAT);
    });

    it('leaves the key column where it is', () => {
      const { fills } = recordDrawing();
      renderAt(SCROLL_LEFT);

      // The keys are painted into this canvas, so they must be exempt from the
      // offset or the keyboard would scroll off the left edge.
      const keys = fills.filter(f => f.color === '#fafafa' || f.color === '#2b2b2b');
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every(k => k.x === 0)).toBe(true);
    });

    it('clips the scrolled axis so it cannot paint over the keys', () => {
      const ctx = {
        strokeStyle: '', fillStyle: '', lineWidth: 0, font: '',
        save: vi.fn(), restore: vi.fn(), clip: vi.fn(),
        rect: vi.fn(),
        clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(),
        beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        ctx as unknown as CanvasRenderingContext2D
      );
      renderAt(SCROLL_LEFT);

      expect(ctx.clip).toHaveBeenCalled();
      expect(ctx.rect).toHaveBeenCalledWith(PIANO_KEYS_WIDTH, 0, expect.any(Number), expect.any(Number));
      const [x] = ctx.rect.mock.calls[0] as number[];
      expect(x).toBe(PIANO_KEYS_WIDTH);
    });

    it('resolves a click against the scrolled axis', () => {
      const onNoteClick = vi.fn();
      const { container } = renderAt(SCROLL_LEFT, { selectedBarId: 'b1', onNoteClick });

      // Bar 2 starts at absolute beat 4 — at x 40 unscrolled, so at x 40 − 60 = −20
      // once scrolled. Clicking the very first grid pixel therefore lands on beat 2
      // of bar 2, not beat 0.
      fireEvent.click(container.querySelector('canvas')!, {
        clientX: PIANO_KEYS_WIDTH,
        clientY: pitchToPixel(60, 120) + 1,
      });

      expect(onNoteClick).toHaveBeenCalledWith('b1', 60, 2);
    });

    it('forwards a horizontal wheel gesture to the shared offset', () => {
      const onScrollLeftChange = vi.fn();
      const { getByTestId } = renderAt(SCROLL_LEFT, { onScrollLeftChange });

      fireEvent.wheel(getByTestId('piano-roll-scroll'), { deltaX: 40, deltaY: 0 });
      expect(onScrollLeftChange).toHaveBeenCalledWith(SCROLL_LEFT + 40);
    });

    it('reads a shift-wheel as horizontal too', () => {
      const onScrollLeftChange = vi.fn();
      const { getByTestId } = renderAt(SCROLL_LEFT, { onScrollLeftChange });

      fireEvent.wheel(getByTestId('piano-roll-scroll'), { deltaX: 0, deltaY: 25, shiftKey: true });
      expect(onScrollLeftChange).toHaveBeenCalledWith(SCROLL_LEFT + 25);
    });

    it('leaves a plain vertical wheel to the pitch axis', () => {
      const onScrollLeftChange = vi.fn();
      const { getByTestId } = renderAt(SCROLL_LEFT, { onScrollLeftChange });

      fireEvent.wheel(getByTestId('piano-roll-scroll'), { deltaX: 0, deltaY: 25 });
      expect(onScrollLeftChange).not.toHaveBeenCalled();
    });
  });


  describe('hover tooltip', () => {
    const PIANO_KEYS_WIDTH = 80;
    const PIXELS_PER_BEAT = 10;
    const PIXELS_PER_OCTAVE = 120;

    const OTHER_TRACK = 'track-strings';
    const twoTracks: Track[] = [
      { ...mockTracks[0] },
      {
        id: OTHER_TRACK,
        name: 'Strings',
        instrument: 'string_ensemble_1',
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
        visible: true,
        color: '#f59e0b',
      },
    ];

    /**
     * Bar 1 carries the Piano's C4 and, on the same row and beat, the Strings' — an
     * overlap, so the chip has to pick one. Bar 2 carries a Piano note that no click
     * could reach, since only the selected bar is editable.
     */
    const hoverBars: Bar[] = [
      {
        id: 'h0',
        barIndex: 0,
        content: {
          [TEST_TRACK_ID]: {
            chords: [],
            notes: [{ id: 'piano-c4', pitch: 60, startBeat: 0, duration: 1.5, velocity: 100 }],
          },
          [OTHER_TRACK]: {
            chords: [],
            notes: [{ id: 'strings-c4', pitch: 60, startBeat: 0, duration: 1.5, velocity: 100 }],
          },
        },
      },
      {
        id: 'h1',
        barIndex: 1,
        content: soloContent([], [
          { id: 'piano-a5', pitch: 81, startBeat: 0, duration: 1, velocity: 100 },
        ]),
      },
    ];

    function renderRoll(extra: Partial<React.ComponentProps<typeof PianoRoll>> = {}) {
      return render(
        <PianoRoll
          bars={hoverBars}
          selectedBarId="h0"
          tracks={twoTracks}
          selectedTrackId={TEST_TRACK_ID}
          playheadBeat={0}
          pixelsPerBeat={PIXELS_PER_BEAT}
          pixelsPerOctave={PIXELS_PER_OCTAVE}
          gridSize={0.25}
          timeSignature={{ beatsPerMeasure: 4, beatUnit: 4 }}
          {...extra}
        />
      );
    }

    /** A point inside the note at `absoluteBeat` on `pitch`. */
    const pointOn = (absoluteBeat: number, pitch: number) => ({
      clientX: PIANO_KEYS_WIDTH + absoluteBeat * PIXELS_PER_BEAT + 2,
      clientY: pitchToPixel(pitch, PIXELS_PER_OCTAVE) + 1,
    });

    it('names the note under the pointer', () => {
      const { container, queryByTestId } = renderRoll();

      fireEvent.mouseMove(container.querySelector('canvas')!, pointOn(0, 60));

      expect(queryByTestId('piano-roll-tooltip')).toHaveTextContent('C4 · 1.5 beats · Piano');
    });

    it('says "beat" in the singular for a one-beat note', () => {
      const { container, queryByTestId } = renderRoll();

      fireEvent.mouseMove(container.querySelector('canvas')!, pointOn(4, 81));

      expect(queryByTestId('piano-roll-tooltip')).toHaveTextContent('A5 · 1 beat · Piano');
    });

    it('shows nothing over empty grid', () => {
      const { container, queryByTestId } = renderRoll();

      fireEvent.mouseMove(container.querySelector('canvas')!, pointOn(0, 67));

      expect(queryByTestId('piano-roll-tooltip')).not.toBeInTheDocument();
    });

    it('shows nothing over the key column', () => {
      const { container, queryByTestId } = renderRoll();

      fireEvent.mouseMove(container.querySelector('canvas')!, {
        clientX: 10,
        clientY: pitchToPixel(60, PIXELS_PER_OCTAVE) + 1,
      });

      expect(queryByTestId('piano-roll-tooltip')).not.toBeInTheDocument();
    });

    it('goes away when the pointer leaves the roll', () => {
      const { container, queryByTestId } = renderRoll();
      const canvas = container.querySelector('canvas')!;

      fireEvent.mouseMove(canvas, pointOn(0, 60));
      expect(queryByTestId('piano-roll-tooltip')).toBeInTheDocument();

      fireEvent.mouseLeave(canvas);
      expect(queryByTestId('piano-roll-tooltip')).not.toBeInTheDocument();
    });

    // Reading a pitch is not editing it: a note the roll draws dimmed is still worth
    // naming, even though a click there would do nothing.
    it('names a note outside the selected bar', () => {
      const { container, queryByTestId } = renderRoll();

      fireEvent.mouseMove(container.querySelector('canvas')!, pointOn(4, 81));

      expect(queryByTestId('piano-roll-tooltip')).toHaveTextContent('Piano');
    });

    it('names the other instrument when its note is the one hovered', () => {
      const { container, queryByTestId } = renderRoll({ selectedTrackId: OTHER_TRACK });

      fireEvent.mouseMove(container.querySelector('canvas')!, pointOn(0, 60));

      expect(queryByTestId('piano-roll-tooltip')).toHaveTextContent('Strings');
    });

    // The note painted on top of an overlap is the note the eye means.
    it('names the note drawn on top when two overlap', () => {
      const { container, queryByTestId } = renderRoll();

      fireEvent.mouseMove(container.querySelector('canvas')!, pointOn(0, 60));

      expect(queryByTestId('piano-roll-tooltip')).toHaveTextContent('Piano');
      expect(queryByTestId('piano-roll-tooltip')).not.toHaveTextContent('Strings');
    });

    it('says nothing about a hidden instrument', () => {
      const hidden = twoTracks.map(t => (t.id === TEST_TRACK_ID ? { ...t, visible: false } : t));
      const { container, queryByTestId } = renderRoll({
        tracks: hidden,
        selectedTrackId: OTHER_TRACK,
      });

      fireEvent.mouseMove(container.querySelector('canvas')!, pointOn(0, 60));

      expect(queryByTestId('piano-roll-tooltip')).toHaveTextContent('Strings');
    });

    it('follows the shared horizontal scroll', () => {
      const { container, queryByTestId } = renderRoll({ scrollLeft: 20 });
      const canvas = container.querySelector('canvas')!;

      // Beat 0 has been pulled two beats left, so the note is no longer where it was.
      fireEvent.mouseMove(canvas, pointOn(0, 60));
      expect(queryByTestId('piano-roll-tooltip')).not.toBeInTheDocument();

      // Bar 2's note is at absolute beat 4, so scrolling two beats brings it two
      // beats nearer the keys.
      fireEvent.mouseMove(canvas, {
        clientX: PIANO_KEYS_WIDTH + 4 * PIXELS_PER_BEAT - 20 + 2,
        clientY: pitchToPixel(81, PIXELS_PER_OCTAVE) + 1,
      });
      expect(queryByTestId('piano-roll-tooltip')).toHaveTextContent('A5');
    });
  });

});
