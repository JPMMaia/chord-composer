import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createUndoRedoMiddleware } from '@/engine/undoRedo';

describe('undoRedo', () => {
  const initialState = { value: 0 };
  let undoRedo: ReturnType<typeof createUndoRedoMiddleware<{ value: number }>>;

  beforeEach(() => {
    undoRedo = createUndoRedoMiddleware(initialState, 10);
  });

  describe('pushState', () => {
    it('pushes the initial state', () => {
      expect(() => undoRedo.pushState({ value: 1 })).not.toThrow();
    });

    it('records state changes', () => {
      undoRedo.pushState({ value: 1 });
      undoRedo.pushState({ value: 2 });
      undoRedo.pushState({ value: 3 });
      expect(undoRedo.current()).toEqual({ value: 3 });
    });

    it('clears redo stack when new state is pushed after undo', () => {
      undoRedo.pushState({ value: 1 });
      undoRedo.pushState({ value: 2 });
      undoRedo.undo();
      undoRedo.pushState({ value: 99 });
      expect(undoRedo.current()).toEqual({ value: 99 });
      // Redo should be empty after new push
      expect(() => undoRedo.redo()).toThrow();
    });
  });

  describe('undo', () => {
    it('returns to previous state', () => {
      undoRedo.pushState({ value: 1 });
      undoRedo.pushState({ value: 2 });
      const result = undoRedo.undo();
      expect(result).toEqual({ value: 1 });
      expect(undoRedo.current()).toEqual({ value: 1 });
    });

    it('throws when there is nothing to undo', () => {
      expect(() => undoRedo.undo()).toThrow('Nothing to undo');
    });

    it('can undo multiple levels', () => {
      undoRedo.pushState({ value: 1 });
      undoRedo.pushState({ value: 2 });
      undoRedo.pushState({ value: 3 });
      undoRedo.undo();
      undoRedo.undo();
      expect(undoRedo.current()).toEqual({ value: 1 });
    });
  });

  describe('redo', () => {
    it('returns to undone state', () => {
      undoRedo.pushState({ value: 1 });
      undoRedo.pushState({ value: 2 });
      undoRedo.undo();
      const result = undoRedo.redo();
      expect(result).toEqual({ value: 2 });
      expect(undoRedo.current()).toEqual({ value: 2 });
    });

    it('throws when there is nothing to redo', () => {
      expect(() => undoRedo.redo()).toThrow('Nothing to redo');
    });

    it('can redo multiple levels', () => {
      undoRedo.pushState({ value: 1 });
      undoRedo.pushState({ value: 2 });
      undoRedo.pushState({ value: 3 });
      undoRedo.undo();
      undoRedo.undo();
      undoRedo.redo();
      undoRedo.redo();
      expect(undoRedo.current()).toEqual({ value: 3 });
    });
  });

  describe('clearHistory', () => {
    it('clears undo and redo stacks', () => {
      undoRedo.pushState({ value: 1 });
      undoRedo.pushState({ value: 2 });
      undoRedo.clearHistory();
      expect(() => undoRedo.undo()).toThrow();
      expect(() => undoRedo.redo()).toThrow();
    });

    it('preserves current state after clear', () => {
      undoRedo.pushState({ value: 42 });
      undoRedo.clearHistory();
      expect(undoRedo.current()).toEqual({ value: 42 });
    });
  });

  describe('maxHistorySize', () => {
    it('trims oldest entries when history exceeds max', () => {
      const small = createUndoRedoMiddleware({ value: 0 }, 3);
      small.pushState({ value: 1 });
      small.pushState({ value: 2 });
      small.pushState({ value: 3 });
      small.pushState({ value: 4 });
      // Should have trimmed the oldest, so undo goes to 3, not 1
      small.undo();
      expect(small.current()).toEqual({ value: 3 });
    });

    it('respects maxHistorySize of 1 (only current state)', () => {
      const tiny = createUndoRedoMiddleware({ value: 0 }, 1);
      tiny.pushState({ value: 1 });
      tiny.pushState({ value: 2 });
      expect(() => tiny.undo()).toThrow();
    });
  });

  describe('current', () => {
    it('returns the current state', () => {
      undoRedo.pushState({ value: 42 });
      expect(undoRedo.current()).toEqual({ value: 42 });
    });

    it('returns initial state before any push', () => {
      expect(undoRedo.current()).toEqual(initialState);
    });
  });

  describe('null initial state', () => {
    it('handles null as the initial state', () => {
      const ur = createUndoRedoMiddleware(null, 50);
      expect(ur.current()).toBeNull();
      expect(ur.canUndo()).toBe(false);
      expect(ur.canRedo()).toBe(false);
    });

    it('pushes first real state when seeded from null', () => {
      const ur = createUndoRedoMiddleware<{ value: number } | null>(null, 50);
      expect(ur.current()).toBeNull();
      ur.pushState({ value: 1 });
      expect(ur.current()).toEqual({ value: 1 });
      // undo is now available because the null initial state is one step back
      expect(ur.canUndo()).toBe(true);
    });

    it('can undo from a null-seeded history', () => {
      const ur = createUndoRedoMiddleware<{ value: number } | null>(null, 50);
      ur.pushState({ value: 1 });
      ur.pushState({ value: 2 });
      expect(ur.current()).toEqual({ value: 2 });
      expect(ur.undo()).toEqual({ value: 1 });
      expect(ur.undo()).toBeNull();
    });

    it('silences pushState during recording', () => {
      const ur = createUndoRedoMiddleware({ value: 0 }, 50);
      ur.setRecording(true);
      ur.pushState({ value: 1 });
      ur.pushState({ value: 2 });
      ur.setRecording(false);
      // Recording should have silenced pushes
      expect(ur.current()).toEqual({ value: 0 });
      expect(ur.canUndo()).toBe(false);
    });

    it('resumes pushState after recording ends', () => {
      const ur = createUndoRedoMiddleware({ value: 0 }, 50);
      ur.setRecording(true);
      ur.pushState({ value: 1 }); // silenced
      ur.setRecording(false);
      ur.pushState({ value: 2 }); // active
      expect(ur.current()).toEqual({ value: 2 });
      expect(ur.canUndo()).toBe(true);
    });
  });

  describe('record pass', () => {
    // A pass models one recording take: armed + rolling. Everything written
    // between beginPass and endPass is a single undo step, and abortPass erases
    // the whole take without disturbing history.
    let ur: ReturnType<typeof createUndoRedoMiddleware<{ value: number }>>;
    const baseline = { value: 0 };

    beforeEach(() => {
      ur = createUndoRedoMiddleware(baseline, 50);
    });

    it('collapses every push in the pass into one entry', () => {
      ur.beginPass(baseline);
      ur.pushState({ value: 1 });
      ur.pushState({ value: 2 });
      ur.pushState({ value: 3 });
      // Nothing lands while the pass is open.
      expect(ur.current()).toEqual(baseline);
      ur.endPass();
      expect(ur.current()).toEqual({ value: 3 });
      expect(ur.undo()).toEqual(baseline);
      expect(ur.canUndo()).toBe(false);
    });

    it('adds no entry for a pass that wrote nothing', () => {
      ur.beginPass(baseline);
      ur.endPass();
      expect(ur.canUndo()).toBe(false);
      expect(ur.current()).toEqual(baseline);
    });

    it('adds no entry for a pass that ended back at its baseline', () => {
      ur.beginPass(baseline);
      ur.pushState({ value: 1 });
      ur.pushState(baseline);
      ur.endPass();
      expect(ur.canUndo()).toBe(false);
    });

    it('abortPass returns the baseline and leaves history untouched', () => {
      ur.pushState({ value: 7 }); // a pre-recording edit
      const before = ur.getSnapshot();
      ur.beginPass({ value: 7 });
      ur.pushState({ value: 8 });
      ur.pushState({ value: 9 });
      expect(ur.abortPass()).toEqual({ value: 7 });
      expect(ur.getSnapshot()).toEqual(before);
      // The next undo steps over the pre-recording edit, not the take.
      expect(ur.undo()).toEqual({ value: 0 });
    });

    it('keeps recording after an abort, and the retake is one entry', () => {
      ur.beginPass(baseline);
      ur.pushState({ value: 1 });
      ur.abortPass();
      expect(ur.isPassActive()).toBe(true);
      ur.pushState({ value: 5 });
      ur.pushState({ value: 6 });
      ur.endPass();
      expect(ur.current()).toEqual({ value: 6 });
      expect(ur.undo()).toEqual(baseline);
    });

    it('adds no entry when a pass ends with nothing written since the abort', () => {
      ur.beginPass(baseline);
      ur.pushState({ value: 1 });
      ur.abortPass();
      ur.endPass();
      expect(ur.canUndo()).toBe(false);
    });

    it('tracks pass dirtiness through canUndo', () => {
      ur.beginPass(baseline);
      expect(ur.hasPassChanges()).toBe(false);
      expect(ur.canUndo()).toBe(false);
      ur.pushState({ value: 1 });
      expect(ur.hasPassChanges()).toBe(true);
      // Undo is offered even though history is still empty — it erases the take.
      expect(ur.canUndo()).toBe(true);
      expect(ur.getSnapshot().canUndo).toBe(true);
      ur.abortPass();
      expect(ur.hasPassChanges()).toBe(false);
      expect(ur.canUndo()).toBe(false);
    });

    it('notifies once on the clean → dirty edge', () => {
      const sub = vi.fn();
      ur.subscribe(sub);
      ur.beginPass(baseline);
      sub.mockClear();
      ur.pushState({ value: 1 });
      ur.pushState({ value: 2 });
      ur.pushState({ value: 3 });
      expect(sub).toHaveBeenCalledTimes(1);
    });

    it('keeps the recording gate closed inside a pass', () => {
      // Models withRecording() around a key-down write: its finally-clause
      // setRecording(false) must not let the next write into history.
      ur.beginPass(baseline);
      ur.setRecording(true);
      ur.pushState({ value: 1 });
      ur.setRecording(false);
      ur.pushState({ value: 2 });
      expect(ur.current()).toEqual(baseline);
      expect(ur.hasPassChanges()).toBe(true);
      ur.endPass();
      expect(ur.current()).toEqual({ value: 2 });
    });

    it('drops the redo tail when a pass ends, but not when it aborts', () => {
      ur.pushState({ value: 1 });
      ur.pushState({ value: 2 });
      ur.undo();
      expect(ur.canRedo()).toBe(true);

      const aborted = createUndoRedoMiddleware({ value: 0 }, 50);
      aborted.pushState({ value: 1 });
      aborted.pushState({ value: 2 });
      aborted.undo();
      aborted.beginPass({ value: 1 });
      aborted.pushState({ value: 9 });
      aborted.abortPass();
      expect(aborted.canRedo()).toBe(true);

      ur.beginPass({ value: 1 });
      ur.pushState({ value: 9 });
      ur.endPass();
      expect(ur.canRedo()).toBe(false);
    });

    it('re-baselines an open pass when history is navigated', () => {
      ur.pushState({ value: 1 });
      ur.beginPass({ value: 1 });
      ur.undo(); // user undoes the pre-recording edit mid-pass
      expect(ur.abortPass()).toEqual({ value: 0 });
    });
  });
});
