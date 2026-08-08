import React, { useRef, useState } from 'react';
import { useFileIOState } from '@/context/fileIOContext';
import type { AutoSaveStatus } from '@/hooks/useFileIO';
import { canPickFiles, canQuickSave } from '@/engine/projectFile';

const AUTO_SAVE_LABELS: Record<AutoSaveStatus, string> = {
  idle: 'Up to date',
  pending: 'Unsaved changes',
  saved: 'Auto-saved',
  error: 'Auto-save failed',
};

const AUTO_SAVE_COLORS: Record<AutoSaveStatus, string> = {
  idle: 'text-gray-500',
  pending: 'text-yellow-500',
  saved: 'text-green-500',
  error: 'text-red-500',
};

/** ⌘ on a Mac, Ctrl everywhere else — the label has to match the key that works. */
const MOD = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform)
  ? '⌘'
  : 'Ctrl';

const ITEM_CLASS =
  'flex w-full items-center justify-between gap-6 px-3 py-1.5 text-sm text-left text-gray-200 hover:bg-gray-700';

/**
 * File menu: new/open/save the project, export MIDI and MusicXML, import MIDI,
 * plus the current file name and the auto-save indicator.
 */
export const FileMenu: React.FC = () => {
  const {
    error,
    clearError,
    autoSaveStatus,
    lastSavedAt,
    currentFileName,
    isDirty,
    handleSave,
    handleSaveAs,
    handleOpen,
    handleLoad,
    handleNew,
    handleExportMidi,
    handleExportMusicXML,
    handleImportMidi,
    recovery,
    acceptRecovery,
    discardRecovery,
  } = useFileIOState();

  const [isOpen, setIsOpen] = useState(false);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const midiInputRef = useRef<HTMLInputElement>(null);

  const runAndClose = (action: () => void | Promise<void>) => () => {
    setIsOpen(false);
    void action();
  };

  // Shells without an Open dialog fall back to the hidden input, which yields a
  // File to read but no file to write back to.
  const openProject = canPickFiles() ? handleOpen : () => projectInputRef.current?.click();

  const onProjectPicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so picking the same file twice still fires a change event.
    event.target.value = '';
    if (file) await handleLoad(file);
  };

  const onMidiPicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await handleImportMidi(file);
  };

  return (
    <div className="relative flex items-center gap-3" data-testid="file-menu">
      <button
        onClick={() => setIsOpen(open => !open)}
        className="px-3 py-1.5 text-sm bg-gray-600 text-gray-200 rounded hover:bg-gray-500 transition-colors"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        File
      </button>

      {isOpen && (
        <ul
          role="menu"
          className="absolute top-full left-0 z-10 mt-1 w-64 py-1 bg-gray-800 border border-gray-700 rounded shadow-lg"
        >
          <li role="none">
            <button role="menuitem" onClick={runAndClose(handleNew)} className={ITEM_CLASS}>
              New Project
            </button>
          </li>
          <li role="none">
            <button
              role="menuitem"
              aria-label="Open Project"
              onClick={runAndClose(openProject)}
              className={ITEM_CLASS}
            >
              Open Project…
              {canPickFiles() && <span className="text-xs text-gray-500">{MOD}+O</span>}
            </button>
          </li>
          <li role="none" className="my-1 border-t border-gray-700" />
          <li role="none">
            <button
              role="menuitem"
              // The shortcut hint is part of the label otherwise, which makes
              // "Save" and "Save As" hard to tell apart by name.
              aria-label="Save"
              onClick={runAndClose(handleSave)}
              className={ITEM_CLASS}
              title={
                canQuickSave()
                  ? 'Write to the current file'
                  : 'This browser cannot write back to a file, so every save downloads a new copy.'
              }
            >
              Save
              <span className="text-xs text-gray-500">{MOD}+S</span>
            </button>
          </li>
          <li role="none">
            <button
              role="menuitem"
              aria-label="Save As"
              onClick={runAndClose(handleSaveAs)}
              className={ITEM_CLASS}
            >
              Save As…
              <span className="text-xs text-gray-500">{MOD}+Shift+S</span>
            </button>
          </li>
          <li role="none" className="my-1 border-t border-gray-700" />
          <li role="none">
            <button role="menuitem" onClick={runAndClose(handleExportMidi)} className={ITEM_CLASS}>
              Export MIDI
            </button>
          </li>
          <li role="none">
            <button role="menuitem" onClick={runAndClose(handleExportMusicXML)} className={ITEM_CLASS}>
              Export MusicXML
            </button>
          </li>
          <li role="none">
            <button role="menuitem" onClick={runAndClose(() => midiInputRef.current?.click())} className={ITEM_CLASS}>
              Import MIDI…
            </button>
          </li>
        </ul>
      )}

      <span className="text-sm text-gray-300" data-testid="current-file">
        {currentFileName ?? 'Untitled'}
        {isDirty && (
          <span className="ml-1 text-yellow-500" title="Unsaved changes" aria-label="Unsaved changes">
            •
          </span>
        )}
      </span>

      <span className={`text-xs ${AUTO_SAVE_COLORS[autoSaveStatus]}`} data-testid="autosave-status">
        {AUTO_SAVE_LABELS[autoSaveStatus]}
        {autoSaveStatus === 'saved' && lastSavedAt
          ? ` ${lastSavedAt.toLocaleTimeString()}`
          : ''}
      </span>

      {recovery && (
        <span
          role="alert"
          className="flex items-center gap-2 text-xs text-yellow-300"
          data-testid="recovery-offer"
        >
          Unsaved work from {recovery.savedAt.toLocaleString()} was found.
          <button onClick={acceptRecovery} className="underline">
            Restore
          </button>
          <button onClick={discardRecovery} className="underline">
            Discard
          </button>
        </span>
      )}

      {error && (
        <span role="alert" className="flex items-center gap-2 text-xs text-red-400">
          {error}
          <button onClick={clearError} className="underline" aria-label="Dismiss error">
            Dismiss
          </button>
        </span>
      )}

      <input
        ref={projectInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onProjectPicked}
        data-testid="project-file-input"
      />
      <input
        ref={midiInputRef}
        type="file"
        accept="audio/midi,.mid,.midi"
        className="hidden"
        onChange={onMidiPicked}
        data-testid="midi-file-input"
      />
    </div>
  );
};
