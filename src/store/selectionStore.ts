import { create } from 'zustand';

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
   * Index of the selected point in the automation lane, or null.
   *
   * An index rather than an id because a point has none: it is a beat and a level,
   * and the store keeps the list sorted. Valid only against the selected
   * instrument's curve, which is the only one the lane ever shows.
   */
  selectedVolumePointIndex: number | null;
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
  /** Pick a point in the automation lane, or clear the pick with null. */
  selectVolumePoint: (index: number | null) => void;
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
  selectedVolumePointIndex: null,
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
    // The point index goes too: it names a position in the curve of the instrument
    // being left, and the lane is about to draw a different one.
    set({
      selectedTrackId: trackId,
      selectedSegmentIds: [],
      anchorSegmentId: null,
      selectedVolumePointIndex: null,
    });
  },

  selectSegment: (segmentId: string | null) => {
    set({
      selectedSegmentIds: segmentId ? [segmentId] : [],
      anchorSegmentId: segmentId,
      selectedVolumePointIndex: null,
      selectedSectionId: null,
    });
  },

  setSelectedSegments: (segmentIds: string[]) => {
    set({
      selectedSegmentIds: [...new Set(segmentIds)],
      selectedVolumePointIndex: null,
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
      selectedVolumePointIndex: null,
      selectedSectionId: null,
    });
  },

  clearSegmentSelection: () => {
    set({ selectedSegmentIds: [], anchorSegmentId: null });
  },

  selectVolumePoint: (index: number | null) => {
    set({
      selectedVolumePointIndex: index,
      // Picking a point drops the blocks, so Delete has exactly one meaning.
      selectedSegmentIds: index === null ? get().selectedSegmentIds : [],
      anchorSegmentId: index === null ? get().anchorSegmentId : null,
      selectedSectionId: index === null ? get().selectedSectionId : null,
    });
  },

  selectSection: (sectionId: string | null) => {
    set({
      selectedSectionId: sectionId,
      // The same rule the other way round: a picked section is what Delete erases,
      // so the blocks and the curve point let go of the key.
      selectedSegmentIds: sectionId === null ? get().selectedSegmentIds : [],
      anchorSegmentId: sectionId === null ? get().anchorSegmentId : null,
      selectedVolumePointIndex:
        sectionId === null ? get().selectedVolumePointIndex : null,
    });
  },

  clearSelection: () => {
    set({
      selectedBarId: null,
      selectedTrackId: null,
      selectedSegmentIds: [],
      anchorSegmentId: null,
      selectedVolumePointIndex: null,
      selectedSectionId: null,
    });
  },
}));

/** The one selected block, or null when zero — or several — are selected. */
export const soleSelectedSegmentId = (state: SelectionState): string | null =>
  state.selectedSegmentIds.length === 1 ? state.selectedSegmentIds[0] : null;
