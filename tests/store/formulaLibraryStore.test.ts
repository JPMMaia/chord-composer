import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FormulaLibrary } from '@/engine/formulaLibrary';
import { emptyLibrary, serializeLibrary, withGroup } from '@/engine/formulaLibrary';
import {
  findLoadedFormula,
  formulaLibraryStore,
  isLibraryDirty,
  type LoadedLibrary,
} from '@/store/formulaLibraryStore';
import { storeLibraryRefs } from '@/engine/refStorage';

vi.mock('@/engine/refStorage', () => ({
  storeLibraryRefs: vi.fn(async () => {}),
  loadLibraryRefs: vi.fn(async () => []),
}));

const library = (name: string, groupId: string, formulaId: string): FormulaLibrary =>
  withGroup(emptyLibrary(name), {
    id: groupId,
    name: `${name} group`,
    formulas: [{ id: formulaId, name: formulaId, steps: [{ degree: 0, beats: 1 }] }],
  });

const loaded = (id: string, lib: FormulaLibrary, ref: LoadedLibrary['ref'] = null): LoadedLibrary => ({
  id,
  library: lib,
  ref,
  savedText: serializeLibrary(lib),
});

describe('formulaLibraryStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    formulaLibraryStore.setState({ libraries: [], selectedLibraryId: null, selectedGroupId: null });
  });

  it('points the strip at a library as it is opened', () => {
    formulaLibraryStore.getState().addLibrary(loaded('l1', library('One', 'g1', 'f1')));
    expect(formulaLibraryStore.getState().selectedLibraryId).toBe('l1');
    expect(formulaLibraryStore.getState().selectedGroupId).toBe('g1');
  });

  it('follows the library just opened rather than staying on the old one', () => {
    formulaLibraryStore.getState().addLibrary(loaded('l1', library('One', 'g1', 'f1')));
    formulaLibraryStore.getState().addLibrary(loaded('l2', library('Two', 'g2', 'f2')));
    expect(formulaLibraryStore.getState().selectedLibraryId).toBe('l2');
    expect(formulaLibraryStore.getState().selectedGroupId).toBe('g2');
  });

  it('moves the selection off a library that is closed', () => {
    formulaLibraryStore.getState().addLibrary(loaded('l1', library('One', 'g1', 'f1')));
    formulaLibraryStore.getState().addLibrary(loaded('l2', library('Two', 'g2', 'f2')));

    formulaLibraryStore.getState().closeLibrary('l2');
    expect(formulaLibraryStore.getState().selectedLibraryId).toBe('l1');
    expect(formulaLibraryStore.getState().selectedGroupId).toBe('g1');

    formulaLibraryStore.getState().closeLibrary('l1');
    expect(formulaLibraryStore.getState().selectedLibraryId).toBeNull();
    expect(formulaLibraryStore.getState().selectedGroupId).toBeNull();
  });

  it('moves the selection off a group that is deleted', () => {
    formulaLibraryStore.getState().addLibrary(loaded('l1', library('One', 'g1', 'f1')));
    formulaLibraryStore
      .getState()
      .updateLibrary('l1', lib => ({ ...lib, groups: [] }));
    expect(formulaLibraryStore.getState().selectedGroupId).toBeNull();
  });

  it('finds a formula in any open library', () => {
    formulaLibraryStore.getState().addLibrary(loaded('l1', library('One', 'g1', 'f1')));
    formulaLibraryStore.getState().addLibrary(loaded('l2', library('Two', 'g2', 'f2')));
    expect(findLoadedFormula('f1')?.id).toBe('f1');
    expect(findLoadedFormula('f2')?.id).toBe('f2');
    expect(findLoadedFormula('nope')).toBeUndefined();
  });

  it('derives dirty from the text last read or written', () => {
    const entry = loaded('l1', library('One', 'g1', 'f1'));
    formulaLibraryStore.getState().addLibrary(entry);
    expect(isLibraryDirty(formulaLibraryStore.getState().libraries[0])).toBe(false);

    formulaLibraryStore.getState().updateLibrary('l1', lib => ({ ...lib, name: 'Edited' }));
    expect(isLibraryDirty(formulaLibraryStore.getState().libraries[0])).toBe(true);
  });

  it('counts a library that has never been written as dirty', () => {
    formulaLibraryStore
      .getState()
      .addLibrary({ ...loaded('l1', emptyLibrary('New')), savedText: null });
    expect(isLibraryDirty(formulaLibraryStore.getState().libraries[0])).toBe(true);
  });

  it('remembers only the libraries that have a file', () => {
    formulaLibraryStore
      .getState()
      .addLibrary(loaded('l1', library('One', 'g1', 'f1'), { kind: 'path', path: '/a.ccformulas' }));
    formulaLibraryStore.getState().addLibrary(loaded('l2', library('Two', 'g2', 'f2')));

    expect(storeLibraryRefs).toHaveBeenLastCalledWith([{ kind: 'path', path: '/a.ccformulas' }]);
  });

  it('forgets a closed library’s file', () => {
    formulaLibraryStore
      .getState()
      .addLibrary(loaded('l1', library('One', 'g1', 'f1'), { kind: 'path', path: '/a.ccformulas' }));
    formulaLibraryStore.getState().closeLibrary('l1');
    expect(storeLibraryRefs).toHaveBeenLastCalledWith([]);
  });
});
