import { create } from 'zustand';
import type { MelodicFormula } from '@/engine/formulas';
import type { FormulaLibrary } from '@/engine/formulaLibrary';
import { serializeLibrary } from '@/engine/formulaLibrary';
import type { ProjectFileRef } from '@/engine/projectFile';
import { storeLibraryRefs } from '@/engine/refStorage';

/** One formula library open in the app, and what is known about its file. */
export interface LoadedLibrary {
  /**
   * Session-local id.
   *
   * Not the file path: a library created in the app has no file yet, and two
   * libraries must stay distinguishable while both are untitled.
   */
  id: string;
  library: FormulaLibrary;
  /** The file it came from, or null for one created here and never saved. */
  ref: ProjectFileRef | null;
  /**
   * Its serialized text as last read or written.
   *
   * Held so "has this been edited" is *derived* rather than tracked — the same trick
   * `projectFileStore.savedSnapshot` uses, and for the same reason: there is no flag
   * to forget to reset.
   */
  savedText: string | null;
  /**
   * Set when the file was remembered but could not be read on start-up without
   * prompting — a browser file handle whose permission has lapsed. The library is
   * listed with a Reload button rather than silently forgotten.
   */
  needsPermission?: boolean;
}

interface FormulaLibraryState {
  libraries: LoadedLibrary[];
  /** Which group the formula strip is showing, as a library and a group within it. */
  selectedLibraryId: string | null;
  selectedGroupId: string | null;

  addLibrary: (loaded: LoadedLibrary) => void;
  /** Swap a library out wholesale — after a save, or a reload from its file. */
  replaceLibrary: (id: string, loaded: Partial<LoadedLibrary>) => void;
  closeLibrary: (id: string) => void;
  /** The single funnel every edit goes through; the updater returns a new library. */
  updateLibrary: (id: string, updater: (library: FormulaLibrary) => FormulaLibrary) => void;
  selectGroup: (libraryId: string | null, groupId: string | null) => void;
}

/** Fresh id for a loaded library. Session-local, so a counter is enough. */
let nextId = 0;
export function newLoadedId(): string {
  nextId += 1;
  return `library-${nextId}`;
}

/**
 * The formula libraries open in this session.
 *
 * Separate from `editorStore` because a library is not a view setting: it outlives the
 * project, is written to a file of its own, and several can be open at once. The
 * strip's *selection* lives here too, rather than beside the palette's, because group
 * ids are only unique within a library and because closing one has to move the
 * selection off it — neither of which `editorStore` could do without knowing all this.
 *
 * Writes to IndexedDB are fire-and-forget so the store stays synchronous, exactly as
 * `projectFileStore`'s are; see `refStorage.ts`, where every failure is swallowed.
 */
export const formulaLibraryStore = create<FormulaLibraryState>((set, get) => {
  /** Remember which files are open, after any change to the list. */
  const remember = (libraries: LoadedLibrary[]) => {
    void storeLibraryRefs(
      libraries.map(l => l.ref).filter((ref): ref is ProjectFileRef => ref !== null)
    );
  };

  /**
   * Point the strip at a group that still exists.
   *
   * Called after every change to the list so the strip can never be left showing a
   * library that was closed, or waiting on a selection when there is an obvious one
   * to make.
   */
  const settleSelection = (
    libraries: LoadedLibrary[],
    selectedLibraryId: string | null,
    selectedGroupId: string | null
  ) => {
    const current = libraries.find(l => l.id === selectedLibraryId);
    if (current?.library.groups.some(g => g.id === selectedGroupId)) {
      return { selectedLibraryId, selectedGroupId };
    }
    // The first group of the first library that has one — which for a single library
    // just opened is the one the user is looking at.
    for (const loaded of libraries) {
      const group = loaded.library.groups[0];
      if (group) return { selectedLibraryId: loaded.id, selectedGroupId: group.id };
    }
    return { selectedLibraryId: null, selectedGroupId: null };
  };

  /** Apply a new list of libraries, settling the selection and the remembered files. */
  const applyLibraries = (libraries: LoadedLibrary[]) => {
    remember(libraries);
    const { selectedLibraryId, selectedGroupId } = get();
    set({ libraries, ...settleSelection(libraries, selectedLibraryId, selectedGroupId) });
  };

  return {
    libraries: [],
    selectedLibraryId: null,
    selectedGroupId: null,

    addLibrary: loaded => {
      applyLibraries([...get().libraries, loaded]);
      // A library the user just opened is the one they want to see, whatever the
      // selection settled on — so point the strip at its first group.
      const group = loaded.library.groups[0];
      if (group) set({ selectedLibraryId: loaded.id, selectedGroupId: group.id });
    },

    replaceLibrary: (id, changes) => {
      applyLibraries(get().libraries.map(l => (l.id === id ? { ...l, ...changes } : l)));
    },

    closeLibrary: id => {
      applyLibraries(get().libraries.filter(l => l.id !== id));
    },

    updateLibrary: (id, updater) => {
      applyLibraries(
        get().libraries.map(l => (l.id === id ? { ...l, library: updater(l.library) } : l))
      );
    },

    selectGroup: (libraryId, groupId) => {
      set({ selectedLibraryId: libraryId, selectedGroupId: groupId });
    },
  };
});

/** Whether a library has been edited since it was last read or written. */
export function isLibraryDirty(loaded: LoadedLibrary): boolean {
  return serializeLibrary(loaded.library) !== loaded.savedText;
}

/**
 * A formula by id, across every open library.
 *
 * What the drag caret uses to size itself: the dragged payload is unreadable during
 * `dragover`, so all the timeline has to go on is the id in `draggingFormulaId`.
 */
export function findLoadedFormula(formulaId: string): MelodicFormula | undefined {
  for (const loaded of formulaLibraryStore.getState().libraries) {
    for (const group of loaded.library.groups) {
      const found = group.formulas.find(f => f.id === formulaId);
      if (found) return found;
    }
  }
  return undefined;
}

/** The group the strip is showing, with the library it belongs to. */
export function selectedGroup(state: FormulaLibraryState) {
  const loaded = state.libraries.find(l => l.id === state.selectedLibraryId);
  const group = loaded?.library.groups.find(g => g.id === state.selectedGroupId);
  return loaded && group ? { loaded, group } : null;
}
