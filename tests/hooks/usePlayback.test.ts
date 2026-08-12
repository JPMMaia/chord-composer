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

/** A level change asked of the instrument: pinned now, or ramped to arrive at `when`. */
interface VolumeCall {
  kind: 'set' | 'ramp';
  volume: number;
  when?: number;
}

const scheduled: Scheduled[] = [];
const volumeCalls: VolumeCall[] = [];
const stopAll = vi.fn();
let loadResolve: () => void;
let loadPromise: Promise<void>;
let clock = 0;
/**
 * Whether the instrument built for the next run can schedule a ramp.
 *
 * Read at construction, so a test sets it before Play. False is the VST3 shape:
 * `Instrument.rampVolume` is optional, and that backend does not implement it.
 */
let supportsRamp = true;

vi.mock('@/engine/smplrPiano', () => {
  class MockPiano {
    readonly name = 'Test Piano';
    private loaded = false;

    constructor() {
      if (supportsRamp) {
        (this as unknown as { rampVolume: (v: number, w: number) => void }).rampVolume = (
          volume,
          when
        ) => {
          volumeCalls.push({ kind: 'ramp', volume, when });
        };
      }
    }

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
    setVolume(volume: number) {
      volumeCalls.push({ kind: 'set', volume });
    }
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
    volumeCalls.length = 0;
    supportsRamp = true;
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

  describe('getSongTime', () => {
    it('reads the clock between ticks, not the last published position', async () => {
      const { result } = renderHook(() => usePlayback(config));
      await startPlayback(result);
      await advance(1);

      // Move the audio clock without letting a scheduling pass run: this is exactly
      // what a keypress lands in the middle of.
      clock += 0.037;

      expect(result.current.getSongTime()).toBeCloseTo(1.037, 5);
      expect(result.current.currentTime).toBeCloseTo(1, 5);
    });

    it('reports the frozen position while stopped', async () => {
      const { result } = renderHook(() => usePlayback(config));
      expect(result.current.getSongTime()).toBe(0);

      await startPlayback(result);
      await advance(1.5);
      act(() => result.current.pause());
      clock += 5;

      expect(result.current.getSongTime()).toBeCloseTo(1.5, 5);
    });

    it('follows the loop back to the range start on a wrap', async () => {
      const looped: PlaybackConfig = { ...config, loopStart: 0, loopEnd: 4, loopEnabled: true };
      const { result } = renderHook(() => usePlayback(looped));
      await startPlayback(result);
      await advance(4.5);

      // Past the seam the reading is back near the top of the range, not at 4.5 —
      // the wrap shifts the reference rather than resetting it.
      expect(result.current.getSongTime()).toBeLessThan(1);
      expect(result.current.isPlaying).toBe(true);
    });
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

  describe('volume automation', () => {
    /** A fade from full to silence across beats 1–3, i.e. seconds 1–3 at 60 BPM. */
    const fading: PlaybackConfig = {
      ...config,
      tracks: [
        {
          ...testTrack,
          volume: 0.8,
          volumeAutomation: [
            { beat: 1, value: 1 },
            { beat: 3, value: 0 },
          ],
        },
      ],
    };

    const ramps = () => volumeCalls.filter(c => c.kind === 'ramp');

    it('does not touch the level at all when there is no curve', async () => {
      const { result } = renderHook(() => usePlayback(config));
      await startPlayback(result);
      await advance(3);

      // The pool applied the static volume when it built the instrument; nothing
      // after that has any business moving it.
      expect(ramps()).toHaveLength(0);
      expect(volumeCalls.filter(c => c.kind === 'set')).toHaveLength(1);
    });

    it('schedules one ramp per breakpoint, at its own clock time', async () => {
      const { result } = renderHook(() => usePlayback(fading));
      await startPlayback(result);
      await advance(4);

      expect(ramps()).toEqual([
        { kind: 'ramp', volume: 1, when: 1 },
        { kind: 'ramp', volume: 0, when: 3 },
      ]);
    });

    it('does not re-schedule a breakpoint it has already handed over', async () => {
      const { result } = renderHook(() => usePlayback(fading));
      await startPlayback(result);
      // Many passes cross each breakpoint's look-ahead window; each must be sent once.
      await advance(3.9);

      expect(ramps().filter(c => c.volume === 1)).toHaveLength(1);
      expect(ramps().filter(c => c.volume === 0)).toHaveLength(1);
    });

    it('schedules no further ahead than the look-ahead window', async () => {
      const { result } = renderHook(() => usePlayback(fading));
      await startPlayback(result);

      // The first pass sits at clock 0 and the first breakpoint is a whole second
      // out, well past the horizon.
      expect(ramps()).toHaveLength(0);
    });

    it('pins the interpolated level when a run starts mid-fade', async () => {
      // Beats 2-6 of a two-bar project, i.e. the middle of the 1→3 fade.
      const twoBars = [
        makeBar(0, [makeNote(60, 0)]),
        makeBar(1, [makeNote(67, 0)]),
      ];
      const { result } = renderHook(() =>
        usePlayback({ ...fading, bars: twoBars, loopStart: 2, loopEnd: 6 })
      );
      await startPlayback(result);

      // Half way through a 1→0 fade running from beat 1 to beat 3.
      expect(volumeCalls.filter(c => c.kind === 'set').at(-1)?.volume).toBeCloseTo(0.5, 5);
    });

    it('restores the flat volume on stop, so the next run does not inherit the fade', async () => {
      const { result } = renderHook(() => usePlayback(fading));
      await startPlayback(result);
      await advance(2);

      volumeCalls.length = 0;
      act(() => result.current.stop());

      expect(volumeCalls).toEqual([{ kind: 'set', volume: 0.8 }]);
    });

    it('restores the flat volume on pause', async () => {
      const { result } = renderHook(() => usePlayback(fading));
      await startPlayback(result);
      await advance(2);

      volumeCalls.length = 0;
      act(() => result.current.pause());

      expect(volumeCalls).toEqual([{ kind: 'set', volume: 0.8 }]);
    });

    it('re-pins at the loop start on a wrap rather than gliding across the seam', async () => {
      const { result } = renderHook(() =>
        usePlayback({ ...fading, loopStart: 0, loopEnd: 4, loopEnabled: true })
      );
      await startPlayback(result);
      // Far enough to clear the seam at 4s and cross the whole fade a second time.
      await advance(7.5);

      // Past the seam the level is pinned back to where the curve opens — the value
      // it holds before its first breakpoint — instead of ramping up from silence.
      const pins = volumeCalls.filter(c => c.kind === 'set');
      expect(pins.length).toBeGreaterThan(1);
      expect(pins.at(-1)?.volume).toBe(1);
      // And the curve is scheduled again for the second pass.
      expect(ramps().filter(c => c.volume === 0).length).toBeGreaterThan(1);
    });

    it('picks up a curve edited while playing', async () => {
      const { result, rerender } = renderHook(({ cfg }) => usePlayback(cfg), {
        initialProps: { cfg: fading },
      });
      await startPlayback(result);
      await advance(0.5);

      rerender({
        cfg: {
          ...fading,
          tracks: [
            {
              ...fading.tracks[0],
              volumeAutomation: [
                { beat: 1, value: 1 },
                { beat: 3, value: 0.25 },
              ],
            },
          ],
        },
      });

      await advance(3);
      expect(ramps().at(-1)).toEqual({ kind: 'ramp', volume: 0.25, when: 3 });
    });

    describe('a backend that cannot schedule a ramp', () => {
      beforeEach(() => {
        supportsRamp = false;
      });

      it('steps the level per scheduling pass instead', async () => {
        const { result } = renderHook(() => usePlayback(fading));
        await startPlayback(result);
        await advance(3);

        expect(ramps()).toHaveLength(0);

        // Stepped down through the fade rather than jumping at the end of it.
        const levels = volumeCalls.map(c => c.volume);
        expect(levels.filter(v => v > 0.2 && v < 0.8).length).toBeGreaterThan(5);
        expect(levels.at(-1)).toBeCloseTo(0, 2);
      });

      it('says nothing while the level is not moving', async () => {
        const flat: PlaybackConfig = {
          ...fading,
          tracks: [{ ...fading.tracks[0], volumeAutomation: [{ beat: 1, value: 0.5 }] }],
        };
        const { result } = renderHook(() => usePlayback(flat));
        await startPlayback(result);
        await advance(3);

        // One from the pool building the instrument, one pinning the curve's level.
        // Sixty passes over a flat curve must not be sixty commands.
        expect(volumeCalls).toEqual([
          { kind: 'set', volume: 0.8 },
          { kind: 'set', volume: 0.5 },
        ]);
      });
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
