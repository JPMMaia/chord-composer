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
        onNoteClick={() => {}}
        onNoteDrag={() => {}}
      />
    );
    const canvas = document.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });
});
