import { describe, it, expect, beforeEach } from 'vitest';
import { editorStore } from '@/store/editorStore';
import { DEFAULT_SNAP_BEATS, SNAP_OPTIONS } from '@/engine/timeline';

describe('editorStore', () => {
  beforeEach(() => {
    editorStore.setState({ snapBeats: DEFAULT_SNAP_BEATS });
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
});
