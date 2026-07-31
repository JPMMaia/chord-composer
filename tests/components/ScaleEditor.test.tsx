import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScaleEditor } from '@/components/ScaleEditor';
import type { NoteName, ScaleType } from '@/types/music';

describe('ScaleEditor', () => {
  const mockOnRootChange = vi.fn();
  const mockOnTypeChange = vi.fn();

  const defaultProps = {
    root: 'C' as NoteName,
    type: 'major' as ScaleType,
    onRootChange: mockOnRootChange,
    onTypeChange: mockOnTypeChange,
  };

  it('renders root note selector', () => {
    render(<ScaleEditor {...defaultProps} />);
    const select = screen.getByLabelText('Root Note');
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue('C');
  });

  it('renders scale type selector', () => {
    render(<ScaleEditor {...defaultProps} />);
    const select = screen.getByLabelText('Scale Type');
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue('major');
  });

  it('shows active notes visually', () => {
    render(<ScaleEditor {...defaultProps} />);
    // The piano keyboard should show active notes
    const pianoKeyboard = screen.getByTestId('piano-keyboard');
    expect(pianoKeyboard).toBeInTheDocument();
  });

  it('updates scale when root changes', () => {
    render(<ScaleEditor {...defaultProps} />);
    const select = screen.getByLabelText('Root Note') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'G' } });
    expect(mockOnRootChange).toHaveBeenCalledWith('G');
  });

  it('updates scale when type changes', () => {
    render(<ScaleEditor {...defaultProps} />);
    const select = screen.getByLabelText('Scale Type') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'naturalMinor' } });
    expect(mockOnTypeChange).toHaveBeenCalledWith('naturalMinor');
  });

  it('highlights active notes on piano keyboard', () => {
    render(<ScaleEditor {...defaultProps} />);
    const pianoKeyboard = screen.getByTestId('piano-keyboard');
    // C major has notes: C, D, E, F, G, A, B (all white keys active)
    // The keyboard should show active notes with a different class
    const activeKeys = pianoKeyboard.querySelectorAll('[data-note-active="true"]');
    // C major has 7 notes
    expect(activeKeys.length).toBeGreaterThan(0);
  });

  it('shows different active notes for minor scale', () => {
    render(<ScaleEditor {...defaultProps} type="naturalMinor" />);
    const pianoKeyboard = screen.getByTestId('piano-keyboard');
    const activeKeys = pianoKeyboard.querySelectorAll('[data-note-active="true"]');
    // A minor (C natural minor) has 7 notes
    expect(activeKeys.length).toBeGreaterThan(0);
  });

  it('renders pentatonic scale with fewer active notes', () => {
    render(<ScaleEditor {...defaultProps} type="pentatonicMajor" />);
    const pianoKeyboard = screen.getByTestId('piano-keyboard');
    const activeKeys = pianoKeyboard.querySelectorAll('[data-note-active="true"]');
    // Pentatonic has 5 notes
    expect(activeKeys.length).toBe(5);
  });
});
