import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@/types/music';
import {
  autoSaveToLocalStorage,
  clearLocalStorage,
  deserializeProject,
  loadFromFile,
  loadFromLocalStorage,
  serializeForSave,
  serializeProject,
} from '@/engine/fileIO';
import {
  autosaveRef,
  canReadSilently,
  ensureWritable,
  fileLabel,
  pickOpenRef,
  pickSaveRef,
  readRef,
  refExists,
  refModifiedAt,
  removeRef,
  writeRef,
  type ProjectFileRef,
} from '@/engine/projectFile';
import {
  TEMPLATE_FILTER,
  deserializeTemplate,
  serializeTemplate,
  templateFromProject,
} from '@/engine/instrumentTemplate';
import { midiToProject, projectToMidi } from '@/engine/midiExporter';
import { projectToMusicXML } from '@/engine/musicxmlExporter';
import { projectStore } from '@/store/projectStore';
import { projectFileStore } from '@/store/projectFileStore';
import { selectionStore } from '@/store/selectionStore';
import { captureVst3State } from '@/engine/vst3Instrument';

/** How long to wait after the last change before writing an auto-save. */
const AUTO_SAVE_DELAY_MS = 5000;

export type AutoSaveStatus = 'idle' | 'pending' | 'saved' | 'error';

/**
 * Work found in an auto-save that the project file does not have.
 *
 * Offered rather than applied. The auto-save is newer, but "newer" is not the same
 * as "wanted" — the user may have closed the app precisely to throw those changes
 * away, and silently reopening them would make the explicit save meaningless.
 */
export interface RecoveryOffer {
  project: Project;
  savedAt: Date;
}

export interface UseFileIOResult {
  /** Last error raised by a file operation, cleared on the next attempt. */
  error: string | null;
  clearError: () => void;
  /** Auto-save state, for the status indicator in the file menu. */
  autoSaveStatus: AutoSaveStatus;
  lastSavedAt: Date | null;
  /** Name of the file the project is saved in, or null while it is untitled. */
  currentFileName: string | null;
  /** True when the project differs from what was last written. */
  isDirty: boolean;
  /** Write to the current file, asking for one only if there is none. */
  handleSave: () => Promise<void>;
  /** Always ask where to write, and adopt that file as the current one. */
  handleSaveAs: () => Promise<void>;
  /** Open through the shell's own dialog. */
  handleOpen: () => Promise<void>;
  /** Open a `File` from the hidden input, for shells with no dialog. */
  handleLoad: (file: File) => Promise<void>;
  /** Discard the project and start a fresh one. */
  handleNew: () => void;
  handleExportMidi: () => void;
  handleExportMusicXML: () => void;
  handleImportMidi: (file: File) => Promise<void>;
  /** Write the project's instruments — and nothing else — to a template file. */
  handleSaveInstruments: () => Promise<void>;
  /** Append a saved instrument set through the shell's own dialog. */
  handleLoadInstruments: () => Promise<void>;
  /** Append from a `File` off the hidden input, for shells with no dialog. */
  handleLoadInstrumentsFile: (file: File) => Promise<void>;
  /** Unsaved work found on start-up or on open, awaiting a decision. */
  recovery: RecoveryOffer | null;
  acceptRecovery: () => void;
  discardRecovery: () => void;
}

/** Turn an arbitrary thrown value into a message suitable for the UI. */
function toMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Strip characters that are unsafe in a filename. */
function toFilename(name: string, extension: string): string {
  const base = name.trim().replace(/[^a-z0-9-_ ]/gi, '').replace(/\s+/g, '-') || 'project';
  return `${base}.${extension}`;
}

/** Trigger a browser download for generated file contents. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Where the auto-save for a given file lives, and how to clear it.
 *
 * Two destinations, because only one of them is always available. A desktop project
 * gets a sidecar file next to itself, which survives the browser's storage being
 * cleared and is visible to the user. Everything else — an untitled project, or any
 * browser, where a file handle cannot address its own siblings — falls back to
 * localStorage, which is where auto-save has always gone.
 */
async function writeAutoSave(ref: ProjectFileRef | null, project: Project): Promise<void> {
  const sidecar = autosaveRef(ref);
  // Deliberately not `serializeForSave`: an auto-save of a project that would fail
  // validation is still the only copy of that work, and refusing to write it is the
  // one outcome with nothing to recover.
  if (sidecar) await writeRef(sidecar, serializeProject(project));
  else autoSaveToLocalStorage(project);
}

async function clearAutoSave(ref: ProjectFileRef | null): Promise<void> {
  const sidecar = autosaveRef(ref);
  if (sidecar) await removeRef(sidecar);
  else clearLocalStorage();
}

/**
 * Look for unsaved work belonging to a file, and read it back if it is newer.
 *
 * A sidecar older than the project file describes a save that already happened —
 * that is the normal aftermath of a crash-free session, and offering it back would
 * train the user to dismiss the prompt.
 */
async function findRecovery(ref: ProjectFileRef | null): Promise<RecoveryOffer | null> {
  const sidecar = autosaveRef(ref);

  if (sidecar) {
    try {
      if (!(await refExists(sidecar))) return null;
      const [sidecarAt, fileAt] = await Promise.all([
        refModifiedAt(sidecar),
        ref ? refModifiedAt(ref) : Promise.resolve(null),
      ]);
      if (sidecarAt && fileAt && sidecarAt <= fileAt) return null;
      const project = deserializeProject(await readRef(sidecar));
      return { project, savedAt: sidecarAt ?? project.updatedAt };
    } catch {
      // An unreadable sidecar is not worth reporting: nothing has been lost that
      // the user knows about, and the project file itself opened fine.
      return null;
    }
  }

  const stored = loadFromLocalStorage();
  return stored ? { project: stored, savedAt: stored.updatedAt } : null;
}

/**
 * File operations for the current project.
 *
 * Call this once, at the top of the tree, and share the result through
 * `fileIOContext` — it owns the auto-save timer, and a second instance would run a
 * second timer against the same files.
 */
export function useFileIO(): UseFileIOResult {
  const project = projectStore(state => state.project);
  const loadProject = projectStore(state => state.loadProject);
  const resetProject = projectStore(state => state.resetProject);
  const ref = projectFileStore(state => state.ref);
  const savedSnapshot = projectFileStore(state => state.savedSnapshot);

  const [error, setError] = useState<string | null>(null);
  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [recovery, setRecovery] = useState<RecoveryOffer | null>(null);
  // Auto-save waits for the start-up check: writing one before it has run would
  // overwrite the very work the check exists to find.
  const [recoveryChecked, setRecoveryChecked] = useState(false);

  const isDirty = project !== null && project !== savedSnapshot;

  const runAutoSave = useCallback(async () => {
    const current = projectStore.getState().project;
    if (!current) return;
    // Nothing to recover when the file already holds exactly this.
    if (current === projectFileStore.getState().savedSnapshot) {
      setAutoSaveStatus('idle');
      return;
    }
    try {
      // A plugin's preset lives inside the plugin, so it has to be asked for rather
      // than read from the store, or a recovered project would come back on the
      // plugin's defaults instead of what was being worked on.
      const captured = await captureVst3State(current);
      await writeAutoSave(projectFileStore.getState().ref, captured);
      setAutoSaveStatus('saved');
      setLastSavedAt(new Date());
    } catch {
      setAutoSaveStatus('error');
    }
  }, []);

  // Debounced auto-save: every project change restarts the timer.
  useEffect(() => {
    if (!project || !recoveryChecked) return;
    if (project === projectFileStore.getState().savedSnapshot) {
      setAutoSaveStatus('idle');
      return;
    }

    setAutoSaveStatus('pending');
    const timer = setTimeout(() => void runAutoSave(), AUTO_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [project, recoveryChecked, savedSnapshot, runAutoSave]);

  // Closing the window inside the debounce window would otherwise lose the last few
  // seconds of work. Only the localStorage write is guaranteed to finish here — a
  // sidecar write is a round trip to the native side, which the shell may not wait
  // for — so this is a best-effort flush, not a substitute for the timer above.
  useEffect(() => {
    const flush = () => {
      const current = projectStore.getState().project;
      if (!current || current === projectFileStore.getState().savedSnapshot) return;
      void writeAutoSave(projectFileStore.getState().ref, current);
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  /**
   * Write the project, to `chosen` if given and otherwise to the file it already
   * has. Returns false when the user cancelled or the write failed.
   */
  const saveTo = useCallback(async (chosen: ProjectFileRef | null): Promise<boolean> => {
    const current = projectStore.getState().project;
    if (!current) return false;
    setError(null);

    try {
      const captured = await captureVst3State(current);

      let target = chosen;
      if (!target) {
        const existing = projectFileStore.getState().ref;
        // A handle restored from a previous session has no permission yet, and the
        // re-grant prompt only opens from the gesture that got us here.
        target = existing && (await ensureWritable(existing)) ? existing : null;
      }
      if (!target) {
        target = await pickSaveRef(toFilename(captured.name, 'json'));
        if (!target) return false; // Cancelled — not an error, and nothing written.
      }

      await writeRef(target, serializeForSave(captured));
      projectFileStore.getState().markSaved(current, target);
      // The explicit save is now the newer truth; a stale auto-save must not
      // outlive it and offer itself back on the next launch.
      await clearAutoSave(target);
      setAutoSaveStatus('idle');
      setRecovery(null);
      return true;
    } catch (err) {
      setError(toMessage(err, 'Failed to save the project.'));
      return false;
    }
  }, []);

  const handleSave = useCallback(async () => {
    await saveTo(null);
  }, [saveTo]);

  const handleSaveAs = useCallback(async () => {
    const current = projectStore.getState().project;
    if (!current) return;
    const target = await pickSaveRef(toFilename(current.name, 'json'));
    if (!target) return;
    await saveTo(target);
  }, [saveTo]);

  /** Apply a project that has just been read, and adopt the file it came from. */
  const adopt = useCallback(
    (loaded: Project, from: ProjectFileRef | null) => {
      loadProject(loaded);
      // `loadProject` normalises what it is given, so the object now in the store is
      // not the one passed in — and it is that object the dirty check compares.
      const stored = projectStore.getState().project;
      if (from && stored) projectFileStore.getState().markSaved(stored, from);
      else projectFileStore.getState().clear();
    },
    [loadProject]
  );

  /**
   * Reopen the file the last session was working in.
   *
   * Remembering the file was only ever half of "carry on where I left off": the ref
   * alone made the title bar name a project whose notes were nowhere on screen,
   * because the app's start-up effect had already built an empty piece and nothing
   * ever read the file back.
   *
   * A file that has since been deleted or moved is forgotten rather than reported —
   * on start-up there is nothing the user did to fail, and keeping the ref would
   * leave the UI naming a file that quick-save cannot reach.
   */
  const reopenRemembered = useCallback(async (): Promise<void> => {
    const ref = projectFileStore.getState().ref;
    if (!ref) return;
    try {
      if (!(await canReadSilently(ref))) {
        // A missing path is gone for good; a handle is only waiting for permission,
        // which the next save asks for, so that one is worth keeping.
        if (ref.kind === 'path') projectFileStore.getState().clear();
        return;
      }
      adopt(deserializeProject(await readRef(ref)), ref);
    } catch {
      projectFileStore.getState().clear();
    }
  }, [adopt]);

  // Restore the remembered file, read it back, and look for unsaved work — once, on
  // mount. Auto-save stays parked until this finishes (`recoveryChecked`), so the
  // empty project the app starts with can never be written over the real one.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await projectFileStore.getState().rehydrate();
      if (cancelled) return;
      await reopenRemembered();
      const found = await findRecovery(projectFileStore.getState().ref);
      if (cancelled) return;
      setRecovery(found);
      setRecoveryChecked(true);
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only: reopening again on a later render would throw away live edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpen = useCallback(async () => {
    setError(null);
    try {
      const target = await pickOpenRef();
      if (!target) return;
      adopt(deserializeProject(await readRef(target)), target);
      setRecovery(await findRecovery(target));
    } catch (err) {
      setError(toMessage(err, 'Failed to open the project file.'));
    }
  }, [adopt]);

  const handleLoad = useCallback(
    async (file: File) => {
      setError(null);
      try {
        // A `File` from an input is a snapshot, not a reference — there is nothing
        // to write back to, so the project opens untitled and the first save asks.
        adopt(await loadFromFile(file), null);
      } catch (err) {
        setError(toMessage(err, 'Failed to load the project file.'));
      }
    },
    [adopt]
  );

  const handleNew = useCallback(() => {
    setError(null);
    setRecovery(null);
    // `resetProject` leaves the project null; the app's own start-up effect builds
    // the empty piece, so a new project here is the same one as on first launch.
    resetProject();
    projectFileStore.getState().clear();
  }, [resetProject]);

  const handleExportMidi = useCallback(() => {
    if (!project) return;
    setError(null);
    try {
      const bytes = projectToMidi(project);
      downloadBlob(new Blob([bytes], { type: 'audio/midi' }), toFilename(project.name, 'mid'));
    } catch (err) {
      setError(toMessage(err, 'Failed to export MIDI.'));
    }
  }, [project]);

  const handleExportMusicXML = useCallback(() => {
    if (!project) return;
    setError(null);
    try {
      const xml = projectToMusicXML(project);
      downloadBlob(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }), toFilename(project.name, 'musicxml'));
    } catch (err) {
      setError(toMessage(err, 'Failed to export MusicXML.'));
    }
  }, [project]);

  const handleImportMidi = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        adopt(midiToProject(bytes), null);
      } catch (err) {
        setError(toMessage(err, 'Failed to import the MIDI file.'));
      }
    },
    [adopt]
  );

  /**
   * Write the instruments out on their own.
   *
   * Deliberately not a project save: no `markSaved`, no auto-save state, no clearing
   * of the sidecar. Writing a template says nothing about the project's own file, and
   * a project with unsaved work must stay exactly as dirty as it was.
   */
  const handleSaveInstruments = useCallback(async () => {
    const current = projectStore.getState().project;
    if (!current) return;
    setError(null);
    try {
      // A plugin's preset lives inside the plugin, so it has to be asked for; the
      // store's copy is only as fresh as the last save.
      const captured = await captureVst3State(current);
      const target = await pickSaveRef(
        toFilename(`${current.name} Instruments`, 'cctemplate'),
        TEMPLATE_FILTER
      );
      if (!target) return; // Cancelled — not an error, and nothing written.
      await writeRef(target, serializeTemplate(templateFromProject(captured, current.name)));
    } catch (err) {
      setError(toMessage(err, 'Failed to save the instruments.'));
    }
  }, []);

  /** Append a template's instruments and select the first of them. */
  const applyTemplate = useCallback((json: string) => {
    const template = deserializeTemplate(json);
    const firstId = projectStore.getState().appendInstruments(template.instruments);
    if (firstId) selectionStore.getState().selectTrack(firstId);
  }, []);

  const handleLoadInstruments = useCallback(async () => {
    setError(null);
    try {
      const target = await pickOpenRef(TEMPLATE_FILTER);
      if (!target) return;
      applyTemplate(await readRef(target));
    } catch (err) {
      setError(toMessage(err, 'Failed to load the instruments file.'));
    }
  }, [applyTemplate]);

  const handleLoadInstrumentsFile = useCallback(
    async (file: File) => {
      setError(null);
      try {
        applyTemplate(await file.text());
      } catch (err) {
        setError(toMessage(err, 'Failed to load the instruments file.'));
      }
    },
    [applyTemplate]
  );

  const acceptRecovery = useCallback(() => {
    if (!recovery) return;
    // The file itself is unchanged, so the project stays dirty against it — which
    // is true, and means the next Ctrl+S writes the recovered work back.
    loadProject(recovery.project);
    setRecovery(null);
  }, [recovery, loadProject]);

  const discardRecovery = useCallback(() => {
    void clearAutoSave(projectFileStore.getState().ref);
    setRecovery(null);
  }, []);

  return {
    error,
    clearError,
    autoSaveStatus,
    lastSavedAt,
    currentFileName: ref ? fileLabel(ref) : null,
    isDirty,
    handleSave,
    handleSaveAs,
    handleOpen,
    handleLoad,
    handleNew,
    handleExportMidi,
    handleExportMusicXML,
    handleImportMidi,
    handleSaveInstruments,
    handleLoadInstruments,
    handleLoadInstrumentsFile,
    recovery,
    acceptRecovery,
    discardRecovery,
  };
}
