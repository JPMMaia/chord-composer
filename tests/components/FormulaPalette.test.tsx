import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { FormulaPalette } from '@/components/FormulaPalette';
import { editorStore } from '@/store/editorStore';
import { FORMULA_DRAG_TYPE, type MelodicFormula } from '@/engine/formulas';
import { emptyLibrary, serializeLibrary, withGroup } from '@/engine/formulaLibrary';
import { formulaLibraryStore, type LoadedLibrary } from '@/store/formulaLibraryStore';
import { FormulaLibraryProvider } from '@/context/formulaLibraryContext';
import type { UseFormulaLibrariesResult } from '@/hooks/useFormulaLibraries';
import { selectionStore } from '@/store/selectionStore';

vi.mock('@/engine/refStorage', () => ({
  storeLibraryRefs: vi.fn(async () => {}),
  loadLibraryRefs: vi.fn(async () => []),
}));

const arch: MelodicFormula = {
  id: 'arch',
  name: 'Arch',
  steps: [
    { degree: 0, beats: 1 },
    { degree: 1, beats: 1 },
    { degree: 0, beats: 1 },
  ],
};

const clivis: MelodicFormula = {
  id: 'clivis',
  name: 'Clivis',
  steps: [
    { degree: 0, beats: 1 },
    { degree: -1, beats: 1 },
  ],
};

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

const libraryOps = {
  error: null,
  clearError: vi.fn(),
  newLibrary: vi.fn(),
  openLibrary: vi.fn(async () => {}),
  openLibraryFile: vi.fn(async () => {}),
  loadStarterLibrary: vi.fn(async () => {}),
  saveLibrary: vi.fn(async () => {}),
  saveLibraryAs: vi.fn(async () => {}),
  reloadLibrary: vi.fn(async () => {}),
} satisfies UseFormulaLibrariesResult;

const renderPalette = (ui: ReactElement = <FormulaPalette />) =>
  render(<FormulaLibraryProvider value={libraryOps}>{ui}</FormulaLibraryProvider>);

/** A library holding one group of the given formulas. */
function loadedLibrary(
  id: string,
  name: string,
  groupId: string,
  formulas: MelodicFormula[]
): LoadedLibrary {
  const library = withGroup(emptyLibrary(name), { id: groupId, name: `${name} group`, formulas });
  return { id, library, ref: null, savedText: serializeLibrary(library) };
}

/** The ids of the chips currently on offer. */
function chipIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[draggable="true"]')).map(
    el => el.dataset.testid ?? ''
  );
}

describe('FormulaPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorStore.setState({
      paletteScale: { root: 'C', type: 'major' },
      paletteOctave: 4,
      formulaStartDegree: 0,
      formulasExpanded: true,
      draggingFormulaId: null,
    });
    selectionStore.setState({ selectedSegmentIds: [] });
    formulaLibraryStore.setState({
      libraries: [],
      selectedLibraryId: null,
      selectedGroupId: null,
    });
    formulaLibraryStore.getState().addLibrary(loadedLibrary('l1', 'Classic', 'g1', [arch, clivis]));
  });

  it('offers the selected group’s formulas', () => {
    renderPalette();
    expect(screen.getByTestId('formula-item-arch')).toBeInTheDocument();
    expect(chipIds()).toEqual(['formula-item-arch', 'formula-item-clivis']);
  });

  it('shows an altered step’s accidental on the chip', () => {
    formulaLibraryStore.setState({ libraries: [], selectedLibraryId: null, selectedGroupId: null });
    formulaLibraryStore.getState().addLibrary(
      loadedLibrary('l1', 'Chromatic', 'g1', [
        {
          id: 'lead',
          name: 'Leading tone',
          steps: [
            { degree: 0, beats: 1 },
            { degree: 6, alter: 1, beats: 1 },
            { degree: 7, beats: 1 },
          ],
        },
      ])
    );
    renderPalette();
    expect(screen.getByTestId('formula-item-lead')).toHaveTextContent('0 +6♯ +7');
  });

  it('lists every open library’s groups together, each under its own name', () => {
    formulaLibraryStore.getState().addLibrary(loadedLibrary('l2', 'Mine', 'g2', [clivis]));
    renderPalette();

    const select = screen.getByLabelText('Formula group') as HTMLSelectElement;
    const groups = Array.from(select.querySelectorAll('optgroup'));
    expect(groups.map(g => g.label)).toEqual(['Classic', 'Mine']);
    expect(Array.from(select.options).map(o => o.value)).toEqual(['l1:g1', 'l2:g2']);
  });

  it('swaps the chips when the group changes', () => {
    formulaLibraryStore.getState().addLibrary(loadedLibrary('l2', 'Mine', 'g2', [clivis]));
    renderPalette();

    fireEvent.change(screen.getByLabelText('Formula group'), { target: { value: 'l1:g1' } });

    expect(formulaLibraryStore.getState().selectedLibraryId).toBe('l1');
    expect(formulaLibraryStore.getState().selectedGroupId).toBe('g1');
    expect(chipIds()).toEqual(['formula-item-arch', 'formula-item-clivis']);
  });

  it('says so, and offers a way out, when nothing is loaded', () => {
    formulaLibraryStore.setState({
      libraries: [],
      selectedLibraryId: null,
      selectedGroupId: null,
    });
    renderPalette();

    expect(screen.getByTestId('formula-empty')).toBeInTheDocument();
    expect(screen.queryByLabelText('Formula group')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('formula-load-starter'));
    expect(libraryOps.loadStarterLibrary).toHaveBeenCalled();
  });

  it('names the start degrees with the palette key’s numerals', () => {
    editorStore.setState({ paletteScale: { root: 'A', type: 'naturalMinor' } });
    renderPalette();

    const select = screen.getByLabelText('Start degree') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.text)).toEqual([
      'Start on i',
      'Start on ii°',
      'Start on III',
      'Start on iv',
      'Start on v',
      'Start on VI',
      'Start on VII',
    ]);

    fireEvent.change(select, { target: { value: '4' } });
    expect(editorStore.getState().formulaStartDegree).toBe(4);
  });

  it('carries the whole formula on the drag, plus a text/plain fallback', () => {
    renderPalette();
    const dataTransfer = makeDataTransfer();

    fireEvent.dragStart(screen.getByTestId('formula-item-arch'), { dataTransfer });

    // The whole formula rather than an id, so the drop needs no library lookup.
    expect(JSON.parse(dataTransfer.data[FORMULA_DRAG_TYPE])).toEqual(arch);
    // jsdom — and a few browsers mid-drag — only expose text/plain reliably.
    expect(dataTransfer.data['text/plain']).toBe('arch');
  });

  it('publishes what is being dragged, so the timeline caret can size itself', () => {
    renderPalette();
    const chip = screen.getByTestId('formula-item-arch');

    fireEvent.dragStart(chip, { dataTransfer: makeDataTransfer() });
    expect(editorStore.getState().draggingFormulaId).toBe('arch');

    fireEvent.dragEnd(chip);
    expect(editorStore.getState().draggingFormulaId).toBeNull();
  });

  it('can only capture while something is selected', () => {
    renderPalette();
    expect(screen.getByTestId('formula-capture')).toBeDisabled();

    selectionStore.setState({ selectedSegmentIds: ['a'] });
    renderPalette();
    expect(screen.getAllByTestId('formula-capture').at(-1)).toBeEnabled();
  });

  it('folds away, leaving only its toggle', () => {
    renderPalette();
    fireEvent.click(screen.getByTestId('formula-toggle'));

    expect(editorStore.getState().formulasExpanded).toBe(false);
    expect(chipIds()).toEqual([]);
    expect(screen.queryByLabelText('Formula group')).not.toBeInTheDocument();
  });
});
