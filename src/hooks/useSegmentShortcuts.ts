import { useEffect } from 'react';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { flattenSegments } from '@/engine/timeline';

/** True for the elements that own their own arrow keys — selects, text fields. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  );
}

/**
 * Keyboard shortcuts that act on the timeline's selected segments.
 *
 * | Key | Note | Chord |
 * | --- | --- | --- |
 * | `↑` `↓` | next / previous note of the bar's scale | next / previous scale degree |
 * | `+` `-` | pitch ± an octave | register ± 1 |
 * | `i` | — | cycle inversion, wrapping to root position |
 * | `Del` `⌫` | delete every selected block | |
 * | `Ctrl/Cmd+A` | select every block in the project | |
 * | `Esc` | clear the selection | |
 *
 * Every edit applies to the whole selection in one store write, so a keypress is
 * one visual step and one undo entry however many blocks are selected.
 *
 * Bound to the window rather than to the block's own `onKeyDown`, because the
 * shortcut follows *selection*, not DOM focus: a block stays selected after a
 * drag, or after a click lands elsewhere in the lane, where focus does not follow.
 * The block keeps its own handler for `←`/`→`, which need the bar and start-beat
 * context only it has.
 */
export function useSegmentShortcuts(): void {
  const selectedSegmentIds = selectionStore(s => s.selectedSegmentIds);
  const setSelectedSegments = selectionStore(s => s.setSelectedSegments);
  const clearSegmentSelection = selectionStore(s => s.clearSegmentSelection);
  const stepSegmentsPitch = projectStore(s => s.stepSegmentsPitch);
  const shiftSegmentsOctave = projectStore(s => s.shiftSegmentsOctave);
  const cycleSegmentsInversion = projectStore(s => s.cycleSegmentsInversion);
  const removeSegments = projectStore(s => s.removeSegments);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Leave the snap, octave and time-signature dropdowns their own keys.
      if (isTextEntry(e.target)) return;

      // Select-all comes first: it is the one shortcut here that both carries a
      // modifier and works from an empty selection.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'a' || e.key === 'A')) {
        const project = projectStore.getState().project;
        if (!project) return;
        // Select-all means "everything the timeline is showing", which is the
        // selected instrument's blocks — not every instrument's at once.
        const trackId = selectionStore.getState().selectedTrackId;
        if (!trackId) return;
        setSelectedSegments(flattenSegments(project.bars, trackId).map(s => s.id));
        e.preventDefault();
        return;
      }

      if (e.key === 'Escape') {
        clearSegmentSelection();
        e.preventDefault();
        return;
      }

      // Let the remaining Ctrl/Cmd combinations through to the shortcuts that own
      // them — undo/redo, above all.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (selectedSegmentIds.length === 0) return;

      switch (e.key) {
        case 'ArrowUp':
          stepSegmentsPitch(selectedSegmentIds, 1);
          break;
        case 'ArrowDown':
          stepSegmentsPitch(selectedSegmentIds, -1);
          break;
        // '=' and '_' are the unshifted twins of '+' and '-' on most layouts, and
        // reaching for either plainly means the same thing.
        case '+':
        case '=':
          shiftSegmentsOctave(selectedSegmentIds, 1);
          break;
        case '-':
        case '_':
          shiftSegmentsOctave(selectedSegmentIds, -1);
          break;
        case 'i':
        case 'I':
          cycleSegmentsInversion(selectedSegmentIds);
          break;
        // The whole selection goes at once, and the selection goes with it — the
        // ids it held name blocks that no longer exist.
        case 'Delete':
        case 'Backspace':
          removeSegments(selectedSegmentIds);
          clearSegmentSelection();
          break;
        default:
          return;
      }

      e.preventDefault();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    selectedSegmentIds,
    setSelectedSegments,
    clearSegmentSelection,
    stepSegmentsPitch,
    shiftSegmentsOctave,
    cycleSegmentsInversion,
    removeSegments,
  ]);
}
