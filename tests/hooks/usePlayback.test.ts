import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';

/**
 * The regression suite for the reported "Play makes noise" bug.
 *
 * Playback used to hand every note in the project to the instrument at once, at
 * `currentTime`. The mock clock here *advances*, which is the property the old
 * soundfontPlayer test lacked — with `currentTime` pinned at 0 nothing could tell
 * a correctly scheduled note from one dumped on the spot.
 */

interface Scheduled {
  midiNote: number;
  velocity: number;
  when: number;
  duration: number;
}

const scheduled: Scheduled[] = [];
const stopAll = vi.fn();
let loadResolve: () => void;
let loadPromise: Promise<void>;
let clock = 0;

vi.mock('@/engine/smplrPiano', () => {
  class MockPiano {
    readonly name = 'Test Piano';
    private loaded = false;

    now() {
      return clock;
    }
    get isLoaded() {
      return this.loaded;
    }
    load() {
      return loadPromise.then(() => {
        this.loaded = true;
      });
    }
    schedule(note: Scheduled) {
      scheduled.push(note);
    }
    stopAll() {
      stopAll();
    }
    setVolume() {}
    dispose() {}
  }

  return { MASTER_GAIN: 0.7, SmplrPianoInstrument: MockPiano };
});

import { usePlayback } from '@/hooks/usePlayback';
import { TICK_MS, LOOKAHEAD_SECONDS } from '@/engine/scheduler';
import type { PlaybackConfig } from '@/engine/playback';
import type { Bar, Note } from '@/types/music';

const makeNote = (pitch: number, startBeat: number): Note => ({
  id: `n-${pitch}-${startBeat}`,
  pitch,
  startBeat,
  duration: 1,
  velocity: 100,
});

const makeBar = (barIndex: number, notes: Note[]): Bar => ({
  id: `bar-${barIndex}`,
  barIndex,
  timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
  scale: { root: 'C', type: 'major' },
  chords: [],
  notes,
});

/** 60 BPM so one beat is one second and the arithmetic reads directly. */
const config: PlaybackConfig = {
  bpm: 60,
  timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
  bars: [makeBar(0, [makeNote(60, 0), makeNote(62, 1), makeNote(64, 2), makeNote(65, 3)])],
  tracks: [],
  loopStart: null,
  loopEnd: null,
};

/** Advance the audio clock and let the scheduling interval catch up. */
async function advance(seconds: number) {
  const ticks = Math.round((seconds * 1000) / TICK_MS);
  for (let i = 0; i < ticks; i++) {
    clock += TICK_MS / 1000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TICK_MS);
    });
  }
}

describe('usePlayback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    scheduled.length = 0;
    stopAll.mockClear();
    clock = 0;
    loadPromise = new Promise<void>(resolve => {
      loadResolve = resolve;
    });

    // jsdom has no Web Audio; the hook only needs a constructible, resumable
    // context whose clock advances.
    class MockAudioContext {
      state = 'suspended';
      get currentTime() {
        return clock;
      }
      resume = async () => {
        this.state = 'running';
      };
      close = async () => undefined;
    }
    vi.stubGlobal('AudioContext', MockAudioContext);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Play, resolving the sample load so playback actually begins. */
  async function startPlayback(result: { current: ReturnType<typeof usePlayback> }) {
    let playing: Promise<void>;
    await act(async () => {
      playing = result.current.play();
      loadResolve();
      await playing;
    });
  }

  it('waits for the samples before scheduling anything', async () => {
    const { result } = renderHook(() => usePlayback(config));

    let playing: Promise<void>;
    // Let play() get as far as awaiting the load, without resolving it.
    await act(async () => {
      playing = result.current.play();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Load still pending: nothing may be scheduled yet.
    expect(scheduled).toHaveLength(0);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      loadResolve();
      await playing;
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isPlaying).toBe(true);
  });

  it('does not dump the whole project at once', async () => {
    const { result } = renderHook(() => usePlayback(config));
    await startPlayback(result);

    // Notes sit at 0s, 1s, 2s and 3s. The first pass may only reach the horizon.
    expect(scheduled.length).toBeLessThan(4);
    expect(scheduled.map(n => n.midiNote)).toEqual([60]);
  });

  it('schedules each note at its own future time, in order', async () => {
    const { result } = renderHook(() => usePlayback(config));
    await startPlayback(result);
    await advance(4);

    expect(scheduled.map(n => n.midiNote)).toEqual([60, 62, 64, 65]);

    // One beat is one second at 60 BPM, so the notes must be a second apart.
    const times = scheduled.map(n => n.when);
    expect(new Set(times).size).toBe(times.length);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeCloseTo(1, 5);
    }
  });

  it('schedules notes ahead of the clock, never behind it', async () => {
    const { result } = renderHook(() => usePlayback(config));
    await startPlayback(result);

    const clockWhenScheduled = clock;
    expect(scheduled[0].when).toBeGreaterThanOrEqual(clockWhenScheduled);
    expect(scheduled[0].when).toBeLessThanOrEqual(clockWhenScheduled + LOOKAHEAD_SECONDS);
  });

  it('carries velocity and duration through to the instrument', async () => {
    const { result } = renderHook(() => usePlayback(config));
    await startPlayback(result);

    expect(scheduled[0]).toMatchObject({ midiNote: 60, velocity: 100, duration: 1 });
  });

  it('advances currentTime as the clock runs', async () => {
    const { result } = renderHook(() => usePlayback(config));
    await startPlayback(result);
    expect(result.current.currentTime).toBeCloseTo(0, 5);

    await advance(2);
    expect(result.current.currentTime).toBeGreaterThan(1.5);
  });

  it('stops at the end of the project when not looping', async () => {
    const { result } = renderHook(() => usePlayback(config));
    await startPlayback(result);
    await advance(5);

    expect(result.current.isPlaying).toBe(false);
    expect(result.current.currentTime).toBe(0);
  });

  it('pause cuts sound and freezes the position', async () => {
    const { result } = renderHook(() => usePlayback(config));
    await startPlayback(result);
    await advance(1.5);

    act(() => result.current.pause());

    expect(stopAll).toHaveBeenCalled();
    expect(result.current.isPaused).toBe(true);
    expect(result.current.isPlaying).toBe(false);

    const scheduledAtPause = scheduled.length;
    await advance(1);
    expect(scheduled).toHaveLength(scheduledAtPause);
  });

  it('resumes from where it paused rather than restarting', async () => {
    const { result } = renderHook(() => usePlayback(config));
    await startPlayback(result);
    await advance(2.5);

    act(() => result.current.pause());
    const beforeResume = scheduled.length;

    await act(async () => {
      await result.current.play();
    });

    // Picking up mid-project must not re-schedule the notes already played.
    expect(result.current.currentTime).toBeGreaterThan(2);
    await advance(1.5);
    const replayed = scheduled.slice(beforeResume).map(n => n.midiNote);
    expect(replayed).not.toContain(60);
  });

  it('stop silences and rewinds', async () => {
    const { result } = renderHook(() => usePlayback(config));
    await startPlayback(result);
    await advance(1.5);

    act(() => result.current.stop());

    expect(stopAll).toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.isPaused).toBe(false);
    expect(result.current.currentTime).toBe(0);
  });

  it('replays from the start after a stop', async () => {
    const { result } = renderHook(() => usePlayback(config));
    await startPlayback(result);
    await advance(2);
    act(() => result.current.stop());

    scheduled.length = 0;
    await act(async () => {
      await result.current.play();
    });

    expect(scheduled.map(n => n.midiNote)).toEqual([60]);
  });

  it('wraps without a gap when looping', async () => {
    const looped: PlaybackConfig = { ...config, loopStart: 0, loopEnd: 4 };
    const { result } = renderHook(() => usePlayback(looped));
    await startPlayback(result);
    await advance(6);

    // Four notes per pass; running past the end must start a second pass.
    expect(result.current.isPlaying).toBe(true);
    expect(scheduled.length).toBeGreaterThan(4);
    expect(scheduled.filter(n => n.midiNote === 60).length).toBeGreaterThan(1);
  });

  it('ignores a second Play while the first is still loading', async () => {
    const { result } = renderHook(() => usePlayback(config));

    let first: Promise<void>;
    act(() => {
      first = result.current.play();
      // Second press lands mid-load and must be dropped, not queue another start.
      void result.current.play();
    });

    await act(async () => {
      loadResolve();
      await first;
    });

    expect(scheduled.map(n => n.midiNote)).toEqual([60]);
  });
});
