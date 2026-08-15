import { useEffect } from 'react';
import { projectStore } from '@/store/projectStore';
import type { UndoRedoMiddleware } from '@/engine/undoRedo';
import type { Project } from '@/types/music';

/** Just the pass lifecycle, so tests can pass a pair of spies. */
type PassControls = Pick<UndoRedoMiddleware<Project | null>, 'beginPass' | 'endPass'>;

/**
 * Ties the undo engine's record pass to the transport.
 *
 * A pass is the stretch of time the user is actually recording — armed *and*
 * rolling — and it is one undo step. Ctrl+Z during it erases the whole take
 * rather than the last block of it, and Ctrl+Z after it removes the take
 * whole. Everything written in between, including a timeline edit made
 * mid-take, belongs to the pass: while the transport is rolling and armed,
 * "undo" means "scrap that take".
 *
 * Deriving both edges from one boolean is what makes the pass impossible to
 * leak — there is no edge-detection state to get out of step, and unmounting
 * closes the pass through the same cleanup that stopping does.
 */
export function useRecordSession(active: boolean, ur: PassControls): void {
  // Loading a project mid-pass ends the old one rather than leaving a baseline
  // pointing at a project that is no longer open.
  const projectId = projectStore((s) => s.project?.id);

  useEffect(() => {
    if (!active) return;
    // The baseline comes from the store — what the user can see — rather than
    // from the history pointer, so a restore can never show them something else.
    ur.beginPass(projectStore.getState().project);
    return () => ur.endPass();
  }, [active, projectId, ur]);
}
