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
  maxHistory: number = 50,
  shouldRecord: (prev: T, next: T) => boolean = (prev, next) => prev !== next
) {
  const history: T[] = [initialState];
  let pointer = 0;
  let isRecording = false;
  const subscribers: Array<() => void> = [];

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

  let cachedSnapshot: { canUndo: boolean; canRedo: boolean } | null = null;

  function notify() {
    for (const sub of subscribers) sub();
  }

  function getSnapshot(): { canUndo: boolean; canRedo: boolean } {
    const u = pointer > 0;
    const r = pointer < history.length - 1;
    if (cachedSnapshot && cachedSnapshot.canUndo === u && cachedSnapshot.canRedo === r) {
      return cachedSnapshot;
    }
    cachedSnapshot = { canUndo: u, canRedo: r };
    return cachedSnapshot;
  }

  return {
    /** Get the current state (at the active pointer). */
    current: (): T => history[pointer],

    /** Push a new state onto the stack. Clears the redo history. */
    pushState: (state: T) => {
      if (isRecording) return;
      const prev = history[pointer];
      if (!shouldRecord(prev, state)) return;
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
      notify();
      return history[pointer];
    },

    /** Redo to the next state. Throws if at the end. */
    redo: (): T => {
      if (pointer >= history.length - 1) {
        throw new Error('Nothing to redo');
      }
      pointer++;
      notify();
      return history[pointer];
    },

    /** Clear all undo/redo history, keeping only the current state. */
    clearHistory: () => {
      const current = history[pointer];
      history.length = 1;
      history[0] = current;
      pointer = 0;
      notify();
    },

    /** Whether undo is available. */
    canUndo: (): boolean => pointer > 0,

    /** Whether redo is available. */
    canRedo: (): boolean => pointer < history.length - 1,

    /** Cached snapshot for useSyncExternalStore — returns the SAME object
        reference when canUndo/canRedo haven't changed, preventing infinite
        React render loops. */
    getSnapshot: getSnapshot,

    /** Temporarily silence pushState. Callers wrap recording gestures so the
        intermediate key-down state does not become a history entry. */
    setRecording: (active: boolean) => {
      isRecording = active;
    },

    // ---------------------------------------------------------------------------
    // Subscribers — triggered after undo/redo/clear so React can sync.
    // ---------------------------------------------------------------------------
    notify: notify,
    subscribe: (cb: () => void) => {
      subscribers.push(cb);
      return () => {
        const idx = subscribers.indexOf(cb);
        if (idx !== -1) subscribers.splice(idx, 1);
      };
    },
  };
}
