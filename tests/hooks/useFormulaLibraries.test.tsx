import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ProjectFileRef } from '@/engine/projectFile';

// Hoisted, because `vi.mock` factories run before the module body does.
const { state, canReadSilently, readRef, writeRef, pickSaveRef, pickOpenRef, ensureWritable } =
  vi.hoisted(() => ({
    /** The library files `refStorage` hands back from IndexedDB. */
    state: { remembered: [] as ProjectFileRef[], stored: [] as ProjectFileRef[] },
    canReadSilently: vi.fn(),
    readRef: vi.fn(),
    writeRef: vi.fn(),
    pickSaveRef: vi.fn(),
    pickOpenRef: vi.fn(),
    ensureWritable: vi.fn(async () => true),
  }));

vi.mock('@/engine/refStorage', () => ({
  loadLibraryRefs: async () => state.remembered,
  storeLibraryRefs: async (refs: ProjectFileRef[]) => {
    state.stored = refs;
  },
}));

vi.mock('@/engine/projectFile', async importOriginal => {
  const actual = await importOriginal<typeof import('@/engine/projectFile')>();
  return { ...actual, canReadSilently, readRef, writeRef, pickSaveRef, pickOpenRef, ensureWritable };
});

import { useFormulaLibraries } from '@/hooks/useFormulaLibraries';
import { formulaLibraryStore, isLibraryDirty } from '@/store/formulaLibraryStore';
import { emptyLibrary, serializeLibrary, withGroup } from '@/engine/formulaLibrary';

const PATH_REF: ProjectFileRef = { kind: 'path', path: '/formulas/classic.ccformulas' };
const HANDLE_REF = { kind: 'handle', handle: { name: 'mine.ccformulas' } } as unknown as ProjectFileRef;

/** A library file's text, holding one group with one formula in it. */
function libraryJson(name: string): string {
  return serializeLibrary(
    withGroup(emptyLibrary(name), {
      id: 'g1',
      name: 'Neumes',
      formulas: [{ id: 'f1', name: 'Arch', steps: [{ degree: 0, beats: 1 }] }],
    })
  );
}

const libraries = () => formulaLibraryStore.getState().libraries;

describe('useFormulaLibraries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.remembered = [];
    state.stored = [];
    formulaLibraryStore.setState({
      libraries: [],
      selectedLibraryId: null,
      selectedGroupId: null,
    });
  });

  it('reopens the libraries the last session had open', async () => {
    state.remembered = [PATH_REF];
    canReadSilently.mockResolvedValue(true);
    readRef.mockResolvedValue(libraryJson('Classic'));

    renderHook(() => useFormulaLibraries());

    await waitFor(() => expect(libraries()).toHaveLength(1));
    expect(libraries()[0].library.name).toBe('Classic');
    expect(libraries()[0].ref).toEqual(PATH_REF);
    // Read straight off disk, so it opens with nothing to save.
    expect(isLibraryDirty(libraries()[0])).toBe(false);
  });

  it('forgets a file that is no longer there', async () => {
    state.remembered = [PATH_REF];
    canReadSilently.mockResolvedValue(false);

    renderHook(() => useFormulaLibraries());

    // Nothing to wait for but the effect itself; the list stays empty either way.
    await waitFor(() => expect(canReadSilently).toHaveBeenCalled());
    expect(libraries()).toHaveLength(0);
    expect(readRef).not.toHaveBeenCalled();
  });

  it('keeps a browser handle whose permission has lapsed, to be reloaded', async () => {
    state.remembered = [HANDLE_REF];
    canReadSilently.mockResolvedValue(false);

    renderHook(() => useFormulaLibraries());

    await waitFor(() => expect(libraries()).toHaveLength(1));
    expect(libraries()[0].needsPermission).toBe(true);
    expect(libraries()[0].ref).toEqual(HANDLE_REF);
  });

  it('reads a lapsed handle back once the click grants permission', async () => {
    state.remembered = [HANDLE_REF];
    canReadSilently.mockResolvedValue(false);
    readRef.mockResolvedValue(libraryJson('Mine'));

    const { result } = renderHook(() => useFormulaLibraries());
    await waitFor(() => expect(libraries()).toHaveLength(1));

    await act(() => result.current.reloadLibrary(libraries()[0].id));

    expect(libraries()[0].needsPermission).toBe(false);
    expect(libraries()[0].library.name).toBe('Mine');
    expect(isLibraryDirty(libraries()[0])).toBe(false);
  });

  it('writes a saved library back to its own file, without asking again', async () => {
    state.remembered = [PATH_REF];
    canReadSilently.mockResolvedValue(true);
    readRef.mockResolvedValue(libraryJson('Classic'));

    const { result } = renderHook(() => useFormulaLibraries());
    await waitFor(() => expect(libraries()).toHaveLength(1));

    const id = libraries()[0].id;
    act(() => {
      formulaLibraryStore.getState().updateLibrary(id, lib => ({ ...lib, name: 'Edited' }));
    });
    expect(isLibraryDirty(libraries()[0])).toBe(true);

    await act(() => result.current.saveLibrary(id));

    expect(pickSaveRef).not.toHaveBeenCalled();
    expect(writeRef).toHaveBeenCalledWith(PATH_REF, serializeLibrary(libraries()[0].library));
    expect(isLibraryDirty(libraries()[0])).toBe(false);
  });

  it('asks where to put a library that has never been saved', async () => {
    pickSaveRef.mockResolvedValue(PATH_REF);
    const { result } = renderHook(() => useFormulaLibraries());

    act(() => result.current.newLibrary());
    const id = libraries()[0].id;
    expect(libraries()[0].ref).toBeNull();

    await act(() => result.current.saveLibrary(id));

    expect(pickSaveRef).toHaveBeenCalled();
    expect(libraries()[0].ref).toEqual(PATH_REF);
    expect(isLibraryDirty(libraries()[0])).toBe(false);
  });

  it('leaves a library unsaved when the picker is cancelled', async () => {
    pickSaveRef.mockResolvedValue(null);
    const { result } = renderHook(() => useFormulaLibraries());

    act(() => result.current.newLibrary());
    await act(() => result.current.saveLibrary(libraries()[0].id));

    expect(writeRef).not.toHaveBeenCalled();
    expect(libraries()[0].ref).toBeNull();
  });

  it('opens a library through the shell’s dialog', async () => {
    pickOpenRef.mockResolvedValue(PATH_REF);
    readRef.mockResolvedValue(libraryJson('Opened'));

    const { result } = renderHook(() => useFormulaLibraries());
    await act(() => result.current.openLibrary());

    expect(libraries()).toHaveLength(1);
    expect(libraries()[0].library.name).toBe('Opened');
  });

  it('reports a file that is not a library', async () => {
    pickOpenRef.mockResolvedValue(PATH_REF);
    readRef.mockResolvedValue('{"instruments":[]}');

    const { result } = renderHook(() => useFormulaLibraries());
    await act(() => result.current.openLibrary());

    expect(libraries()).toHaveLength(0);
    expect(result.current.error).toMatch(/lists no groups/);
  });

  it('loads the starter set as an unsaved library, so the first save asks', async () => {
    const fetchMock = vi.fn(async () => new Response(libraryJson('Classic Formulas')));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFormulaLibraries());
    await act(() => result.current.loadStarterLibrary());

    expect(libraries()[0].library.name).toBe('Classic Formulas');
    expect(libraries()[0].ref).toBeNull();
    vi.unstubAllGlobals();
  });
});
