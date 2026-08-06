import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScalePalette } from '@/components/ScalePalette';
import { editorStore } from '@/store/editorStore';
import type { Scale } from '@/types/music';

const C_MAJOR: Scale = { root: 'C', type: 'major' };
const A_MINOR: Scale = { root: 'A', type: 'naturalMinor' };

/**
 * The palette blocks, in order, as the user reads them.
 *
 * Queried by text content rather than `getByText` because the label and the
 * parenthesised numeral are separate elements (they are styled differently), and
 * Testing Library matches only an element's direct text nodes.
 */
function blockTexts(): string[] {
  return Array.from(document.querySelectorAll('[draggable="true"]')).map(el =>
    (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  );
}

/** The draggable block reading exactly `text`. */
function block(text: string): HTMLElement {
  const found = Array.from(document.querySelectorAll<HTMLElement>('[draggable="true"]')).find(
    el => (el.textContent ?? '').replace(/\s+/g, ' ').trim() === text
  );
  if (!found) throw new Error(`No palette block reading "${text}". Got: ${blockTexts().join(', ')}`);
  return found;
}

/** Minimal stand-in for the DataTransfer jsdom does not implement. */
function makeDataTransfer() {
  const data: Record<string, string> = {};
  return {
    data,
    setData: vi.fn((type: string, value: string) => {
      data[type] = value;
    }),
    getData: (type: string) => data[type] ?? '',
    effectAllowed: 'none',
  };
}

describe('ScalePalette', () => {
  // The palette's key, mode and octave are all store state now, not props, and the
  // store outlives a single test — so each case starts from the same settings.
  beforeEach(() => {
    editorStore.getState().setPaletteScale(C_MAJOR);
    editorStore.getState().setPaletteMode('chords');
    editorStore.getState().setPaletteOctave(4);
  });

  it('defaults to chords mode and renders each degree as "Label (Numeral)"', () => {
    render(<ScalePalette />);

    expect(blockTexts()).toEqual([
      'C (I)', 'Dm (ii)', 'Em (iii)', 'F (IV)', 'G (V)', 'Am (vi)', 'B° (vii°)',
    ]);
  });

  it('switches to notes mode, naming each note with its octave', () => {
    render(<ScalePalette />);

    fireEvent.change(screen.getByLabelText('Palette mode'), { target: { value: 'notes' } });

    expect(blockTexts()).toEqual([
      'C4 (I)', 'D4 (ii)', 'E4 (iii)', 'F4 (IV)', 'G4 (V)', 'A4 (vi)', 'B4 (vii°)',
    ]);
  });

  it('defaults to octave 4 and states it beside the blocks', () => {
    render(<ScalePalette />);

    expect((screen.getByLabelText('Octave') as HTMLSelectElement).value).toBe('4');
    expect(screen.getByText(/octave 4/)).toBeInTheDocument();
  });

  it('rebuilds note blocks in the chosen octave', () => {
    render(<ScalePalette />);
    fireEvent.change(screen.getByLabelText('Palette mode'), { target: { value: 'notes' } });
    fireEvent.change(screen.getByLabelText('Octave'), { target: { value: '6' } });

    expect(blockTexts()).toEqual([
      'C6 (I)', 'D6 (ii)', 'E6 (iii)', 'F6 (IV)', 'G6 (V)', 'A6 (vi)', 'B6 (vii°)',
    ]);
  });

  it('keeps chord symbols bare but carries the chosen octave in the payload', () => {
    render(<ScalePalette />);
    fireEvent.change(screen.getByLabelText('Octave'), { target: { value: '2' } });

    // The symbol must stay parseable by `chordFromSymbol`, so the octave is not
    // spliced into it — the strip caption and the timeline badge carry it.
    expect(blockTexts()[0]).toBe('C (I)');

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(block('C (I)'), { dataTransfer });
    expect(JSON.parse(dataTransfer.data['application/x-palette-item'])).toMatchObject({
      kind: 'chord',
      octave: 2,
    });
  });

  it('switches to seventh chords mode', () => {
    render(<ScalePalette />);

    fireEvent.change(screen.getByLabelText('Palette mode'), { target: { value: 'sevenths' } });

    expect(blockTexts()).toEqual([
      'Cmaj7 (Imaj7)', 'Dm7 (ii7)', 'Em7 (iii7)', 'Fmaj7 (IVmaj7)',
      'G7 (V7)', 'Am7 (vi7)', 'Bø7 (viiø7)',
    ]);
  });

  it('restocks itself from its own root and scale dropdowns', () => {
    render(<ScalePalette />);
    expect(blockTexts()[0]).toBe('C (I)');

    fireEvent.change(screen.getByLabelText('Root Note'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('Scale Type'), { target: { value: 'naturalMinor' } });

    expect(blockTexts().slice(0, 2)).toEqual(['Am (i)', 'B° (ii°)']);
    expect(editorStore.getState().paletteScale).toEqual(A_MINOR);
  });

  it('follows the palette scale in the store', () => {
    render(<ScalePalette />);
    expect(blockTexts()[0]).toBe('C (I)');

    fireEvent.change(screen.getByLabelText('Root Note'), { target: { value: 'G' } });
    expect(blockTexts()[0]).toBe('G (I)');
  });

  it('captions the strip with the scale name', () => {
    render(<ScalePalette />);
    expect(screen.getByTestId('palette-caption')).toHaveTextContent('C Major');
  });

  it('writes the palette item onto the drag payload', () => {
    render(<ScalePalette />);
    const dataTransfer = makeDataTransfer();

    fireEvent.dragStart(block('Dm (ii)'), { dataTransfer });

    const payload = JSON.parse(dataTransfer.data['application/x-palette-item']);
    expect(payload).toMatchObject({ kind: 'chord', label: 'Dm', root: 'D', quality: 'minor' });
    // jsdom only round-trips text/plain reliably, so the id is duplicated there.
    expect(dataTransfer.data['text/plain']).toBe(payload.id);
    expect(dataTransfer.effectAllowed).toBe('copy');
  });

  it('carries a pitch on note blocks', () => {
    render(<ScalePalette />);
    fireEvent.change(screen.getByLabelText('Palette mode'), { target: { value: 'notes' } });

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(block('C4 (I)'), { dataTransfer });

    const payload = JSON.parse(dataTransfer.data['application/x-palette-item']);
    expect(payload).toMatchObject({ kind: 'note', pitch: 60, octave: 4 });
  });
});
