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
 */
export const selectionStore = create<SelectionState>((set, get) => ({
  selectedBarId: null,
  selectedTrackId: null,
  selectedSegmentIds: [],
  anchorSegmentId: null,

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
    set({ selectedTrackId: trackId, selectedSegmentIds: [], anchorSegmentId: null });
  },

  selectSegment: (segmentId: string | null) => {
    set({
      selectedSegmentIds: segmentId ? [segmentId] : [],
      anchorSegmentId: segmentId,
    });
  },

  setSelectedSegments: (segmentIds: string[]) => {
    set({ selectedSegmentIds: [...new Set(segmentIds)] });
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
    });
  },

  clearSegmentSelection: () => {
    set({ selectedSegmentIds: [], anchorSegmentId: null });
  },

  clearSelection: () => {
    set({
      selectedBarId: null,
      selectedTrackId: null,
      selectedSegmentIds: [],
      anchorSegmentId: null,
    });
  },
}));

/** The one selected block, or null when zero — or several — are selected. */
export const soleSelectedSegmentId = (state: SelectionState): string | null =>
  state.selectedSegmentIds.length === 1 ? state.selectedSegmentIds[0] : null;
