import { describe, it, expect, beforeEach } from 'vitest';
import { editorStore } from '@/store/editorStore';
import { DEFAULT_SNAP_BEATS, SNAP_OPTIONS } from '@/engine/timeline';

describe('editorStore', () => {
  beforeEach(() => {
    editorStore.setState({
      snapBeats: DEFAULT_SNAP_BEATS,
      scrollX: 0,
      maxScrollX: 0,
      viewportWidth: 0,
    });
  });

  it('starts on the default snap resolution', () => {
    expect(editorStore.getState().snapBeats).toBe(DEFAULT_SNAP_BEATS);
  });

  it('accepts every offered snap resolution', () => {
    for (const option of SNAP_OPTIONS) {
      editorStore.getState().setSnapBeats(option.beats);
      expect(editorStore.getState().snapBeats).toBe(option.beats);
    }
  });

  it('ignores a resolution that is not on the menu', () => {
    // Guards against a stale <select> value silently disabling snapping.
    editorStore.getState().setSnapBeats(0);
    editorStore.getState().setSnapBeats(1.7);
    expect(editorStore.getState().snapBeats).toBe(DEFAULT_SNAP_BEATS);
  });

  describe('shared horizontal scroll', () => {
    it('starts unscrolled', () => {
      expect(editorStore.getState().scrollX).toBe(0);
      expect(editorStore.getState().maxScrollX).toBe(0);
    });

    it('derives the scroll limit from the content and viewport widths', () => {
      editorStore.getState().setScrollExtent(2000, 800);
      expect(editorStore.getState().maxScrollX).toBe(1200);
      expect(editorStore.getState().viewportWidth).toBe(800);
    });

    it('has nowhere to scroll when the content fits', () => {
      editorStore.getState().setScrollExtent(400, 800);
      expect(editorStore.getState().maxScrollX).toBe(0);
    });

    it('clamps the offset to the scrollable range', () => {
      editorStore.getState().setScrollExtent(2000, 800);

      editorStore.getState().setScrollX(-50);
      expect(editorStore.getState().scrollX).toBe(0);

      editorStore.getState().setScrollX(5000);
      expect(editorStore.getState().scrollX).toBe(1200);
    });

    it('pulls the view back when the content shrinks under it', () => {
      // Removing bars or narrowing the window must not leave the view parked
      // past the end of the project, showing nothing.
      editorStore.getState().setScrollExtent(2000, 800);
      editorStore.getState().setScrollX(1200);

      editorStore.getState().setScrollExtent(1000, 800);
      expect(editorStore.getState().scrollX).toBe(200);
    });

    it('falls back to the start on a non-finite offset rather than poisoning the axis', () => {
      editorStore.getState().setScrollExtent(2000, 800);
      editorStore.getState().setScrollX(400);
      editorStore.getState().setScrollX(Number.NaN);
      expect(editorStore.getState().scrollX).toBe(0);
    });
  });
});
