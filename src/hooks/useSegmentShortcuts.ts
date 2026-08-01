import { useEffect } from 'react';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';

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
 * Keyboard shortcuts that edit the pitch of the selected timeline segment.
 *
 * | Key | Note | Chord |
 * | --- | --- | --- |
 * | `↑` `↓` | next / previous note of the bar's scale | next / previous scale degree |
 * | `+` `-` | pitch ± an octave | register ± 1 |
 * | `i` | — | cycle inversion, wrapping to root position |
 *
 * Bound to the window rather than to the block's own `onKeyDown`, because the
 * shortcut follows *selection*, not DOM focus: a block stays selected after a
 * drag, or after a click lands elsewhere in the lane, where focus does not follow.
 * The block keeps its own handler for `←`/`→`/`Delete`, which need the bar and
 * start-beat context only it has.
 */
export function useSegmentShortcuts(): void {
  const selectedSegmentId = selectionStore(s => s.selectedSegmentId);
  const stepSegmentPitch = projectStore(s => s.stepSegmentPitch);
  const shiftSegmentOctave = projectStore(s => s.shiftSegmentOctave);
  const cycleSegmentInversion = projectStore(s => s.cycleSegmentInversion);

  useEffect(() => {
    if (!selectedSegmentId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Leave the snap, octave and time-signature dropdowns their arrow keys, and
      // let Ctrl/Cmd combinations through to the shortcuts that own them.
      if (isTextEntry(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case 'ArrowUp':
          stepSegmentPitch(selectedSegmentId, 1);
          break;
        case 'ArrowDown':
          stepSegmentPitch(selectedSegmentId, -1);
          break;
        // '=' and '_' are the unshifted twins of '+' and '-' on most layouts, and
        // reaching for either plainly means the same thing.
        case '+':
        case '=':
          shiftSegmentOctave(selectedSegmentId, 1);
          break;
        case '-':
        case '_':
          shiftSegmentOctave(selectedSegmentId, -1);
          break;
        case 'i':
        case 'I':
          cycleSegmentInversion(selectedSegmentId);
          break;
        default:
          return;
      }

      e.preventDefault();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSegmentId, stepSegmentPitch, shiftSegmentOctave, cycleSegmentInversion]);
}
