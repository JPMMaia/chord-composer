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
  /**
   * Which editing surface the centre column shows.
   *
   * A pure view switch, which is why it is here and not beside `editingPhraseId` in
   * `projectStore`: that field says *which sub-tree the segment actions address*, and
   * has to survive a render that is showing the arrangement — going back to the
   * arrangement and returning to the phrase editor should land on the same phrase.
   * The two are kept in step by `openClip`/`closePhrase`, which set both.
   */
  view: 'arrangement' | 'phrase';
  setView: (view: 'arrangement' | 'phrase') => void;

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
   * Whether the automation stack is shown under the phrase's chord lanes.
   *
   * A view setting rather than part of the piece — the curves themselves live on the
   * phrase and are saved with it — so this is not written to the project file.
   */
  showAutomation: boolean;
  setShowAutomation: (shown: boolean) => void;

  /**
   * Whether the phrase editor shows and sounds the rest of the arrangement.
   *
   * A phrase is written *against* something — a bass line under a chord part — and the
   * placement being edited already says which stretch of song that something is, so
   * this starts on. It is the coarse switch only: which instruments come through is
   * each instrument's own eye and mute in the panel, which already mean exactly
   * "drawn" and "heard" everywhere else in the app.
   *
   * A view setting rather than part of the piece, like `showAutomation` above: it is
   * never written to the project file and never reaches the undo stack, so turning the
   * rest of the band off to concentrate cannot be undone out from under the user along
   * with the edit they actually made.
   */
  phraseContext: boolean;
  setPhraseContext: (on: boolean) => void;

  /**
   * The stretch of the open phrase that Play repeats, in the phrase's own beats.
   *
   * Null means the whole phrase, which is what every phrase opens at. A way of
   * listening rather than part of the music: it is never written to the project file
   * and never reaches the undo stack, so narrowing it while working on a bar cannot
   * be undone out from under the user along with the edit they actually made.
   */
  phraseLoop: { start: number; end: number } | null;
  setPhraseLoop: (start: number | null, end: number | null) => void;

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
   * The formula strip: which scale degree its phrases start on, and whether it is
   * unfolded.
   *
   * Alongside the palette's own settings rather than inside `FormulaPalette`, for
   * the same reason: the timeline reads the start degree when a formula is dropped,
   * and the drop caret reads the formula being dragged to size itself. Which *group*
   * the strip is showing lives in `formulaLibraryStore` instead, with the libraries
   * it has to be a valid position in.
   */
  formulaStartDegree: number;
  setFormulaStartDegree: (degree: number) => void;
  formulasExpanded: boolean;
  setFormulasExpanded: (expanded: boolean) => void;
  /**
   * Id of the formula currently under the pointer in a drag, or null.
   *
   * The dragged payload is deliberately unreadable during `dragover` — browsers
   * withhold it until the drop — so the caret cannot measure the phrase from the
   * event. This is how it finds out how wide to draw.
   */
  draggingFormulaId: string | null;
  setDraggingFormulaId: (formulaId: string | null) => void;

  /**
   * Whether the number keys write to the timeline. Recording only actually happens
   * while armed *and* playing; armed on its own is a readiness, which is what makes
   * arming before pressing Play the natural order.
   *
   * Can only be armed from the phrase editor — see `setRecordArmed`.
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
  view: 'arrangement',

  setView: (view: 'arrangement' | 'phrase') => {
    // Leaving the phrase editor disarms recording: a take needs a phrase to land in,
    // and the arrangement has none open. Done here rather than at the two places that
    // arm, so no future caller can leave the transport pulsing at nothing.
    // The audition loop goes with it. It names beats in one phrase, so carrying it to
    // the next surface would repeat a stretch of something else entirely.
    set(
      view === 'arrangement'
        ? { view, recordArmed: false, phraseLoop: null }
        : { view, phraseLoop: null }
    );
  },

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

  phraseContext: true,

  setPhraseContext: (on: boolean) => {
    set({ phraseContext: on });
  },

  phraseLoop: null,

  setPhraseLoop: (start: number | null, end: number | null) => {
    // Either bound missing means "the whole phrase" — that is what a click on open
    // ruler sends.
    if (start === null || end === null) {
      set({ phraseLoop: null });
      return;
    }

    // Taken as a span rather than as a direction: the ruler already hands over its
    // edges in order, but a caller that drew one backwards still means the stretch
    // between them.
    const lo = Math.max(0, Math.min(start, end));
    const hi = Math.max(start, end);

    // A range with nothing in it — both edges snapped onto one beat — would repeat
    // silence for as long as it was left to, so it reads as no range at all.
    set({ phraseLoop: hi - lo <= 0 ? null : { start: lo, end: hi } });
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

  formulaStartDegree: 0,

  setFormulaStartDegree: (degree: number) => {
    if (!Number.isFinite(degree)) return;
    set({ formulaStartDegree: Math.round(degree) });
  },

  formulasExpanded: true,

  setFormulasExpanded: (expanded: boolean) => {
    set({ formulasExpanded: expanded });
  },

  draggingFormulaId: null,

  setDraggingFormulaId: (formulaId: string | null) => {
    set({ draggingFormulaId: formulaId });
  },

  recordArmed: false,

  setRecordArmed: (armed: boolean) => {
    // Only the phrase editor has somewhere for a take to go. Refusing here rather
    // than in the button and the R key separately keeps the two from disagreeing.
    if (armed && get().view !== 'phrase') return;
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
