import { useCallback, useEffect, useState } from 'react';
import {
  FORMULA_LIBRARY_FILTER,
  STARTER_LIBRARY_URL,
  deserializeLibrary,
  emptyLibrary,
  serializeLibrary,
} from '@/engine/formulaLibrary';
import {
  canReadSilently,
  ensureWritable,
  pickOpenRef,
  pickSaveRef,
  readRef,
  writeRef,
  type ProjectFileRef,
} from '@/engine/projectFile';
import { loadLibraryRefs } from '@/engine/refStorage';
import { formulaLibraryStore, newLoadedId } from '@/store/formulaLibraryStore';

export interface UseFormulaLibrariesResult {
  /** Last error raised by a library file operation, cleared on the next attempt. */
  error: string | null;
  clearError: () => void;
  /** Start an empty library, unsaved until the first Save asks where it goes. */
  newLibrary: () => void;
  /** Open a library through the shell's own dialog. */
  openLibrary: () => Promise<void>;
  /** Open a `File` from the hidden input, for shells with no dialog. */
  openLibraryFile: (file: File) => Promise<void>;
  /** Fetch the classic formulas that ship with the app. */
  loadStarterLibrary: () => Promise<void>;
  /** Write a library to its own file, asking for one only if it has none. */
  saveLibrary: (id: string) => Promise<void>;
  /** Always ask where to write, and adopt that file as the library's own. */
  saveLibraryAs: (id: string) => Promise<void>;
  /** Re-read a library from its file, discarding whatever is open. */
  reloadLibrary: (id: string) => Promise<void>;
}

/** Turn an arbitrary thrown value into a message suitable for the UI. */
function toMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Strip characters that are unsafe in a filename. */
function toFilename(name: string): string {
  const base = name.trim().replace(/[^a-z0-9-_ ]/gi, '').replace(/\s+/g, '-') || 'formulas';
  return `${base}.ccformulas`;
}

/**
 * Opening, saving and remembering the formula libraries.
 *
 * Shaped after `useFileIO`, and mounted once at the top of the tree for the same
 * reason: it owns the start-up restore, and a second instance would run it twice.
 *
 * Nothing here touches the project. A library outlives the piece it was used on — that
 * is the whole point of having one — so saving a library leaves the project exactly as
 * dirty as it was, and opening one says nothing about which project is open.
 */
export function useFormulaLibraries(): UseFormulaLibrariesResult {
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);

  /** Add a library read from `text`, remembering the file it came from. */
  const adopt = useCallback((text: string, ref: ProjectFileRef | null) => {
    const library = deserializeLibrary(text);
    formulaLibraryStore.getState().addLibrary({
      id: newLoadedId(),
      library,
      ref,
      // What was read is what is on disk, so a library opens clean.
      savedText: ref ? serializeLibrary(library) : null,
    });
  }, []);

  /**
   * Reopen the libraries the last session had open.
   *
   * Mount-only, and silent: start-up has no user gesture to spend and no failure the
   * user caused. A path that no longer reads is forgotten — the file was moved or
   * deleted, and listing a library that cannot be reached would only mislead. A
   * browser handle is different: it is only waiting for a permission the next click
   * can grant, so it is kept and listed as needing one.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const refs = await loadLibraryRefs();
      for (const ref of refs) {
        if (cancelled) return;
        try {
          if (await canReadSilently(ref)) {
            adopt(await readRef(ref), ref);
          } else if (ref.kind === 'handle') {
            formulaLibraryStore.getState().addLibrary({
              id: newLoadedId(),
              library: emptyLibrary('Formulas'),
              ref,
              savedText: null,
              needsPermission: true,
            });
          }
        } catch {
          // An unreadable or corrupt library is dropped rather than reported: the app
          // has only just started, and nothing the user did has failed.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only: running again on a later render would reopen files over live edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newLibrary = useCallback(() => {
    setError(null);
    formulaLibraryStore.getState().addLibrary({
      id: newLoadedId(),
      library: emptyLibrary('My Formulas'),
      ref: null,
      savedText: null,
    });
  }, []);

  const openLibrary = useCallback(async () => {
    setError(null);
    try {
      const target = await pickOpenRef(FORMULA_LIBRARY_FILTER);
      if (!target) return; // Cancelled — not an error.
      adopt(await readRef(target), target);
    } catch (err) {
      setError(toMessage(err, 'Failed to open the formula library.'));
    }
  }, [adopt]);

  const openLibraryFile = useCallback(
    async (file: File) => {
      setError(null);
      try {
        // A `File` from an input is a snapshot, not a reference — there is nothing to
        // write back to, so the library opens unsaved and the first save asks.
        adopt(await file.text(), null);
      } catch (err) {
        setError(toMessage(err, 'Failed to open the formula library.'));
      }
    },
    [adopt]
  );

  const loadStarterLibrary = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(STARTER_LIBRARY_URL);
      if (!response.ok) throw new Error('The starter formulas could not be found.');
      // Adopted with no ref on purpose: it is a starting point, and its first save
      // should ask where it goes rather than write into the app's own assets.
      adopt(await response.text(), null);
    } catch (err) {
      setError(toMessage(err, 'Failed to load the starter formulas.'));
    }
  }, [adopt]);

  /** Write a library, to `chosen` if given and otherwise to the file it already has. */
  const saveTo = useCallback(async (id: string, chosen: ProjectFileRef | null) => {
    const loaded = formulaLibraryStore.getState().libraries.find(l => l.id === id);
    if (!loaded) return;
    setError(null);

    try {
      let target = chosen;
      if (!target) {
        // A handle restored from a previous session has no permission yet, and the
        // re-grant prompt only opens from the click that got us here.
        target = loaded.ref && (await ensureWritable(loaded.ref)) ? loaded.ref : null;
      }
      if (!target) {
        target = await pickSaveRef(toFilename(loaded.library.name), FORMULA_LIBRARY_FILTER);
        if (!target) return; // Cancelled — nothing written.
      }

      const text = serializeLibrary(loaded.library);
      await writeRef(target, text);
      // A download left the app but named no file to go back to, so the library stays
      // unsaved — the next save must ask again rather than claim a file it cannot reach.
      formulaLibraryStore.getState().replaceLibrary(id, {
        ref: target.kind === 'download' ? null : target,
        savedText: text,
        needsPermission: false,
      });
    } catch (err) {
      setError(toMessage(err, 'Failed to save the formula library.'));
    }
  }, []);

  const saveLibrary = useCallback((id: string) => saveTo(id, null), [saveTo]);

  const saveLibraryAs = useCallback(
    async (id: string) => {
      const loaded = formulaLibraryStore.getState().libraries.find(l => l.id === id);
      if (!loaded) return;
      const target = await pickSaveRef(toFilename(loaded.library.name), FORMULA_LIBRARY_FILTER);
      if (!target) return;
      await saveTo(id, target);
    },
    [saveTo]
  );

  const reloadLibrary = useCallback(async (id: string) => {
    const loaded = formulaLibraryStore.getState().libraries.find(l => l.id === id);
    if (!loaded?.ref) return;
    setError(null);
    try {
      // The click is the gesture a lapsed handle's permission prompt needs.
      await ensureWritable(loaded.ref);
      const text = await readRef(loaded.ref);
      formulaLibraryStore.getState().replaceLibrary(id, {
        library: deserializeLibrary(text),
        savedText: text,
        needsPermission: false,
      });
    } catch (err) {
      setError(toMessage(err, 'Failed to read the formula library.'));
    }
  }, []);

  return {
    error,
    clearError,
    newLibrary,
    openLibrary,
    openLibraryFile,
    loadStarterLibrary,
    saveLibrary,
    saveLibraryAs,
    reloadLibrary,
  };
}
