import { create } from 'zustand';

interface SelectionState {
  /** Bar whose scale drives the palette and the properties panel. */
  selectedBarId: string | null;
  /** Segment shown in the inspector, if any. */
  selectedSegmentId: string | null;
  selectBar: (barId: string | null) => void;
  selectSegment: (segmentId: string | null) => void;
  clearSelection: () => void;
}

/**
 * Editor selection, kept out of `projectStore` because it is view state: it is
 * never saved, never exported, and survives no reload.
 */
export const selectionStore = create<SelectionState>((set, get) => ({
  selectedBarId: null,
  selectedSegmentId: null,

  selectBar: (barId: string | null) => {
    // Moving to a different bar leaves any selected segment off-screen in the
    // inspector, so drop it; re-selecting the same bar is a no-op for it.
    const changed = get().selectedBarId !== barId;
    set({ selectedBarId: barId, ...(changed ? { selectedSegmentId: null } : {}) });
  },

  selectSegment: (segmentId: string | null) => {
    set({ selectedSegmentId: segmentId });
  },

  clearSelection: () => {
    set({ selectedBarId: null, selectedSegmentId: null });
  },
}));
