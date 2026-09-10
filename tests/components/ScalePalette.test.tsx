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
  // The palette's key, size and octave are all store state now, not props, and the
  // store outlives a single test — so each case starts from the same settings.
  beforeEach(() => {
    editorStore.getState().setPaletteScale(C_MAJOR);
    editorStore.getState().setPaletteSize(3);
    editorStore.getState().setPaletteOctave(4);
  });

  it('defaults to triads and renders each degree as "Label (Numeral)"', () => {
    render(<ScalePalette />);

    expect(blockTexts()).toEqual([
      'C (I)', 'Dm (ii)', 'Em (iii)', 'F (IV)', 'G (V)', 'Am (vi)', 'B° (vii°)',
    ]);
  });

  it('offers one tone per degree at the smallest size', () => {
    render(<ScalePalette />);

    fireEvent.change(screen.getByLabelText('Palette size'), { target: { value: '1' } });

    expect(blockTexts()).toEqual([
      'C (I)', 'D (ii)', 'E (iii)', 'F (IV)', 'G (V)', 'A (vi)', 'B (vii°)',
    ]);
  });

  it('thickens every degree at once as the size grows', () => {
    render(<ScalePalette />);

    fireEvent.change(screen.getByLabelText('Palette size'), { target: { value: '2' } });
    expect(blockTexts()[1]).toBe('Dm(no5) (ii(no5))');

    fireEvent.change(screen.getByLabelText('Palette size'), { target: { value: '5' } });
    expect(blockTexts()).toEqual([
      'Cmaj9 (Imaj9)', 'Dm9 (ii9)', 'Em9 (iii9)', 'Fmaj9 (IVmaj9)',
      'G9 (V9)', 'Am9 (vi9)', 'Bø9 (viiø9)',
    ]);
  });

  it('defaults to octave 4 and states it beside the blocks', () => {
    render(<ScalePalette />);

    expect((screen.getByLabelText('Octave') as HTMLSelectElement).value).toBe('4');
    expect(screen.getByText(/octave 4/)).toBeInTheDocument();
  });

  it('rebuilds one-tone blocks in the chosen octave', () => {
    render(<ScalePalette />);
    fireEvent.change(screen.getByLabelText('Palette size'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Octave'), { target: { value: '6' } });

    // A one-tone block is a chord segment, so its register rides in the payload
    // rather than being spliced into a bare note name.
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(block('C (I)'), { dataTransfer });
    expect(JSON.parse(dataTransfer.data['application/x-palette-item'])).toMatchObject({
      kind: 'chord',
      tones: [0],
      octave: 6,
    });
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

  it('offers sevenths at size four', () => {
    render(<ScalePalette />);

    fireEvent.change(screen.getByLabelText('Palette size'), { target: { value: '4' } });

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

  it('carries the stack on the payload, at every size', () => {
    render(<ScalePalette />);

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(block('C (I)'), { dataTransfer });
    expect(JSON.parse(dataTransfer.data['application/x-palette-item'])).toMatchObject({
      kind: 'chord',
      tones: [0, 1, 2],
    });

    fireEvent.change(screen.getByLabelText('Palette size'), { target: { value: '5' } });
    const ninth = makeDataTransfer();
    fireEvent.dragStart(block('Cmaj9 (Imaj9)'), { dataTransfer: ninth });
    expect(JSON.parse(ninth.data['application/x-palette-item'])).toMatchObject({
      kind: 'chord',
      tones: [0, 1, 2, 3, 4],
    });
  });
});
