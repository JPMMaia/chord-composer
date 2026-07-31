import { useEffect, useCallback, useRef } from 'react';
import { createUndoRedoMiddleware } from '@/engine/undoRedo';

interface UseUndoRedoOptions<T> {
  /** Initial state to seed the history. */
  initialState: T;
  /** Maximum number of history entries (default: 50). */
  maxHistory?: number;
  /** Called before each undo/redo to decide if the state change should be recorded. */
  shouldRecord?: (prev: T, next: T) => boolean;
}

/**
 * React hook that provides undo/redo for any serializable state.
 *
 * Usage:
 * ```ts
 * const { state, pushState, undo, redo, canUndo, canRedo } = useUndoRedo({
 *   initialState: myInitialState,
 * });
 *
 * // Push a new state (e.g. after a user action)
 * pushState(newState);
 *
 * // Keyboard shortcuts are automatically bound
 * ```
 */
export function useUndoRedo<T extends object>({
  initialState,
  maxHistory = 50,
  shouldRecord = () => true,
}: UseUndoRedoOptions<T>) {
  const middlewareRef = useRef(
    createUndoRedoMiddleware(initialState, maxHistory)
  );

  const current = middlewareRef.current.current();

  /** Push a new state onto the history stack. */
  const pushState = useCallback(
    (nextState: T) => {
      const prev = middlewareRef.current.current();
      if (shouldRecord(prev, nextState)) {
        middlewareRef.current.pushState(nextState);
      }
    },
    [shouldRecord]
  );

  /** Undo to the previous state. Returns the new state or null if nothing to undo. */
  const undo = useCallback((): T | null => {
    try {
      return middlewareRef.current.undo();
    } catch {
      return null;
    }
  }, []);

  /** Redo to the next state. Returns the new state or null if nothing to redo. */
  const redo = useCallback((): T | null => {
    try {
      return middlewareRef.current.redo();
    } catch {
      return null;
    }
  }, []);

  /** Clear the undo/redo history. */
  const clearHistory = useCallback(() => {
    middlewareRef.current.clearHistory();
  }, []);

  const canUndo = middlewareRef.current.canUndo();
  const canRedo = middlewareRef.current.canRedo();

  // Bind keyboard shortcuts (Ctrl+Z / Ctrl+Shift+Z / Cmd+Z / Cmd+Shift+Z)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isUndo =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z';
      const isRedo =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z';
      const isRedoAlt =
        (e.ctrlKey || e.metaKey) && e.key === 'y';

      if (isUndo && canUndo) {
        e.preventDefault();
        undo();
      } else if ((isRedo || isRedoAlt) && canRedo) {
        e.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canUndo, canRedo, undo, redo]);

  return {
    /** The current state from the undo/redo history. */
    state: current,
    /** Push a new state. */
    pushState,
    /** Undo one step. */
    undo,
    /** Redo one step. */
    redo,
    /** Clear history. */
    clearHistory,
    /** Whether undo is available. */
    canUndo,
    /** Whether redo is available. */
    canRedo,
  };
}
