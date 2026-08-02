import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '@/types/music';
import {
  autoSaveToLocalStorage,
  loadFromFile,
  loadFromLocalStorage,
  saveToFile,
} from '@/engine/fileIO';
import { midiToProject, projectToMidi } from '@/engine/midiExporter';
import { projectToMusicXML } from '@/engine/musicxmlExporter';
import { projectStore } from '@/store/projectStore';
import { captureVst3State } from '@/engine/vst3Instrument';

/** How long to wait after the last change before writing an auto-save. */
const AUTO_SAVE_DELAY_MS = 5000;

export type AutoSaveStatus = 'idle' | 'pending' | 'saved' | 'error';

export interface UseFileIOResult {
  /** Last error raised by a file operation, cleared on the next attempt. */
  error: string | null;
  clearError: () => void;
  /** Auto-save state, for the status indicator in the file menu. */
  autoSaveStatus: AutoSaveStatus;
  lastSavedAt: Date | null;
  handleSave: () => Promise<void>;
  handleLoad: (file: File) => Promise<void>;
  handleExportMidi: () => void;
  handleExportMusicXML: () => void;
  handleImportMidi: (file: File) => Promise<void>;
  /** Restore the most recent auto-save; returns false when there is none. */
  restoreAutoSave: () => boolean;
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
 * File operations for the current project: save/load JSON, MIDI and MusicXML
 * export, MIDI import, and debounced auto-save to localStorage.
 */
export function useFileIO(): UseFileIOResult {
  const project = projectStore(state => state.project);
  const loadProject = projectStore(state => state.loadProject);

  const [error, setError] = useState<string | null>(null);
  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced auto-save: every project change restarts the timer.
  useEffect(() => {
    if (!project) return;

    setAutoSaveStatus('pending');
    timeoutRef.current = setTimeout(() => {
      // Plugin state too, or a restored auto-save would come back on the
      // plugin's defaults rather than what was being worked on.
      captureVst3State(project)
        .then(withState => {
          autoSaveToLocalStorage(withState);
          setAutoSaveStatus('saved');
          setLastSavedAt(new Date());
        })
        .catch(() => setAutoSaveStatus('error'));
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [project]);

  const clearError = useCallback(() => setError(null), []);

  /**
   * Apply a loaded project. Instruments ride along inside it, so this is now just
   * `loadProject` — it stays as a named seam because three callers share it.
   */
  const applyProject = useCallback(
    (loaded: Project) => {
      loadProject(loaded);
    },
    [loadProject]
  );

  const handleSave = useCallback(async () => {
    if (!project) return;
    setError(null);
    try {
      // A plugin's preset lives inside the plugin, so it has to be asked for
      // rather than read from the store.
      await saveToFile(await captureVst3State(project), toFilename(project.name, 'json'));
    } catch (err) {
      setError(toMessage(err, 'Failed to save the project.'));
    }
  }, [project]);

  const handleLoad = useCallback(
    async (file: File) => {
      setError(null);
      try {
        applyProject(await loadFromFile(file));
      } catch (err) {
        setError(toMessage(err, 'Failed to load the project file.'));
      }
    },
    [applyProject]
  );

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
        applyProject(midiToProject(bytes));
      } catch (err) {
        setError(toMessage(err, 'Failed to import the MIDI file.'));
      }
    },
    [applyProject]
  );

  const restoreAutoSave = useCallback((): boolean => {
    const saved = loadFromLocalStorage();
    if (!saved) return false;
    applyProject(saved);
    return true;
  }, [applyProject]);

  return {
    error,
    clearError,
    autoSaveStatus,
    lastSavedAt,
    handleSave,
    handleLoad,
    handleExportMidi,
    handleExportMusicXML,
    handleImportMidi,
    restoreAutoSave,
  };
}
