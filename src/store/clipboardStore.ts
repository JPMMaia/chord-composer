import { create } from 'zustand';
import type { ChordSegment } from '@/types/music';
import { projectStore } from './projectStore';
import { selectionStore } from './selectionStore';
import { findSegment } from '@/engine/timeline';

/**
 * A segment copied to the clipboard, carrying its position relative to its bar.
 */
export interface CopiedSegment {
  /** Segment data minus `id` and `startBeat`, so paste always produces fresh
      blocks and the dedicated `startBeat` field is the sole source of position.
   */
  segment: Omit<ChordSegment, 'id' | 'startBeat'>;
  /** Start beat within the source bar. */
  startBeat: number;
  /** Which bar (0-indexed) this segment came from. */
  barIndex: number;
  /** The first segment's original startBeat, used to offset all segments during paste. */
  baseStartBeat: number;
}

interface ClipboardState {
  /** Segments copied, in project order. Empty when nothing is copied. */
  segments: CopiedSegment[];
  /** Bar index of the rightmost source segment — used as the paste anchor. */
  sourceBarIndex: number;
  /** Track id of the source instrument. */
  sourceTrackId: string;
  /** Rightmost bar of the most recent paste group, for cascade paste. */
  lastPasteBarIndex: number | null;
  /** Track id used for the most recent paste. */
  lastPasteTrackId: string | null;
  /** Copy the currently selected segments. No-op when selection is empty. */
  copySegments: () => void;
  /** Record the anchor after a successful paste so repeated Ctrl+V cascades. */
  setPasteAnchor: (barIndex: number, trackId: string) => void;
  /** Clear the clipboard. */
  clear: () => void;
}

export const clipboardStore = create<ClipboardState>((set) => ({
  segments: [],
  sourceBarIndex: 0,
  sourceTrackId: '',
  lastPasteBarIndex: null,
  lastPasteTrackId: null,

  copySegments: () => {
    const { selectedSegmentIds, selectedTrackId } = selectionStore.getState();
    if (selectedSegmentIds.length === 0 || !selectedTrackId) return;

    const project = projectStore.getState().project;
    if (!project) return;

    const copied: CopiedSegment[] = [];
    let maxBarIndex = 0;

    for (const segmentId of selectedSegmentIds) {
      const loc = findSegment(project.bars, segmentId);
      if (!loc) continue;

      // Only copy segments belonging to the currently selected instrument.
      if (loc.trackId !== selectedTrackId) continue;

      // Strip `id` so paste always produces fresh segments, and strip `startBeat`
      // so the dedicated `CopiedSegment.startBeat` field is the sole source of
      // truth for bar-relative position — the segment object must not carry a
      // stale `startBeat` that would confuse paste offset math.
      const { id: _id, startBeat: _startBeat, ...rest } = loc.segment;
      const startBeat =
        typeof _startBeat === 'number' ? _startBeat : 0;

      copied.push({
        segment: rest,
        startBeat,
        barIndex: loc.bar.barIndex,
        baseStartBeat: 0, // filled in below
      });

      if (loc.bar.barIndex > maxBarIndex) {
        maxBarIndex = loc.bar.barIndex;
      }
    }

    // Sort by project order (bar index then start beat) so the clipboard is
    // deterministic regardless of selection order.
    copied.sort((a, b) => a.barIndex - b.barIndex || a.startBeat - b.startBeat);

    if (copied.length === 0) return;

    // Anchor for offset: the first segment's original startBeat so paste
    // can shift everything relative to where the cursor lands.
    copied[0].baseStartBeat = copied[0].startBeat;

    set({
      segments: copied,
      sourceBarIndex: maxBarIndex,
      sourceTrackId: selectedTrackId,
      // Reset paste anchor on new copy so first paste after copy lands adjacent
      // to the source rather than chasing a stale anchor.
      lastPasteBarIndex: null,
      lastPasteTrackId: null,
    });
  },

  setPasteAnchor: (barIndex: number, trackId: string) => {
    set({ lastPasteBarIndex: barIndex, lastPasteTrackId: trackId });
  },

  clear: () => {
    set({
      segments: [],
      sourceBarIndex: 0,
      sourceTrackId: '',
      lastPasteBarIndex: null,
      lastPasteTrackId: null,
    });
  },
}));
