import { useEffect, useRef } from 'react';
import type { UseFileIOResult } from '@/hooks/useFileIO';
import { canPickFiles } from '@/engine/projectFile';
import { isTextEntry } from '@/utils/keyboard';

/**
 * The file keys.
 *
 * | Key | |
 * | --- | --- |
 * | `Ctrl/⌘+S` | save to the current file, asking only if there is none |
 * | `Ctrl/⌘+Shift+S` | save as — always asks |
 * | `Ctrl/⌘+O` | open |
 *
 * All three take the event, because the browser has its own ideas about every one
 * of them: `Ctrl+S` saves the page, `Ctrl+O` opens a local file into the tab. In
 * the desktop build there is nothing to steal them from.
 *
 * No collisions with the other window-level shortcuts: `Ctrl+A` belongs to
 * `useSegmentShortcuts`, `Ctrl+C`/`V` to `useSegmentCopyPaste`, `Ctrl+Z`/`Y` to the
 * undo handler in `App`, and every bare-key hook already bails on a modifier.
 *
 * The handlers are read through a ref so the listener binds once: `handleSave` and
 * friends change identity whenever the project does, and re-binding on every edit
 * would be a listener churn for nothing.
 */
export function useFileShortcuts(fileIO: UseFileIOResult): void {
  const latest = useRef(fileIO);
  latest.current = fileIO;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      // Leave a name field its own Ctrl+S; the browser will do nothing with it.
      if (isTextEntry(e.target)) return;

      // Shift+S reports `e.key` as 'S', so compare case-insensitively.
      const key = e.key.toLowerCase();
      if (key !== 's' && key !== 'o') return;
      // A shell with no Open dialog can only open through the hidden file input in
      // the File menu, which a keypress cannot reach. Leave the key to the browser
      // rather than swallowing it into nothing.
      if (key === 'o' && !canPickFiles()) return;

      e.preventDefault();
      if (key === 'o') void latest.current.handleOpen();
      else if (e.shiftKey) void latest.current.handleSaveAs();
      else void latest.current.handleSave();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
