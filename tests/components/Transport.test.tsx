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

  const defaultProps = {
    isPlaying: false,
    isPaused: false,
    bpm: 120,
    timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
    musicalKey: 'C',
    keyMode: 'major' as const,
    loopEnabled: false,
    loopRangeLabel: null,
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
});
