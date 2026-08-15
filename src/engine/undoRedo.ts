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

  // ---------------------------------------------------------------------------
  // Record pass — a whole recording take is ONE history entry.
  //
  // While a pass is open nothing enters `history`; pushState just remembers the
  // latest state. Ending the pass pushes it as a single entry, and aborting the
  // pass throws it away and hands back the state the pass started from. History
  // and pointer are never touched during a pass, so the redo tail survives an
  // abort and the next undo steps over the edit made *before* recording began.
  // ---------------------------------------------------------------------------
  let passActive = false;
  let passBaseline: T = initialState;
  /** undefined = nothing has been written this pass. */
  let passLatest: T | undefined;

  function hasPassChanges(): boolean {
    return passActive && passLatest !== undefined && !Object.is(passLatest, passBaseline);
  }

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

  function pushState(state: T) {
    // A dirty pass is held outside history until it ends — see above.
    if (passActive) {
      const wasDirty = hasPassChanges();
      passLatest = state;
      // Only on the clean → dirty edge, so the Transport's undo button lights up
      // once per pass rather than on every recorded note.
      if (!wasDirty && hasPassChanges()) notify();
      return;
    }
    if (isRecording) return;
    const prev = history[pointer];
    if (!shouldRecord(prev, state)) return;
    pointer++;
    // Remove any redo states beyond the pointer
    history.splice(pointer);
    history.push(state);
    trimHistory();
  }

  /** After history navigation, an open pass must start over from where the
      pointer now sits — otherwise a later abort would resurrect a project the
      user has already undone away from. */
  function rebaselinePass() {
    if (!passActive) return;
    passBaseline = history[pointer];
    passLatest = undefined;
  }

  function getSnapshot(): { canUndo: boolean; canRedo: boolean } {
    const u = pointer > 0 || hasPassChanges();
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
    pushState,

    /** Undo to the previous state. Throws if at the beginning. */
    undo: (): T => {
      if (pointer <= 0) {
        throw new Error('Nothing to undo');
      }
      pointer--;
      rebaselinePass();
      notify();
      return history[pointer];
    },

    /** Redo to the next state. Throws if at the end. */
    redo: (): T => {
      if (pointer >= history.length - 1) {
        throw new Error('Nothing to redo');
      }
      pointer++;
      rebaselinePass();
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

    /** Whether undo is available. A dirty record pass counts: undoing it erases
        the take, even when there is no history entry behind it. */
    canUndo: (): boolean => pointer > 0 || hasPassChanges(),

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
    // Record pass — see the notes at the top of the closure.
    // ---------------------------------------------------------------------------

    /** Open a pass. Everything pushed until it ends collapses into one entry. */
    beginPass: (baseline: T) => {
      passActive = true;
      passBaseline = baseline;
      passLatest = undefined;
      notify();
    },

    /** Throw the pass away and hand back the state it started from. The pass
        stays OPEN — the user is still rolling and can immediately retake. */
    abortPass: (): T => {
      passLatest = undefined;
      notify();
      return passBaseline;
    },

    /** Close the pass, committing everything it wrote as a single entry. A pass
        that wrote nothing, or that ended back at its baseline, adds no entry —
        `shouldRecord` compares against the baseline, which is still `current()`. */
    endPass: (final?: T) => {
      passActive = false;
      const state = final ?? passLatest;
      passLatest = undefined;
      if (state !== undefined) pushState(state);
      notify();
    },

    /** Whether a pass is open. */
    isPassActive: (): boolean => passActive,

    /** Whether an open pass has written anything worth erasing. */
    hasPassChanges,

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

/** The middleware instance, named so hooks and tests can type it directly. */
export type UndoRedoMiddleware<T> = ReturnType<typeof createUndoRedoMiddleware<T>>;
