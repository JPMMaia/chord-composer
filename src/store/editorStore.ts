import { create } from 'zustand';
import { DEFAULT_SNAP_BEATS, SNAP_OPTIONS } from '@/engine/timeline';

interface EditorState {
  /** Grid resolution every timeline edit lands on, in beats. */
  snapBeats: number;
  setSnapBeats: (beats: number) => void;
}

/**
 * Editor-wide settings for the chord timeline.
 *
 * The snap resolution lives here rather than in a component because three separate
 * gestures — dropping from the palette, dragging a block, nudging with the arrow
 * keys — all have to land on the same lattice.
 */
export const editorStore = create<EditorState>(set => ({
  snapBeats: DEFAULT_SNAP_BEATS,

  setSnapBeats: (beats: number) => {
    // A value off the menu would mean a grid the user cannot see, so refuse it
    // rather than silently editing at some arbitrary resolution.
    if (!SNAP_OPTIONS.some(option => option.beats === beats)) return;
    set({ snapBeats: beats });
  },
}));
