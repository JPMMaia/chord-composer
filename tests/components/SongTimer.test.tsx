import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { SongTimer } from '@/components/SongTimer';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';

const readouts = () => ({
  elapsed: screen.getByTestId('song-elapsed').textContent,
  position: screen.getByTestId('song-position').textContent,
  barOffset: screen.getByTestId('bar-elapsed').textContent,
});

const bars = () => projectStore.getState().project!.bars;

describe('SongTimer', () => {
  beforeEach(() => {
    selectionStore.getState().clearSelection();
    projectStore.getState().createProject();
    // Four 4/4 bars, so the assertions below have a bar 3 to land in.
    while (projectStore.getState().project!.bars.length < 4) {
      projectStore.getState().addBar();
    }
    projectStore.getState().setBpm(120);
  });

  /** Hand control of the sampling loop to the test. Returns a "run one frame". */
  function captureFrames() {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    return async () => {
      await act(async () => {
        frames.shift()?.(0);
      });
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the live song position while playing', async () => {
    const frame = captureFrames();

    // 5 s at 120 BPM is beat 10 — bar 3, beat 3, one second past the bar line.
    render(<SongTimer getSongTime={() => 5} isPlaying isPaused={false} />);
    await frame();

    expect(readouts()).toEqual({
      elapsed: '⏱ 0:05.000',
      position: 'Bar 3.3',
      barOffset: '+1.000',
    });
  });

  it('holds the position where playback was paused', async () => {
    const frame = captureFrames();
    selectionStore.getState().selectBar(bars()[0].id);

    const { rerender } = render(
      <SongTimer getSongTime={() => 5} isPlaying isPaused={false} />
    );
    await frame();

    // Pause stops the clock, so the getter would now report the stale 0 that
    // `usePlayback` publishes while not playing — the readout must ignore it.
    rerender(<SongTimer getSongTime={() => 0} isPlaying={false} isPaused />);

    expect(readouts()).toEqual({
      elapsed: '⏱ 0:05.000',
      position: 'Bar 3.3',
      barOffset: '+1.000',
    });
  });

  it('follows the selected bar while stopped', () => {
    selectionStore.getState().selectBar(bars()[2].id);

    render(<SongTimer getSongTime={() => 99} isPlaying={false} isPaused={false} />);

    // The third bar opens at beat 8 — 4 s in — and the clock is not read at all.
    expect(readouts()).toEqual({
      elapsed: '⏱ 0:04.000',
      position: 'Bar 3.1',
      barOffset: '+0.000',
    });
  });

  it('reads as the top of the song with nothing selected', () => {
    render(<SongTimer getSongTime={() => 99} isPlaying={false} isPaused={false} />);

    expect(readouts()).toEqual({
      elapsed: '⏱ 0:00.000',
      position: 'Bar 1.1',
      barOffset: '+0.000',
    });
  });
});
