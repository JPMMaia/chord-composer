import { describe, it, expect, beforeEach } from 'vitest';
import { clipboardStore } from '@/store/clipboardStore';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import type { ChordSegment } from '@/types/music';
import { addEditableBar, editableBars, openTestPhrase } from '../helpers/phrases';

const state = () => projectStore.getState();
const trackId = (): string => state().project!.tracks[0].id;

/** A phrase `bars` bars long, open in the editor, on a project's only instrument. */
function phrase(bars: number): void {
  state().resetProject();
  state().createProject();
  for (let i = 0; i < bars; i++) addEditableBar();
  selectionStore.getState().selectTrack(trackId());
  openTestPhrase(trackId(), bars);
}

/** Put a chord in a bar and hand back its id. */
function place(barIndex: number, startBeat: number, id: string, lane?: number): string {
  const segment: ChordSegment = {
    id,
    kind: 'chord',
    root: 'C',
    quality: 'major',
    duration: 1,
    lane,
  };
  state().insertSegment(editableBars()[barIndex].id, startBeat, segment, trackId());
  return id;
}

describe('clipboardStore', () => {
  beforeEach(() => {
    clipboardStore.getState().clear();
  });

  it('copies nothing when the selection is empty', () => {
    phrase(1);
    place(0, 0, 'a');
    selectionStore.getState().clearSelection();

    clipboardStore.getState().copySegments();
    expect(clipboardStore.getState().segments).toEqual([]);
  });

  /**
   * Offsets are measured along the timeline, not within a bar — which is what lets
   * paste put the group down somewhere else without re-spacing it.
   */
  it('measures offsets from the earliest block, across bar lines', () => {
    phrase(3);
    place(0, 2, 'a');
    place(1, 1, 'b');
    place(2, 0, 'c');
    selectionStore.getState().setSelectedSegments(['a', 'b', 'c']);

    clipboardStore.getState().copySegments();

    // a sits at beat 2, b at 5, c at 8.
    expect(clipboardStore.getState().segments.map(s => s.offsetBeat)).toEqual([0, 3, 6]);
    expect(clipboardStore.getState().sourceTrackId).toBe(trackId());
  });

  it('orders the clipboard by position however the selection was made', () => {
    phrase(2);
    place(0, 0, 'first');
    place(1, 0, 'second');
    selectionStore.getState().setSelectedSegments(['second', 'first']);

    clipboardStore.getState().copySegments();

    expect(clipboardStore.getState().segments.map(s => s.offsetBeat)).toEqual([0, 4]);
  });

  /**
   * `laneOffset` is the only record of a block's lane. Leaving the original on the
   * segment as well would have paste count it twice.
   */
  it('measures lanes from the topmost one copied, and strips the original', () => {
    phrase(1);
    place(0, 0, 'low', 1);
    place(0, 0, 'high', 2);
    selectionStore.getState().setSelectedSegments(['low', 'high']);

    clipboardStore.getState().copySegments();

    const copied = clipboardStore.getState().segments;
    expect(copied.map(s => s.laneOffset)).toEqual([0, 1]);
    expect(copied.every(s => s.segment.lane === undefined)).toBe(true);
  });

  it('strips ids and positions so paste writes fresh blocks', () => {
    phrase(1);
    place(0, 1, 'a');
    selectionStore.getState().selectSegment('a');

    clipboardStore.getState().copySegments();

    const [copied] = clipboardStore.getState().segments;
    expect('id' in copied.segment).toBe(false);
    expect('startBeat' in copied.segment).toBe(false);
    expect(copied.offsetBeat).toBe(0);
  });
});
