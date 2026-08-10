import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Transport } from '@/components/Transport';

describe('Transport', () => {
  const mockOnPlay = vi.fn();
  const mockOnPause = vi.fn();
  const mockOnStop = vi.fn();
  const mockOnBpmChange = vi.fn();
  const mockOnMetronomeToggle = vi.fn();
  const mockOnLoopToggle = vi.fn();
  const mockOnRecordToggle = vi.fn();
  const mockOnQuantizeToggle = vi.fn();

  const defaultProps = {
    isPlaying: false,
    isPaused: false,
    bpm: 120,
    timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
    musicalKey: 'C',
    keyMode: 'major' as const,
    loopEnabled: false,
    loopRangeLabel: null,
    isRecordArmed: false,
    recordQuantize: true,
    getSongTime: () => 0,
    onRecordToggle: mockOnRecordToggle,
    onQuantizeToggle: mockOnQuantizeToggle,
    onPlay: mockOnPlay,
    onPause: mockOnPause,
    onStop: mockOnStop,
    onBpmChange: mockOnBpmChange,
    onMetronomeToggle: mockOnMetronomeToggle,
    onLoopToggle: mockOnLoopToggle,
  };

  it('renders play/pause/stop buttons', () => {
    render(<Transport {...defaultProps} />);
    expect(screen.getByRole('button', { name: /play/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pause/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('shows current BPM', () => {
    render(<Transport {...defaultProps} />);
    const bpmInput = screen.getByLabelText('BPM') as HTMLInputElement;
    expect(bpmInput.value).toBe('120');
  });

  it('shows the song timer', () => {
    render(<Transport {...defaultProps} />);
    expect(screen.getByTestId('song-timer')).toBeInTheDocument();
  });

  it('shows current time signature', () => {
    render(<Transport {...defaultProps} />);
    expect(document.body.textContent).toContain('4/4');
  });

  it('shows current key', () => {
    render(<Transport {...defaultProps} />);
    expect(document.body.textContent).toContain('Major');
  });

  it('toggles play on play button click', () => {
    render(<Transport {...defaultProps} />);
    const playButton = screen.getByRole('button', { name: /play/i });
    fireEvent.click(playButton);
    expect(mockOnPlay).toHaveBeenCalled();
  });

  it('toggles pause on pause button click', () => {
    render(<Transport {...defaultProps} />);
    const pauseButton = screen.getByRole('button', { name: /pause/i });
    fireEvent.click(pauseButton);
    expect(mockOnPause).toHaveBeenCalled();
  });

  it('resets position on stop button click', () => {
    render(<Transport {...defaultProps} />);
    const stopButton = screen.getByRole('button', { name: /stop/i });
    fireEvent.click(stopButton);
    expect(mockOnStop).toHaveBeenCalled();
  });

  // The repeat toggle is always available: hiding it while repeat is off would hide
  // the only control that can turn it back on.
  it('shows the repeat toggle even with repeat off and no range', () => {
    render(<Transport {...defaultProps} />);
    const loopToggle = screen.getByRole('button', { name: /loop/i });
    expect(loopToggle).toBeInTheDocument();
    expect(loopToggle).not.toHaveClass('bg-indigo-600');
  });

  it('marks the repeat toggle active when repeat is on', () => {
    render(<Transport {...defaultProps} loopEnabled />);
    const loopToggle = screen.getByRole('button', { name: /loop/i });
    expect(loopToggle).toHaveClass('bg-indigo-600');
    expect(loopToggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onLoopToggle when the repeat button is clicked', () => {
    render(<Transport {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /loop/i }));
    expect(mockOnLoopToggle).toHaveBeenCalled();
  });

  it('shows the play range, or a dash when there is none', () => {
    const { rerender } = render(<Transport {...defaultProps} />);
    expect(screen.getByTestId('loop-range-readout')).toHaveTextContent('Range —');

    rerender(<Transport {...defaultProps} loopRangeLabel="2–3" />);
    expect(screen.getByTestId('loop-range-readout')).toHaveTextContent('Range 2–3');
  });

  it('toggles metronome on click', () => {
    render(<Transport {...defaultProps} />);
    const metronomeButton = screen.getByRole('button', { name: /metronome/i });
    fireEvent.click(metronomeButton);
    expect(mockOnMetronomeToggle).toHaveBeenCalled();
  });

  it('highlights play button when playing', () => {
    render(<Transport {...defaultProps} isPlaying />);
    const playButton = screen.getByRole('button', { name: /play/i });
    expect(playButton).toHaveClass('bg-green-600');
  });

  it('highlights pause button when paused', () => {
    render(<Transport {...defaultProps} isPaused />);
    const pauseButton = screen.getByRole('button', { name: /pause/i });
    expect(pauseButton).toHaveClass('bg-yellow-600');
  });

  it('renders BPM input field', () => {
    render(<Transport {...defaultProps} />);
    const bpmInput = screen.getByLabelText('BPM');
    expect(bpmInput).toBeInTheDocument();
  });

  it('calls onBpmChange when BPM input changes', () => {
    render(<Transport {...defaultProps} />);
    const bpmInput = screen.getByLabelText('BPM');
    fireEvent.change(bpmInput, { target: { value: '140' } });
    expect(mockOnBpmChange).toHaveBeenCalledWith(140);
  });

  describe('recording', () => {
    const record = () => screen.getByRole('button', { name: /^record$/i });
    const quantize = () => screen.getByRole('button', { name: /quantize/i });

    it('reports whether recording is armed', () => {
      const { unmount } = render(<Transport {...defaultProps} />);
      expect(record()).toHaveAttribute('aria-pressed', 'false');
      unmount();

      render(<Transport {...defaultProps} isRecordArmed />);
      expect(record()).toHaveAttribute('aria-pressed', 'true');
      expect(record()).toHaveClass('bg-red-600');
    });

    it('pulses only once armed recording is actually running', () => {
      const { unmount } = render(<Transport {...defaultProps} isRecordArmed />);
      expect(record().className).not.toContain('animate-pulse');
      unmount();

      render(<Transport {...defaultProps} isRecordArmed isPlaying />);
      expect(record().className).toContain('animate-pulse');
    });

    it('toggles the arm on click', () => {
      render(<Transport {...defaultProps} />);
      fireEvent.click(record());
      expect(mockOnRecordToggle).toHaveBeenCalled();
    });

    it('reports and toggles quantize', () => {
      render(<Transport {...defaultProps} />);
      expect(quantize()).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(quantize());
      expect(mockOnQuantizeToggle).toHaveBeenCalled();
    });

    it('shows quantize as off when it is', () => {
      render(<Transport {...defaultProps} recordQuantize={false} />);
      expect(quantize()).toHaveAttribute('aria-pressed', 'false');
    });
  });

  describe('undo / redo buttons', () => {
    const mockUndo = vi.fn();
    const mockRedo = vi.fn();

    const renderWithUndoRedo = (overrides?: Partial<typeof defaultProps> & {
      onUndo?: () => void;
      onRedo?: () => void;
      canUndo?: boolean;
      canRedo?: boolean;
    }) =>
      render(
        <Transport
          {...defaultProps}
          {...overrides}
          onUndo={overrides?.onUndo ?? mockUndo}
          onRedo={overrides?.onRedo ?? mockRedo}
          canUndo={overrides?.canUndo ?? false}
          canRedo={overrides?.canRedo ?? false}
        />
      );

    it('renders undo button', () => {
      renderWithUndoRedo();
      expect(screen.getByLabelText('Undo')).toBeInTheDocument();
    });

    it('renders redo button', () => {
      renderWithUndoRedo();
      expect(screen.getByLabelText('Redo')).toBeInTheDocument();
    });

    it('calls undo when undo button is clicked', () => {
      renderWithUndoRedo({ canUndo: true });
      fireEvent.click(screen.getByLabelText('Undo'));
      expect(mockUndo).toHaveBeenCalled();
    });

    it('calls redo when redo button is clicked', () => {
      renderWithUndoRedo({ canRedo: true });
      fireEvent.click(screen.getByLabelText('Redo'));
      expect(mockRedo).toHaveBeenCalled();
    });

    it('dims the undo button when canUndo is false', () => {
      renderWithUndoRedo({ canUndo: false });
      const undoBtn = screen.getByLabelText('Undo');
      expect(undoBtn).toHaveClass('opacity-40', 'cursor-not-allowed');
    });

    it('dims the redo button when canRedo is false', () => {
      renderWithUndoRedo({ canRedo: false });
      const redoBtn = screen.getByLabelText('Redo');
      expect(redoBtn).toHaveClass('opacity-40', 'cursor-not-allowed');
    });

    it('shows tooltip with keyboard shortcut for undo', () => {
      renderWithUndoRedo();
      expect(screen.getByLabelText('Undo')).toHaveAttribute('title', 'Undo (Ctrl+Z)');
    });

    it('shows tooltip with keyboard shortcut for redo', () => {
      renderWithUndoRedo();
      expect(screen.getByLabelText('Redo')).toHaveAttribute('title', 'Redo (Ctrl+Y)');
    });

    it('places undo/redo buttons after the loop range readout', () => {
      renderWithUndoRedo();
      const loopReadout = screen.getByTestId('loop-range-readout');
      const undoBtn = screen.getByLabelText('Undo');
      const redoBtn = screen.getByLabelText('Redo');
      const children = Array.from(loopReadout.parentElement!.children);
      const loopIdx = children.indexOf(loopReadout);
      const undoIdx = children.indexOf(undoBtn);
      const redoIdx = children.indexOf(redoBtn);
      expect(undoIdx).toBeGreaterThan(loopIdx);
      expect(redoIdx).toBeGreaterThan(loopIdx);
    });
  });
});
