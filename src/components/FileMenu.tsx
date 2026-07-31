import React, { useRef, useState } from 'react';
import { useFileIO, type AutoSaveStatus } from '@/hooks/useFileIO';

const AUTO_SAVE_LABELS: Record<AutoSaveStatus, string> = {
  idle: 'Not saved yet',
  pending: 'Saving…',
  saved: 'Auto-saved',
  error: 'Auto-save failed',
};

const AUTO_SAVE_COLORS: Record<AutoSaveStatus, string> = {
  idle: 'text-gray-500',
  pending: 'text-yellow-500',
  saved: 'text-green-500',
  error: 'text-red-500',
};

/**
 * File menu: save/load the project as JSON, export MIDI and MusicXML, import
 * MIDI, plus an auto-save status indicator.
 */
export const FileMenu: React.FC = () => {
  const {
    error,
    clearError,
    autoSaveStatus,
    lastSavedAt,
    handleSave,
    handleLoad,
    handleExportMidi,
    handleExportMusicXML,
    handleImportMidi,
  } = useFileIO();

  const [isOpen, setIsOpen] = useState(false);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const midiInputRef = useRef<HTMLInputElement>(null);

  const runAndClose = (action: () => void | Promise<void>) => () => {
    setIsOpen(false);
    void action();
  };

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
          className="absolute top-full left-0 z-10 mt-1 w-56 py-1 bg-gray-800 border border-gray-700 rounded shadow-lg"
        >
          <li role="none">
            <button role="menuitem" onClick={runAndClose(handleSave)} className="w-full px-3 py-1.5 text-sm text-left text-gray-200 hover:bg-gray-700">
              Save Project
            </button>
          </li>
          <li role="none">
            <button role="menuitem" onClick={runAndClose(() => projectInputRef.current?.click())} className="w-full px-3 py-1.5 text-sm text-left text-gray-200 hover:bg-gray-700">
              Load Project…
            </button>
          </li>
          <li role="none" className="my-1 border-t border-gray-700" />
          <li role="none">
            <button role="menuitem" onClick={runAndClose(handleExportMidi)} className="w-full px-3 py-1.5 text-sm text-left text-gray-200 hover:bg-gray-700">
              Export MIDI
            </button>
          </li>
          <li role="none">
            <button role="menuitem" onClick={runAndClose(handleExportMusicXML)} className="w-full px-3 py-1.5 text-sm text-left text-gray-200 hover:bg-gray-700">
              Export MusicXML
            </button>
          </li>
          <li role="none">
            <button role="menuitem" onClick={runAndClose(() => midiInputRef.current?.click())} className="w-full px-3 py-1.5 text-sm text-left text-gray-200 hover:bg-gray-700">
              Import MIDI…
            </button>
          </li>
        </ul>
      )}

      <span className={`text-xs ${AUTO_SAVE_COLORS[autoSaveStatus]}`} data-testid="autosave-status">
        {AUTO_SAVE_LABELS[autoSaveStatus]}
        {autoSaveStatus === 'saved' && lastSavedAt
          ? ` ${lastSavedAt.toLocaleTimeString()}`
          : ''}
      </span>

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
