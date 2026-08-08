import { create } from 'zustand';
import type { Project } from '@/types/music';
import type { ProjectFileRef } from '@/engine/projectFile';
import { isReusable } from '@/engine/projectFile';
import { loadCurrentRef, storeCurrentRef } from '@/engine/refStorage';

interface ProjectFileState {
  /** The file the project is being edited in, or null for an untitled project. */
  ref: ProjectFileRef | null;
  /**
   * The exact project object last written to `ref`.
   *
   * Held to derive "are there unsaved changes" by identity rather than by keeping a
   * flag in sync. Every `projectStore` mutation replaces the project object, so
   * `project !== savedSnapshot` is already an exact answer, with nothing to forget
   * to reset.
   */
  savedSnapshot: Project | null;
  setRef: (ref: ProjectFileRef | null) => void;
  markSaved: (project: Project, ref: ProjectFileRef) => void;
  clear: () => void;
  /** Restore the remembered file on start-up. Does not touch `savedSnapshot`. */
  rehydrate: () => Promise<void>;
}

/**
 * Which file the open project belongs to.
 *
 * Separate from `projectStore` because it is not part of the project: it is not
 * serialised, not undoable, and moving a project to another file changes nothing
 * about the music. Keeping it out means `projectStore`'s undo history does not
 * remember file paths, and the auto-save effect can watch the project alone.
 *
 * Writes to IndexedDB are fire-and-forget so the store itself stays synchronous —
 * see `refStorage.ts`, where every failure is swallowed on purpose.
 */
export const projectFileStore = create<ProjectFileState>(set => ({
  ref: null,
  savedSnapshot: null,

  setRef: ref => {
    set({ ref });
    void storeCurrentRef(ref);
  },

  markSaved: (project, ref) => {
    // A download is not a file the app can go back to, so the project stays
    // untitled — the next save must ask again rather than name a file it cannot
    // reach. The snapshot still counts: those bytes did leave the app.
    const kept = isReusable(ref) ? ref : null;
    set({ ref: kept, savedSnapshot: project });
    void storeCurrentRef(kept);
  },

  clear: () => {
    set({ ref: null, savedSnapshot: null });
    void storeCurrentRef(null);
  },

  rehydrate: async () => {
    const ref = await loadCurrentRef();
    // A file opened in the meantime wins; start-up is slow and the user is not.
    if (ref && !projectFileStore.getState().ref) set({ ref });
  },
}));

/**
 * Whether the open project differs from what is on disk.
 *
 * An untitled project counts as dirty as soon as it exists — it has never been
 * written anywhere, which is exactly the state the dirty marker is for.
 */
export function isProjectDirty(project: Project | null): boolean {
  if (!project) return false;
  return project !== projectFileStore.getState().savedSnapshot;
}
