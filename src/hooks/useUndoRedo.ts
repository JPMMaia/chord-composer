import { useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
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
    createUndoRedoMiddleware(initialState, maxHistory, shouldRecord)
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

  // Sync canUndo/canRedo with React via useSyncExternalStore.
  // Uses the middleware's cached getSnapshot() to return the SAME reference
  // when canUndo/canRedo haven't changed — preventing infinite render loops.
  const urSnapshot = useSyncExternalStore(
    (cb) => middlewareRef.current.subscribe(cb),
    () => middlewareRef.current.getSnapshot()
  );

  // Bind keyboard shortcuts (Ctrl+Z / Ctrl+Shift+Z / Cmd+Z / Cmd+Shift+Z)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Shift+Z reports e.key as 'Z', so compare case-insensitively.
      const key = e.key.toLowerCase();
      const isUndo =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z';
      const isRedo =
        (e.ctrlKey || e.metaKey) && e.shiftKey && key === 'z';
      const isRedoAlt =
        (e.ctrlKey || e.metaKey) && key === 'y';

      if (isUndo && urSnapshot.canUndo) {
        e.preventDefault();
        undo();
      } else if ((isRedo || isRedoAlt) && urSnapshot.canRedo) {
        e.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [urSnapshot.canUndo, urSnapshot.canRedo, undo, redo]);

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
    canUndo: urSnapshot.canUndo,
    /** Whether redo is available. */
    canRedo: urSnapshot.canRedo,
  };
}
