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
import type { Bar, Note, Track } from '@/types/music';
import { soloContent, TEST_TRACK_ID } from '../helpers/tracks';

/** The instrument the fixture bars' notes belong to. */
const testTrack: Track = {
  id: TEST_TRACK_ID,
  name: 'Piano',
  instrument: 'acoustic_grand_piano',
  volume: 1,
  pan: 0,
  muted: false,
  solo: false,
  visible: true,
};

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
  content: soloContent([], notes),
});

/** 60 BPM so one beat is one second and the arithmetic reads directly. */
const config: PlaybackConfig = {
  bpm: 60,
  timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
  bars: [makeBar(0, [makeNote(60, 0), makeNote(62, 1), makeNote(64, 2), makeNote(65, 3)])],
  tracks: [testTrack],
  loopStart: null,
  loopEnd: null,
  loopEnabled: false,
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
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    class MockAudioContext {
      state = 'suspended';
      destination = node();
      get currentTime() {
        return clock;
      }
      // The instrument pool owns one limiter downstream of every instrument.
      createDynamicsCompressor = () => ({
        ...node(),
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
      });
      createGain = () => ({ ...node(), gain: { value: 1 } });
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
    const looped: PlaybackConfig = { ...config, loopStart: 0, loopEnd: 4, loopEnabled: true };
    const { result } = renderHook(() => usePlayback(looped));
    await startPlayback(result);
    await advance(6);

    // Four notes per pass; running past the end must start a second pass.
    expect(result.current.isPlaying).toBe(true);
    expect(scheduled.length).toBeGreaterThan(4);
    expect(scheduled.filter(n => n.midiNote === 60).length).toBeGreaterThan(1);
  });

  // Editing the timeline used to be inaudible until the next Play, because the note
  // list was snapshotted into the interval closure.
  describe('editing while playing', () => {
    /** Play with a config the test can swap, as the App does on every store change. */
    function renderWithConfig(initial: PlaybackConfig) {
      return renderHook(({ cfg }) => usePlayback(cfg), { initialProps: { cfg: initial } });
    }

    it('plays a note added ahead of the playhead', async () => {
      const { result, rerender } = renderWithConfig(config);
      await startPlayback(result);
      await advance(1);

      // A new bars array is what every store mutation produces.
      rerender({
        cfg: {
          ...config,
          bars: [
            makeBar(0, [
              makeNote(60, 0),
              makeNote(62, 1),
              makeNote(64, 2),
              makeNote(65, 3),
              makeNote(70, 3.5),
            ]),
          ],
        },
      });

      await advance(3);
      expect(scheduled.filter(n => n.midiNote === 70)).toHaveLength(1);
    });

    it('plays the new pitch when a note ahead of the playhead is re-voiced', async () => {
      const { result, rerender } = renderWithConfig(config);
      await startPlayback(result);
      await advance(1);

      rerender({
        cfg: {
          ...config,
          bars: [
            makeBar(0, [makeNote(60, 0), makeNote(62, 1), makeNote(64, 2), makeNote(77, 3)]),
          ],
        },
      });

      await advance(3);
      const pitches = scheduled.map(n => n.midiNote);
      expect(pitches).toContain(77);
      expect(pitches).not.toContain(65);
    });

    // The guard against the obvious way to get this wrong: rebuilding the note list
    // mid-run must not re-dispatch what has already gone to the instrument.
    it('does not replay notes it has already scheduled', async () => {
      const { result, rerender } = renderWithConfig(config);
      await startPlayback(result);
      await advance(2.5);

      rerender({
        cfg: {
          ...config,
          bars: [
            makeBar(0, [
              makeNote(60, 0),
              makeNote(62, 1),
              makeNote(64, 2),
              makeNote(65, 3),
              makeNote(70, 3.5),
            ]),
          ],
        },
      });

      await advance(2);
      for (const pitch of [60, 62, 64, 65, 70]) {
        expect(scheduled.filter(n => n.midiNote === pitch)).toHaveLength(1);
      }
    });
  });

  describe('play range', () => {
    /** Two bars, so a range over the second one has something before it to skip. */
    const twoBars: PlaybackConfig = {
      ...config,
      bars: [
        makeBar(0, [makeNote(60, 0), makeNote(62, 1), makeNote(64, 2), makeNote(65, 3)]),
        makeBar(1, [makeNote(67, 0), makeNote(69, 1), makeNote(71, 2), makeNote(72, 3)]),
      ],
    };
    /** Beats 4–8: the whole of the second bar. */
    const ranged: PlaybackConfig = { ...twoBars, loopStart: 4, loopEnd: 8 };

    it('starts at the range rather than the top of the song', async () => {
      const { result } = renderHook(() => usePlayback(ranged));
      await startPlayback(result);

      expect(result.current.currentTime).toBeCloseTo(4, 5);
      expect(scheduled.map(n => n.midiNote)).toEqual([67]);
    });

    it('stops at the end of the range when repeat is off', async () => {
      const { result } = renderHook(() => usePlayback(ranged));
      await startPlayback(result);
      await advance(5);

      expect(result.current.isPlaying).toBe(false);
      // Back to the range start, ready to hear the same passage again.
      expect(result.current.currentTime).toBeCloseTo(4, 5);
      expect(scheduled.map(n => n.midiNote)).not.toContain(60);
    });

    it('repeats the range instead of stopping when repeat is on', async () => {
      const { result } = renderHook(() => usePlayback({ ...ranged, loopEnabled: true }));
      await startPlayback(result);
      await advance(6);

      expect(result.current.isPlaying).toBe(true);
      expect(scheduled.filter(n => n.midiNote === 67).length).toBeGreaterThan(1);
      expect(scheduled.map(n => n.midiNote)).not.toContain(60);
    });

    it('wraps in beats, not seconds, when a beat is not a second', async () => {
      // At 120 BPM beats 4–8 are seconds 2–4. Reading the bounds as seconds would
      // put the wrap at 6s and the playhead outside the range entirely.
      const { result } = renderHook(() =>
        usePlayback({ ...ranged, bpm: 120, loopEnabled: true })
      );
      await startPlayback(result);
      expect(result.current.currentTime).toBeCloseTo(2, 5);

      await advance(5);

      expect(result.current.isPlaying).toBe(true);
      expect(result.current.currentTime).toBeGreaterThanOrEqual(2);
      expect(result.current.currentTime).toBeLessThanOrEqual(4);
    });

    it('returns to the range start after a stop', async () => {
      const { result } = renderHook(() => usePlayback(ranged));
      await startPlayback(result);
      await advance(1);
      act(() => result.current.stop());

      scheduled.length = 0;
      await act(async () => {
        await result.current.play();
      });

      expect(scheduled.map(n => n.midiNote)).toEqual([67]);
    });
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
