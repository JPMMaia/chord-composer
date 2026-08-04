import { create } from 'zustand';
import { DEFAULT_SNAP_BEATS, SNAP_OPTIONS } from '@/engine/timeline';
import type { Scale } from '@/types/music';

interface EditorState {
  /** Grid resolution every timeline edit lands on, in beats. */
  snapBeats: number;
  setSnapBeats: (beats: number) => void;

  /**
   * The key being composed in: what the palette offers, what a dropped block is
   * stamped with, and what the piano roll shades.
   *
   * A view setting, not part of the piece — the blocks carry their own keys — so
   * it is not saved with the project. Opening one seeds it from the project key.
   */
  paletteScale: Scale;
  setPaletteScale: (scale: Scale) => void;

  /** Horizontal scroll offset shared by the chord timeline and the piano roll, in pixels. */
  scrollX: number;
  /** Largest legal `scrollX`, from the last measured content and viewport widths. */
  maxScrollX: number;
  /** Width of the scrolling viewport, in pixels. Zero until something measures it. */
  viewportWidth: number;
  /** Mouse position on the timeline ruler in absolute beats (updated in ChordTimeline). */
  timelineMouseBeat: number | null;
  setTimelineMouseBeat: (beat: number | null) => void;

  setScrollX: (x: number) => void;
  setScrollExtent: (contentWidth: number, viewportWidth: number) => void;
}

/**
 * Editor-wide settings for the chord timeline.
 *
 * The snap resolution lives here rather than in a component because three separate
 * gestures — dropping from the palette, dragging a block, nudging with the arrow
 * keys — all have to land on the same lattice. The scroll offset is here for the
 * same reason: the timeline, the piano roll and the scrollbar under them are three
 * views of one beat axis, and a single number is what keeps them aligned.
 */
export const editorStore = create<EditorState>((set, get) => ({
  snapBeats: DEFAULT_SNAP_BEATS,

  setSnapBeats: (beats: number) => {
    // A value off the menu would mean a grid the user cannot see, so refuse it
    // rather than silently editing at some arbitrary resolution.
    if (!SNAP_OPTIONS.some(option => option.beats === beats)) return;
    set({ snapBeats: beats });
  },

  paletteScale: { root: 'C', type: 'major' },

  setPaletteScale: (scale: Scale) => {
    set({ paletteScale: { root: scale.root, type: scale.type } });
  },

  scrollX: 0,
  maxScrollX: 0,
  viewportWidth: 0,
  timelineMouseBeat: null,

  setTimelineMouseBeat: (beat: number | null) => {
    set({ timelineMouseBeat: beat });
  },

  setScrollX: (x: number) => {
    // Clamping centrally means neither the scrollbar nor the playhead-follow has
    // to know the project's width to avoid scrolling past the last bar.
    const clamped = Math.min(get().maxScrollX, Math.max(0, Number.isFinite(x) ? x : 0));
    if (clamped !== get().scrollX) set({ scrollX: clamped });
  },

  setScrollExtent: (contentWidth: number, viewportWidth: number) => {
    const maxScrollX = Math.max(0, contentWidth - viewportWidth);
    // Removing bars or narrowing the window can strand the view past the end,
    // so the offset is re-clamped against the new limit as it is set.
    set({ maxScrollX, viewportWidth, scrollX: Math.min(get().scrollX, maxScrollX) });
  },
}));
