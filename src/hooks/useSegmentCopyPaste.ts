import { useEffect } from 'react';
import { clipboardStore } from '@/store/clipboardStore';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { getBarBeats, getTotalBeats } from '@/engine/timeline';
import { editorStore } from '@/store/editorStore';
import { isTextEntry } from '@/utils/keyboard';

/**
 * Convert an absolute beat position into a paste target:
 * the bar index and the offset within that bar.
 *
 * Returns null when there is no project data yet.
 */
function resolvePasteTarget(
  absoluteBeat: number,
  bars: import('@/types/music').Bar[],
  projectTs: import('@/types/music').TimeSignature
): { barIndex: number; startBeat: number } | null {
  if (!bars.length) return null;

  let accumulatedBeat = 0;
  for (let i = 0; i < bars.length; i++) {
    const barBeats = getBarBeats(bars[i], projectTs);
    if (absoluteBeat < accumulatedBeat + barBeats) {
      return { barIndex: i, startBeat: absoluteBeat - accumulatedBeat };
    }
    accumulatedBeat += barBeats;
  }
  // Beat falls after the last bar — paste at the start of the last bar.
  return { barIndex: bars.length - 1, startBeat: 0 };
}

/**
 * Track the current mouse position globally so paste can compute the anchor
 * even when the mouse never moved inside the timeline container.
 */
const lastMouseX = { current: 0 };

/**
 * Ctrl+C / Ctrl+V (Cmd+C / Cmd+V on Mac) to copy and paste selected segments.
 *
 * Copy captures every selected segment within the currently selected instrument.
 * Paste places a fresh copy of the segments at the position of the mouse cursor
 * on the timeline ruler, with the left edge of the first pasted segment anchored
 * to the cursor beat. The target instrument is the currently selected one.
 *
 * Each Ctrl+V reads the current mouse position — there is no cascade.
 *
 * Bound to the window so it follows selection, not DOM focus.
 */
export function useSegmentCopyPaste(): void {
  useEffect(() => {
    // Keep the global mouse position up to date so paste always has a cursor
    // position even when the mouse never moved inside the timeline area.
    const handleMouseMove = (e: MouseEvent) => {
      lastMouseX.current = e.clientX;
    };
    window.addEventListener('mousemove', handleMouseMove);

    const handleKeyDown = (e: KeyboardEvent) => {
      // Leave dropdowns and text fields their own keys.
      if (isTextEntry(e.target)) return;

      // Only respond to Ctrl/Cmd+C and Ctrl/Cmd+V.
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.altKey) return;

      const key = e.key.toLowerCase();

      if (key === 'c') {
        // Copy selected segments.
        const { selectedSegmentIds } = selectionStore.getState();
        if (selectedSegmentIds.length === 0) return;

        clipboardStore.getState().copySegments();
        e.preventDefault();
        return;
      }

      if (key === 'v') {
        const { segments, sourceTrackId } = clipboardStore.getState();
        if (segments.length === 0) return;

        const project = projectStore.getState().project;
        if (!project) return;

        // Determine the target instrument from the current selection.
        const trackId = selectionStore.getState().selectedTrackId ?? sourceTrackId;
        if (!project.tracks.some(t => t.id === trackId)) return;

        // Resolve the mouse position into a paste target.  Read the ruler
        // element directly from the DOM and compute the beat from the current
        // mouse X (tracked by the window-level mousemove listener above).  This
        // always works even when the mouse never moved inside the timeline
        // container — the element-level pointermove listener that feeds
        // timelineMouseBeat would otherwise stay null.
        const ruler = document.querySelector(
          '[data-testid="timeline-ruler"]'
        ) as HTMLElement | null;
        if (!ruler) return;

        const rect = ruler.getBoundingClientRect();
        const mouseX = lastMouseX.current;
        if (mouseX < rect.left || mouseX > rect.right) return;

        const mouseBeat =
          (mouseX - rect.left) / editorStore.getState().pixelsPerBeat;
        const totalBeats = getTotalBeats(project.bars, project.timeSignature);
        const clampedBeat = Math.max(0, Math.min(mouseBeat, totalBeats));

        const target = resolvePasteTarget(
          clampedBeat,
          project.bars,
          project.timeSignature
        );
        if (!target) return;

        // Compute the offset bar index and start beat for pasteSegments.
        // pasteSegments uses a base bar index and applies relative bar offsets
        // per-segment, so we pass the target bar index as the base and the
        // cursor's beat within that bar as the anchor point.
        const offsetBarIndex = target.barIndex;

        const newIds = projectStore.getState().pasteSegments(
          segments,
          trackId,
          offsetBarIndex,
          target.startBeat
        );
        if (!newIds || newIds.length === 0) return;

        // Select the newly pasted segments so the user can immediately edit them.
        selectionStore.getState().setSelectedSegments(newIds);

        // Do not clear the clipboard — keep segments available so repeated
        // Ctrl+V can paste again at the current mouse position.
        // lastPasteBarIndex / lastPasteTrackId are already null (copy resets them),
        // and the paste logic no longer uses them for anchor computation.

        e.preventDefault();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);
}
