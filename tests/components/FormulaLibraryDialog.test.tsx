import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FormulaLibraryDialog } from '@/components/FormulaLibraryDialog';
import { FormulaLibraryProvider } from '@/context/formulaLibraryContext';
import type { UseFormulaLibrariesResult } from '@/hooks/useFormulaLibraries';
import { emptyLibrary, serializeLibrary, withGroup } from '@/engine/formulaLibrary';
import { formulaLibraryStore, type LoadedLibrary } from '@/store/formulaLibraryStore';

vi.mock('@/engine/refStorage', () => ({
  storeLibraryRefs: vi.fn(async () => {}),
  loadLibraryRefs: vi.fn(async () => []),
}));

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

function loaded(): LoadedLibrary {
  const library = withGroup(emptyLibrary('Classic'), {
    id: 'g1',
    name: 'Neumes',
    formulas: [{ id: 'f1', name: 'Arch', steps: [{ degree: 0, beats: 1 }] }],
  });
  return {
    id: 'l1',
    library,
    ref: { kind: 'path', path: '/songs/classic.ccformulas' },
    savedText: serializeLibrary(library),
  };
}

const renderDialog = (onClose = vi.fn()) =>
  render(
    <FormulaLibraryProvider value={libraryOps}>
      <FormulaLibraryDialog onClose={onClose} />
    </FormulaLibraryProvider>
  );

const current = () => formulaLibraryStore.getState().libraries[0];

describe('FormulaLibraryDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    formulaLibraryStore.setState({
      libraries: [],
      selectedLibraryId: null,
      selectedGroupId: null,
    });
    formulaLibraryStore.getState().addLibrary(loaded());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names each library by the file it came from', () => {
    renderDialog();
    expect(screen.getByTestId('library-file-l1')).toHaveTextContent('classic.ccformulas');
  });

  it('says so when a library has never been saved', () => {
    formulaLibraryStore.getState().replaceLibrary('l1', { ref: null });
    renderDialog();
    expect(screen.getByTestId('library-file-l1')).toHaveTextContent('Unsaved');
  });

  it('adds a group', () => {
    renderDialog();
    fireEvent.click(screen.getByText('New group'));
    expect(current().library.groups).toHaveLength(2);
  });

  it('renames a group', () => {
    renderDialog();
    fireEvent.change(screen.getByDisplayValue('Neumes'), { target: { value: 'Medieval' } });
    expect(current().library.groups[0].name).toBe('Medieval');
  });

  it('deletes a group, and the formulas in it', () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText('Delete group Neumes'));
    expect(current().library.groups).toHaveLength(0);
  });

  it('deletes one formula, leaving its group', () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText('Delete Arch'));
    expect(current().library.groups[0].formulas).toHaveLength(0);
    expect(current().library.groups).toHaveLength(1);
  });

  it('marks a library that has been edited', () => {
    renderDialog();
    expect(within(screen.getByTestId('library-file-l1')).queryByTitle('Unsaved changes')).toBeNull();

    fireEvent.change(screen.getByDisplayValue('Neumes'), { target: { value: 'Medieval' } });
    expect(
      within(screen.getByTestId('library-file-l1')).getByTitle('Unsaved changes')
    ).toBeInTheDocument();
  });

  it('asks before closing a library with unsaved changes', () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    renderDialog();

    fireEvent.change(screen.getByDisplayValue('Neumes'), { target: { value: 'Medieval' } });
    fireEvent.click(screen.getByText('Close'));

    expect(confirm).toHaveBeenCalled();
    expect(formulaLibraryStore.getState().libraries).toHaveLength(1);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText('Close'));
    expect(formulaLibraryStore.getState().libraries).toHaveLength(0);
  });

  it('closes a saved library without asking', () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    renderDialog();

    fireEvent.click(screen.getByText('Close'));

    expect(confirm).not.toHaveBeenCalled();
    expect(formulaLibraryStore.getState().libraries).toHaveLength(0);
  });

  it('offers a reload for a library still waiting on permission', () => {
    formulaLibraryStore.getState().replaceLibrary('l1', { needsPermission: true });
    renderDialog();

    fireEvent.click(screen.getByText('Reload'));
    expect(libraryOps.reloadLibrary).toHaveBeenCalledWith('l1');
  });

  it('opens the editor on a formula', () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText('Edit Arch'));
    expect(screen.getByTestId('formula-editor')).toBeInTheDocument();
    expect(screen.getByLabelText('Formula name')).toHaveValue('Arch');
  });
});
