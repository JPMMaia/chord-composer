/**
 * Undo/redo middleware for any serializable state.
 *
 * Usage:
 * ```ts
 * const ur = createUndoRedoMiddleware(initialState, 50);
 * ur.pushState(newState);
 * const prev = ur.undo();
 * const next = ur.redo();
 * ```
 */
export function createUndoRedoMiddleware<T>(
  initialState: T,
  maxHistory: number = 50
) {
  const history: T[] = [initialState];
  let pointer = 0;

  function trimHistory() {
    // Trim from the front if total history exceeds maxHistory
    while (history.length > maxHistory) {
      history.shift();
      // Adjust pointer after shift
      pointer--;
    }
    // Clamp pointer to valid range
    if (pointer < 0) pointer = 0;
    if (pointer >= history.length) pointer = history.length - 1;
  }

  return {
    /** Get the current state (at the active pointer). */
    current: (): T => history[pointer],

    /** Push a new state onto the stack. Clears the redo history. */
    pushState: (state: T) => {
      pointer++;
      // Remove any redo states beyond the pointer
      history.splice(pointer);
      history.push(state);
      trimHistory();
    },

    /** Undo to the previous state. Throws if at the beginning. */
    undo: (): T => {
      if (pointer <= 0) {
        throw new Error('Nothing to undo');
      }
      pointer--;
      return history[pointer];
    },

    /** Redo to the next state. Throws if at the end. */
    redo: (): T => {
      if (pointer >= history.length - 1) {
        throw new Error('Nothing to redo');
      }
      pointer++;
      return history[pointer];
    },

    /** Clear all undo/redo history, keeping only the current state. */
    clearHistory: () => {
      const current = history[pointer];
      history.length = 1;
      history[0] = current;
      pointer = 0;
    },

    /** Whether undo is available. */
    canUndo: (): boolean => pointer > 0,

    /** Whether redo is available. */
    canRedo: (): boolean => pointer < history.length - 1,
  };
}
