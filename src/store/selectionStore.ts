import { create } from 'zustand';

/**
 * Which automation lane a picked point belongs to, and where in it.
 *
 * `laneKey` comes from `@/engine/parameterAutomation` — `'volume'` for the
 * instrument's level, `param:<paramId>` for a plugin parameter. A plain string
 * rather than a tagged union because its only job is to tell two lanes apart;
 * nothing here ever has to take it back apart.
 */
export interface AutomationPointSelection {
  laneKey: string;
  index: number;
}

interface SelectionState {
  /** Bar whose scale drives the palette and the properties panel. */
  selectedBarId: string | null;
  /**
   * Instrument being edited. The chord timeline shows only this instrument's
   * blocks; the piano roll draws every visible instrument but highlights this one.
   */
  selectedTrackId: string | null;
  /** Every selected block, in project order. Empty when nothing is selected. */
  selectedSegmentIds: string[];
  /** Where a Shift+click range measures from — the last block picked on its own. */
  anchorSegmentId: string | null;
  /**
   * The picked automation point, or null.
   *
   * An index rather than an id because a point has none: it is a beat and a level,
   * and the store keeps the list sorted. `laneKey` says which curve that index
   * counts into — `'volume'`, or `param:<id>` for a plugin parameter — because
   * the selected instrument now stacks several lanes and an index alone would be
   * ambiguous between them.
   *
   * Valid only against the selected instrument, which is the only one whose lanes
   * are ever shown.
   */
  selectedAutomationPoint: AutomationPointSelection | null;
  /** The section picked in the band above the ruler, or null. */
  selectedSectionId: string | null;
  selectBar: (barId: string | null) => void;
  selectTrack: (trackId: string | null) => void;
  /** Replace the selection with one block, or clear it. */
  selectSegment: (segmentId: string | null) => void;
  setSelectedSegments: (segmentIds: string[]) => void;
  /** Move the range anchor without disturbing the selection. */
  anchorSegment: (segmentId: string) => void;
  /** Ctrl/Cmd+click: add the block, or drop it if it was already in. */
  toggleSegment: (segmentId: string) => void;
  clearSegmentSelection: () => void;
  /** Pick a point in an automation lane, or clear the pick with null. */
  selectAutomationPoint: (point: AutomationPointSelection | null) => void;
  /** Pick a section in the band, or clear the pick with null. */
  selectSection: (sectionId: string | null) => void;
  clearSelection: () => void;
}

/**
 * Editor selection, kept out of `projectStore` because it is view state: it is
 * never saved, never exported, and survives no reload.
 *
 * Segment selection is a set, and deliberately independent of `selectedBarId`: a
 * Ctrl- or Shift-click selection legitimately spans several bars, so moving the
 * bar cursor must not disturb it. Dropping the selection is an explicit gesture —
 * a press on empty lane space, or Escape.
 *
 * Blocks, automation points and sections, by contrast, are *mutually exclusive*:
 * picking any drops the others. They are three answers to one question — what does
 * Delete act on — and letting two be selected at once would make that key ambiguous,
 * erasing a chord and a point together on a single press.
 */
export const selectionStore = create<SelectionState>((set, get) => ({
  selectedBarId: null,
  selectedTrackId: null,
  selectedSegmentIds: [],
  anchorSegmentId: null,
  selectedAutomationPoint: null,
  selectedSectionId: null,

  selectBar: (barId: string | null) => {
    set({ selectedBarId: barId });
  },

  /**
   * Switch the instrument being edited, dropping the block selection with it —
   * those ids belong to the instrument being left, and the timeline is about to
   * stop showing them.
   */
  selectTrack: (trackId: string | null) => {
    if (get().selectedTrackId === trackId) return;
    // The point goes too: it names a position in a curve of the instrument being
    // left, and the lanes are about to draw a different instrument's.
    set({
      selectedTrackId: trackId,
      selectedSegmentIds: [],
      anchorSegmentId: null,
      selectedAutomationPoint: null,
    });
  },

  selectSegment: (segmentId: string | null) => {
    set({
      selectedSegmentIds: segmentId ? [segmentId] : [],
      anchorSegmentId: segmentId,
      selectedAutomationPoint: null,
      selectedSectionId: null,
    });
  },

  setSelectedSegments: (segmentIds: string[]) => {
    set({
      selectedSegmentIds: [...new Set(segmentIds)],
      selectedAutomationPoint: null,
      selectedSectionId: null,
    });
  },

  anchorSegment: (segmentId: string) => {
    set({ anchorSegmentId: segmentId });
  },

  toggleSegment: (segmentId: string) => {
    const current = get().selectedSegmentIds;
    const isSelected = current.includes(segmentId);
    set({
      selectedSegmentIds: isSelected
        ? current.filter(id => id !== segmentId)
        : [...current, segmentId],
      // A block that was just removed is a poor place to measure a range from.
      anchorSegmentId: isSelected ? get().anchorSegmentId : segmentId,
      selectedAutomationPoint: null,
      selectedSectionId: null,
    });
  },

  clearSegmentSelection: () => {
    set({ selectedSegmentIds: [], anchorSegmentId: null });
  },

  selectAutomationPoint: (point: AutomationPointSelection | null) => {
    set({
      selectedAutomationPoint: point,
      // Picking a point drops the blocks, so Delete has exactly one meaning.
      // Picking one in *another lane* replaces this selection outright, for the
      // same reason: two points selected at once would make Delete ambiguous
      // again, just one lane further down.
      selectedSegmentIds: point === null ? get().selectedSegmentIds : [],
      anchorSegmentId: point === null ? get().anchorSegmentId : null,
      selectedSectionId: point === null ? get().selectedSectionId : null,
    });
  },

  selectSection: (sectionId: string | null) => {
    set({
      selectedSectionId: sectionId,
      // The same rule the other way round: a picked section is what Delete erases,
      // so the blocks and the curve point let go of the key.
      selectedSegmentIds: sectionId === null ? get().selectedSegmentIds : [],
      anchorSegmentId: sectionId === null ? get().anchorSegmentId : null,
      selectedAutomationPoint:
        sectionId === null ? get().selectedAutomationPoint : null,
    });
  },

  clearSelection: () => {
    set({
      selectedBarId: null,
      selectedTrackId: null,
      selectedSegmentIds: [],
      anchorSegmentId: null,
      selectedAutomationPoint: null,
      selectedSectionId: null,
    });
  },
}));

/** The one selected block, or null when zero — or several — are selected. */
export const soleSelectedSegmentId = (state: SelectionState): string | null =>
  state.selectedSegmentIds.length === 1 ? state.selectedSegmentIds[0] : null;
