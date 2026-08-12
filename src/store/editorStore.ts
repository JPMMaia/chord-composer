import { create } from 'zustand';
import { DEFAULT_SNAP_BEATS, SNAP_OPTIONS } from '@/engine/timeline';
import type { PaletteMode } from '@/engine/palette';
import type { Scale } from '@/types/music';
import { MAX_SEGMENT_OCTAVE, MIN_SEGMENT_OCTAVE, PIXELS_PER_BEAT } from '@/utils/constants';

/**
 * Zoom stops, in pixels per beat, coarsest first.
 *
 * Powers of two around the default so that halving and doubling always land on a
 * stop, and so a bar's width stays a round number of pixels at every level. The top
 * stop puts a thirty-second at 40px, which is comfortably grabbable.
 */
export const ZOOM_LEVELS = [40, PIXELS_PER_BEAT, 160, 320];

interface EditorState {
  /** Grid resolution every timeline edit lands on, in beats. */
  snapBeats: number;
  setSnapBeats: (beats: number) => void;

  /**
   * Horizontal scale of the beat axis, in pixels per beat.
   *
   * The finest grid the editor offers is a thirty-second, which at the default scale
   * is ten pixels — narrower than a block's own resize grip. Zoom is what makes that
   * resolution actually editable rather than merely representable.
   */
  pixelsPerBeat: number;
  setPixelsPerBeat: (pixelsPerBeat: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;

  /**
   * Whether the volume automation lane is shown under the chord lanes.
   *
   * A view setting rather than part of the piece — the curve itself lives on the
   * instrument and is saved with it — so this is not written to the project file.
   */
  showAutomation: boolean;
  setShowAutomation: (shown: boolean) => void;

  /**
   * The key being composed in: what the palette offers, what a dropped block is
   * stamped with, and what the piano roll shades.
   *
   * A view setting, not part of the piece — the blocks carry their own keys — so
   * it is not saved with the project. Opening one seeds it from the project key.
   */
  paletteScale: Scale;
  setPaletteScale: (scale: Scale) => void;

  /**
   * Which family of blocks the palette offers, and the register it builds them in.
   *
   * Here rather than inside `ScalePalette` because they are no longer only the
   * strip's business: the number keys play the palette, and they need to know
   * whether `2` means `Dm`, `Dm7` or `D4`.
   */
  paletteMode: PaletteMode;
  setPaletteMode: (mode: PaletteMode) => void;
  paletteOctave: number;
  setPaletteOctave: (octave: number) => void;

  /**
   * Whether the number keys write to the timeline. Recording only actually happens
   * while armed *and* playing; armed on its own is a readiness, which is what makes
   * arming before pressing Play the natural order.
   */
  recordArmed: boolean;
  setRecordArmed: (armed: boolean) => void;
  /** Whether a recorded take snaps to `snapBeats`, or keeps the timing it was played with. */
  recordQuantize: boolean;
  setRecordQuantize: (on: boolean) => void;

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

  pixelsPerBeat: PIXELS_PER_BEAT,

  setPixelsPerBeat: (pixelsPerBeat: number) => {
    // Off-menu levels are refused for the same reason off-menu snap values are: the
    // toolbar would be reporting a scale the view is not actually drawn at.
    if (!ZOOM_LEVELS.includes(pixelsPerBeat)) return;

    const { pixelsPerBeat: previous, scrollX, viewportWidth } = get();
    if (pixelsPerBeat === previous) return;

    // Zoom about the middle of the viewport rather than its left edge, so the music
    // under the centre of the view stays put instead of sliding away. `maxScrollX`
    // still reflects the old scale here — `setScrollExtent` re-measures once the
    // wider content lands — so the offset is stored raw and clamped on the next set.
    const centre = scrollX + viewportWidth / 2;
    const nextScrollX = Math.max(0, (centre * pixelsPerBeat) / previous - viewportWidth / 2);

    set({ pixelsPerBeat, scrollX: nextScrollX });
  },

  zoomIn: () => {
    const index = ZOOM_LEVELS.indexOf(get().pixelsPerBeat);
    get().setPixelsPerBeat(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, index + 1)]);
  },

  zoomOut: () => {
    const index = ZOOM_LEVELS.indexOf(get().pixelsPerBeat);
    get().setPixelsPerBeat(ZOOM_LEVELS[Math.max(0, index - 1)]);
  },

  showAutomation: true,

  setShowAutomation: (shown: boolean) => {
    set({ showAutomation: shown });
  },

  paletteScale: { root: 'C', type: 'major' },

  setPaletteScale: (scale: Scale) => {
    set({ paletteScale: { root: scale.root, type: scale.type } });
  },

  paletteMode: 'chords',

  setPaletteMode: (mode: PaletteMode) => {
    set({ paletteMode: mode });
  },

  paletteOctave: 4,

  setPaletteOctave: (octave: number) => {
    // Clamped rather than trusted: the record shortcuts can be pointed at this from
    // outside the strip's <select>, and a block has to land in a playable register.
    if (!Number.isFinite(octave)) return;
    set({
      paletteOctave: Math.min(MAX_SEGMENT_OCTAVE, Math.max(MIN_SEGMENT_OCTAVE, Math.round(octave))),
    });
  },

  recordArmed: false,

  setRecordArmed: (armed: boolean) => {
    set({ recordArmed: armed });
  },

  recordQuantize: true,

  setRecordQuantize: (on: boolean) => {
    set({ recordQuantize: on });
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
