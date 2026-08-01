import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFollowPlayhead } from '@/hooks/useFollowPlayhead';
import { editorStore } from '@/store/editorStore';
import { PIANO_KEYS_WIDTH, PIXELS_PER_BEAT } from '@/utils/constants';

/** A viewport showing 800px of beat axis after the key column. */
const VIEWPORT_WIDTH = 800 + PIANO_KEYS_WIDTH;
const VISIBLE_WIDTH = 800;
const CONTENT_WIDTH = 10000;

const scrollX = () => editorStore.getState().scrollX;

function follow(playheadBeat: number, isPlaying = true) {
  return renderHook(
    ({ beat, playing }: { beat: number; playing: boolean }) => useFollowPlayhead(beat, playing),
    { initialProps: { beat: playheadBeat, playing: isPlaying } }
  );
}

describe('useFollowPlayhead', () => {
  beforeEach(() => {
    editorStore.setState({ scrollX: 0, maxScrollX: 0, viewportWidth: 0 });
    editorStore.getState().setScrollExtent(CONTENT_WIDTH, VIEWPORT_WIDTH);
  });

  it('leaves the view alone while the playhead is on screen', () => {
    follow(4);
    expect(scrollX()).toBe(0);
  });

  it('pages forward when the playhead runs off the right edge', () => {
    const beat = 20; // 1600px, well past the 800px visible span
    follow(beat);

    // The turn puts the playhead a tenth of a screen in, so there is run-up
    // rather than the playhead sitting flush against the edge.
    expect(scrollX()).toBe(beat * PIXELS_PER_BEAT - VISIBLE_WIDTH * 0.1);
  });

  it('pages back when the playhead jumps behind the view', () => {
    editorStore.getState().setScrollX(2000);
    follow(4);

    expect(scrollX()).toBe(4 * PIXELS_PER_BEAT - VISIBLE_WIDTH * 0.1);
  });

  it('does not follow while playback is stopped', () => {
    follow(20, false);
    expect(scrollX()).toBe(0);
  });

  it('starts following as soon as playback begins', () => {
    const { rerender } = follow(20, false);
    expect(scrollX()).toBe(0);

    rerender({ beat: 20, playing: true });
    expect(scrollX()).toBe(20 * PIXELS_PER_BEAT - VISIBLE_WIDTH * 0.1);
  });

  it('does nothing before the viewport has been measured', () => {
    editorStore.setState({ scrollX: 0, maxScrollX: 0, viewportWidth: 0 });
    follow(20);
    expect(scrollX()).toBe(0);
  });

  it('cannot page past the end of the project', () => {
    editorStore.getState().setScrollExtent(1000, VIEWPORT_WIDTH);
    follow(200);

    expect(scrollX()).toBe(editorStore.getState().maxScrollX);
  });
});
