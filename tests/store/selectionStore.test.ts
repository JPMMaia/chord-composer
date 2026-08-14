import { describe, it, expect, beforeEach } from 'vitest';
import { selectionStore, soleSelectedSegmentId } from '@/store/selectionStore';
import { laneKey, VOLUME_LANE_KEY } from '@/engine/parameterAutomation';

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

  describe('automation point selection', () => {
    const volume = (index: number) => ({ laneKey: VOLUME_LANE_KEY, index });

    it('starts with no point selected', () => {
      expect(state().selectedAutomationPoint).toBeNull();
    });

    it('selects and releases a point', () => {
      state().selectAutomationPoint(volume(2));
      expect(state().selectedAutomationPoint).toEqual(volume(2));

      state().selectAutomationPoint(null);
      expect(state().selectedAutomationPoint).toBeNull();
    });

    // The whole reason the selection carries a lane key: an index alone cannot
    // say which of an instrument's stacked curves it counts into.
    it('remembers which lane the point was picked in', () => {
      state().selectAutomationPoint({ laneKey: laneKey({ kind: 'param', paramId: 42 }), index: 1 });

      expect(state().selectedAutomationPoint).toEqual({ laneKey: 'param:42', index: 1 });
    });

    it('replaces a point picked in another lane rather than holding both', () => {
      state().selectAutomationPoint(volume(3));
      state().selectAutomationPoint({ laneKey: laneKey({ kind: 'cc', controller: 7 }), index: 0 });

      expect(state().selectedAutomationPoint).toEqual({ laneKey: 'cc:7', index: 0 });
    });

    // Blocks and points are two answers to one question — what does Delete act on.
    it('drops the block selection when a point is picked', () => {
      state().selectSegment('seg-1');
      state().selectAutomationPoint(volume(0));

      expect(state().selectedSegmentIds).toEqual([]);
      expect(state().anchorSegmentId).toBeNull();
      expect(state().selectedAutomationPoint).toEqual(volume(0));
    });

    it('drops the point when a block is picked', () => {
      state().selectAutomationPoint(volume(0));
      state().selectSegment('seg-1');

      expect(state().selectedAutomationPoint).toBeNull();
      expect(state().selectedSegmentIds).toEqual(['seg-1']);
    });

    it('drops the point when blocks are set as a group', () => {
      state().selectAutomationPoint(volume(0));
      state().setSelectedSegments(['seg-1', 'seg-2']);

      expect(state().selectedAutomationPoint).toBeNull();
    });

    it('drops the point when a block is toggled in', () => {
      state().selectAutomationPoint(volume(0));
      state().toggleSegment('seg-1');

      expect(state().selectedAutomationPoint).toBeNull();
    });

    // Releasing a point must not also wipe a block selection made since.
    it('leaves the block selection alone when the point is merely released', () => {
      state().selectSegment('seg-1');
      state().selectAutomationPoint(null);

      expect(state().selectedSegmentIds).toEqual(['seg-1']);
      expect(state().anchorSegmentId).toBe('seg-1');
    });

    it('drops the point when the instrument changes, its curves going with it', () => {
      state().selectTrack('track-1');
      state().selectAutomationPoint(volume(1));
      state().selectTrack('track-2');

      expect(state().selectedAutomationPoint).toBeNull();
    });

    it('drops the point on a full clear', () => {
      state().selectAutomationPoint(volume(1));
      state().clearSelection();

      expect(state().selectedAutomationPoint).toBeNull();
    });
  });

  describe('section selection', () => {
    it('starts with no section selected', () => {
      expect(state().selectedSectionId).toBeNull();
    });

    it('selects and releases a section', () => {
      state().selectSection('sec-1');
      expect(state().selectedSectionId).toBe('sec-1');

      state().selectSection(null);
      expect(state().selectedSectionId).toBeNull();
    });

    // A third answer to the same question — what does Delete act on.
    it('drops the block selection and the point when a section is picked', () => {
      state().selectSegment('seg-1');
      state().selectAutomationPoint({ laneKey: VOLUME_LANE_KEY, index: 0 });
      state().selectSection('sec-1');

      expect(state().selectedSegmentIds).toEqual([]);
      expect(state().anchorSegmentId).toBeNull();
      expect(state().selectedAutomationPoint).toBeNull();
    });

    it('drops the section when a block or a point is picked', () => {
      state().selectSection('sec-1');
      state().selectSegment('seg-1');
      expect(state().selectedSectionId).toBeNull();

      state().selectSection('sec-1');
      state().setSelectedSegments(['seg-1', 'seg-2']);
      expect(state().selectedSectionId).toBeNull();

      state().selectSection('sec-1');
      state().toggleSegment('seg-3');
      expect(state().selectedSectionId).toBeNull();

      state().selectSection('sec-1');
      state().selectAutomationPoint({ laneKey: VOLUME_LANE_KEY, index: 0 });
      expect(state().selectedSectionId).toBeNull();
    });

    // Releasing a section must not also wipe a block selection made since.
    it('leaves the block selection alone when the section is merely released', () => {
      state().selectSegment('seg-1');
      state().selectSection(null);

      expect(state().selectedSegmentIds).toEqual(['seg-1']);
      expect(state().anchorSegmentId).toBe('seg-1');
    });

    it('drops the section on a full clear', () => {
      state().selectSection('sec-1');
      state().clearSelection();

      expect(state().selectedSectionId).toBeNull();
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
