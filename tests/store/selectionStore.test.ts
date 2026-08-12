import { describe, it, expect, beforeEach } from 'vitest';
import { selectionStore, soleSelectedSegmentId } from '@/store/selectionStore';

const state = () => selectionStore.getState();

describe('selectionStore', () => {
  beforeEach(() => {
    state().clearSelection();
  });

  it('starts with nothing selected', () => {
    expect(state().selectedBarId).toBeNull();
    expect(state().selectedSegmentIds).toEqual([]);
  });

  it('selects a bar', () => {
    state().selectBar('bar-1');
    expect(state().selectedBarId).toBe('bar-1');
  });

  it('selects a segment, replacing whatever was selected', () => {
    state().setSelectedSegments(['seg-1', 'seg-2']);
    state().selectSegment('seg-3');
    expect(state().selectedSegmentIds).toEqual(['seg-3']);
  });

  it('keeps the segment selection when a different bar is selected', () => {
    // A Ctrl- or Shift-click selection spans bars, so moving the bar cursor must
    // not disturb it.
    state().selectBar('bar-1');
    state().setSelectedSegments(['seg-1', 'seg-2']);
    state().selectBar('bar-2');
    expect(state().selectedSegmentIds).toEqual(['seg-1', 'seg-2']);
  });

  it('toggles a segment in and back out of the selection', () => {
    state().selectSegment('seg-1');
    state().toggleSegment('seg-2');
    expect(state().selectedSegmentIds).toEqual(['seg-1', 'seg-2']);

    state().toggleSegment('seg-1');
    expect(state().selectedSegmentIds).toEqual(['seg-2']);
  });

  it('never holds the same segment twice', () => {
    state().setSelectedSegments(['seg-1', 'seg-1', 'seg-2']);
    expect(state().selectedSegmentIds).toEqual(['seg-1', 'seg-2']);
  });

  it('anchors a range at the last segment picked on its own', () => {
    state().selectSegment('seg-1');
    expect(state().anchorSegmentId).toBe('seg-1');

    state().toggleSegment('seg-3');
    expect(state().anchorSegmentId).toBe('seg-3');

    // Removing a block is a poor place to measure the next range from.
    state().toggleSegment('seg-3');
    expect(state().anchorSegmentId).toBe('seg-3');
  });

  it('clears the segment selection without touching the bar', () => {
    state().selectBar('bar-1');
    state().setSelectedSegments(['seg-1', 'seg-2']);
    state().clearSegmentSelection();
    expect(state().selectedSegmentIds).toEqual([]);
    expect(state().anchorSegmentId).toBeNull();
    expect(state().selectedBarId).toBe('bar-1');
  });

  it('clears both selections', () => {
    state().selectBar('bar-1');
    state().selectSegment('seg-1');
    state().clearSelection();
    expect(state().selectedBarId).toBeNull();
    expect(state().selectedSegmentIds).toEqual([]);
  });

  describe('volume point selection', () => {
    it('starts with no point selected', () => {
      expect(state().selectedVolumePointIndex).toBeNull();
    });

    it('selects and releases a point', () => {
      state().selectVolumePoint(2);
      expect(state().selectedVolumePointIndex).toBe(2);

      state().selectVolumePoint(null);
      expect(state().selectedVolumePointIndex).toBeNull();
    });

    // Blocks and points are two answers to one question — what does Delete act on.
    it('drops the block selection when a point is picked', () => {
      state().selectSegment('seg-1');
      state().selectVolumePoint(0);

      expect(state().selectedSegmentIds).toEqual([]);
      expect(state().anchorSegmentId).toBeNull();
      expect(state().selectedVolumePointIndex).toBe(0);
    });

    it('drops the point when a block is picked', () => {
      state().selectVolumePoint(0);
      state().selectSegment('seg-1');

      expect(state().selectedVolumePointIndex).toBeNull();
      expect(state().selectedSegmentIds).toEqual(['seg-1']);
    });

    it('drops the point when blocks are set as a group', () => {
      state().selectVolumePoint(0);
      state().setSelectedSegments(['seg-1', 'seg-2']);

      expect(state().selectedVolumePointIndex).toBeNull();
    });

    it('drops the point when a block is toggled in', () => {
      state().selectVolumePoint(0);
      state().toggleSegment('seg-1');

      expect(state().selectedVolumePointIndex).toBeNull();
    });

    // Releasing a point must not also wipe a block selection made since.
    it('leaves the block selection alone when the point is merely released', () => {
      state().selectSegment('seg-1');
      state().selectVolumePoint(null);

      expect(state().selectedSegmentIds).toEqual(['seg-1']);
      expect(state().anchorSegmentId).toBe('seg-1');
    });

    it('drops the point when the instrument changes, its curve going with it', () => {
      state().selectTrack('track-1');
      state().selectVolumePoint(1);
      state().selectTrack('track-2');

      expect(state().selectedVolumePointIndex).toBeNull();
    });

    it('drops the point on a full clear', () => {
      state().selectVolumePoint(1);
      state().clearSelection();

      expect(state().selectedVolumePointIndex).toBeNull();
    });
  });

  it('reports a sole selection only when exactly one segment is selected', () => {
    expect(soleSelectedSegmentId(state())).toBeNull();

    state().selectSegment('seg-1');
    expect(soleSelectedSegmentId(selectionStore.getState())).toBe('seg-1');

    state().toggleSegment('seg-2');
    expect(soleSelectedSegmentId(selectionStore.getState())).toBeNull();
  });
});
