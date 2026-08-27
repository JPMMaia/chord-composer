import { useEffect } from 'react';
import { clipboardStore } from '@/store/clipboardStore';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { snapBeat } from '@/engine/timeline';
import { editorStore } from '@/store/editorStore';
import { isTextEntry } from '@/utils/keyboard';

/**
 * Track the current mouse position globally so paste can compute the anchor
 * even when the mouse never moved inside the timeline container.
 */
const lastMouseX = { current: 0 };

/**
 * Ctrl+C / Ctrl+V (Cmd+C / Cmd+V on Mac) to copy and paste selected segments.
 *
 * Copy captures every selected segment within the currently selected instrument.
 * Paste places a fresh copy of the segments at the position of the mouse cursor on
 * the timeline ruler, with the earliest copied block's left edge anchored to the
 * cursor beat and the rest keeping the spacing they were copied with. The target
 * instrument is the currently selected one.
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
        // Only the left edge is a limit: a pointer left of the ruler names no beat.
        // Past its right edge is a real position — the empty space after the phrase —
        // and pasting there is how the phrase gets longer.
        if (mouseX < rect.left) return;

        const { pixelsPerBeat, snapBeats } = editorStore.getState();
        const mouseBeat = (mouseX - rect.left) / pixelsPerBeat;
        // Pull the anchor onto the editing grid, exactly like dragging does — a paste
        // must land on the grid, not wherever the pixel under the cursor happened to
        // fall. Nothing else constrains it: the group keeps the spacing it was copied
        // with, and an anchor past the end of the phrase lengthens the phrase rather
        // than collapsing onto its last bar.
        const anchorBeat = Math.max(0, snapBeat(mouseBeat, snapBeats));

        const newIds = projectStore
          .getState()
          .pasteSegments(segments, trackId, anchorBeat);
        if (!newIds || newIds.length === 0) return;

        // Select the newly pasted segments so the user can immediately edit them.
        selectionStore.getState().setSelectedSegments(newIds);

        // Do not clear the clipboard — keep segments available so repeated
        // Ctrl+V can paste again at the current mouse position.

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
