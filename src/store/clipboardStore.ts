import { create } from 'zustand';
import type { ChordSegment } from '@/types/music';
import { editSurface, projectStore } from './projectStore';
import { selectionStore } from './selectionStore';
import { findSegment, getBarStartBeat, laneOf } from '@/engine/timeline';

/**
 * A segment on the clipboard, held as an offset from the group rather than as a
 * bar and a beat within it.
 *
 * Bar-relative coordinates were what made paste unpredictable: an offset only means
 * the same thing when it is re-applied in a bar of the same length at the same
 * point, which a paste somewhere else is precisely not. An offset along the
 * timeline means one thing everywhere, so the group arrives as the shape it left.
 */
export interface CopiedSegment {
  /** Segment data minus `id`, `startBeat` and `lane`, so paste always produces fresh
      blocks whose position comes only from the offsets below. */
  segment: Omit<ChordSegment, 'id' | 'startBeat' | 'lane'> & { lane?: number };
  /** Beats from the group anchor — the earliest onset copied. Always >= 0. */
  offsetBeat: number;
  /** Lanes below the group's topmost lane. Always >= 0. */
  laneOffset: number;
}

interface ClipboardState {
  /** Segments copied, in timeline order. Empty when nothing is copied. */
  segments: CopiedSegment[];
  /** Track id of the source instrument. */
  sourceTrackId: string;
  /** Copy the currently selected segments. No-op when selection is empty. */
  copySegments: () => void;
  /** Clear the clipboard. */
  clear: () => void;
}

export const clipboardStore = create<ClipboardState>((set) => ({
  segments: [],
  sourceTrackId: '',

  copySegments: () => {
    const { selectedSegmentIds, selectedTrackId } = selectionStore.getState();
    if (selectedSegmentIds.length === 0 || !selectedTrackId) return;

    const project = projectStore.getState().project;
    if (!project) return;
    // A selection is made in the phrase editor, so these ids name blocks in the open
    // phrase rather than in the compiled song. There is no instrument left to filter
    // by: a phrase holds one part, and it is the one being copied.
    const surface = editSurface();
    if (!surface) return;

    /** Each selected block on the phrase's absolute beat line. */
    const picked: { segment: CopiedSegment['segment']; beat: number; lane: number }[] = [];

    for (const segmentId of selectedSegmentIds) {
      const loc = findSegment(surface.bars, segmentId);
      if (!loc) continue;

      // Strip `id` so paste always produces fresh segments, and `startBeat` and `lane`
      // so the offsets computed below are the sole source of truth for position — a
      // segment carrying its old coordinates would be a second opinion about where the
      // copy goes, and paste would count the lane twice.
      const { id: _id, startBeat, lane: _lane, ...rest } = loc.segment;
      picked.push({
        segment: rest,
        beat:
          getBarStartBeat(surface.bars, loc.bar.barIndex, project.timeSignature) +
          (typeof startBeat === 'number' ? startBeat : 0),
        lane: laneOf(loc.segment),
      });
    }

    if (picked.length === 0) return;

    // The anchor is the earliest onset and the topmost lane, so the offsets are all
    // non-negative and paste can hang the group off the cursor directly.
    const anchorBeat = Math.min(...picked.map(p => p.beat));
    const anchorLane = Math.min(...picked.map(p => p.lane));

    const copied: CopiedSegment[] = picked.map(p => ({
      segment: p.segment,
      offsetBeat: p.beat - anchorBeat,
      laneOffset: p.lane - anchorLane,
    }));

    // Sorted so the clipboard is deterministic regardless of the order blocks were
    // selected in. Paste no longer depends on it, but a stable clipboard is easier
    // to reason about and to test.
    copied.sort((a, b) => a.offsetBeat - b.offsetBeat || a.laneOffset - b.laneOffset);

    set({ segments: copied, sourceTrackId: selectedTrackId });
  },

  clear: () => {
    set({ segments: [], sourceTrackId: '' });
  },
}));
