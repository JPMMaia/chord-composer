import { describe, it, expect, beforeEach } from 'vitest';
import { selectionStore } from '@/store/selectionStore';

describe('selectionStore', () => {
  beforeEach(() => {
    selectionStore.getState().clearSelection();
  });

  it('starts with nothing selected', () => {
    expect(selectionStore.getState().selectedBarId).toBeNull();
    expect(selectionStore.getState().selectedSegmentId).toBeNull();
  });

  it('selects a bar', () => {
    selectionStore.getState().selectBar('bar-1');
    expect(selectionStore.getState().selectedBarId).toBe('bar-1');
  });

  it('selects a segment', () => {
    selectionStore.getState().selectSegment('seg-1');
    expect(selectionStore.getState().selectedSegmentId).toBe('seg-1');
  });

  it('clears the segment selection when a different bar is selected', () => {
    selectionStore.getState().selectBar('bar-1');
    selectionStore.getState().selectSegment('seg-1');
    selectionStore.getState().selectBar('bar-2');
    expect(selectionStore.getState().selectedSegmentId).toBeNull();
  });

  it('keeps the segment selection when the same bar is re-selected', () => {
    selectionStore.getState().selectBar('bar-1');
    selectionStore.getState().selectSegment('seg-1');
    selectionStore.getState().selectBar('bar-1');
    expect(selectionStore.getState().selectedSegmentId).toBe('seg-1');
  });

  it('clears both selections', () => {
    selectionStore.getState().selectBar('bar-1');
    selectionStore.getState().selectSegment('seg-1');
    selectionStore.getState().clearSelection();
    expect(selectionStore.getState().selectedBarId).toBeNull();
    expect(selectionStore.getState().selectedSegmentId).toBeNull();
  });
});
