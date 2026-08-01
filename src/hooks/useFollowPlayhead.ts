import { useEffect } from 'react';
import { editorStore } from '@/store/editorStore';
import { PIANO_KEYS_WIDTH, PIXELS_PER_BEAT } from '@/utils/constants';

/**
 * Where the playhead is placed after a page turn, as a fraction of the viewport.
 *
 * Not zero: landing the playhead flush against the left edge leaves no run-up, so
 * the bar it is about to enter is off screen at the moment it matters.
 */
const LEAD_IN_FRACTION = 0.1;

/**
 * Keep the playhead in view while the project plays, by paging the shared scroll
 * offset forward whenever it leaves the visible span.
 *
 * A page turn rather than a continuous slide: scrolling every frame would leave
 * the grid permanently in motion under a stationary playhead, which is much harder
 * to read than a still grid that jumps once per screen. Between turns the view is
 * the user's — manual scrolling is only overridden when the playhead actually
 * leaves it, and never at all while playback is stopped or paused.
 */
export function useFollowPlayhead(playheadBeat: number, isPlaying: boolean): void {
  useEffect(() => {
    if (!isPlaying) return;

    const { scrollX, viewportWidth, setScrollX } = editorStore.getState();
    // The panes' visible beat axis is the viewport minus the key column, which
    // does not scroll.
    const visibleWidth = viewportWidth - PIANO_KEYS_WIDTH;
    if (visibleWidth <= 0) return;

    const playheadX = playheadBeat * PIXELS_PER_BEAT;
    if (playheadX >= scrollX && playheadX <= scrollX + visibleWidth) return;

    setScrollX(playheadX - visibleWidth * LEAD_IN_FRACTION);
  }, [playheadBeat, isPlaying]);
}
