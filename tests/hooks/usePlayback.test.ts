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

/** A parameter change asked of the instrument: stated now, or placed at `when`. */
interface ParamCall {
  kind: 'set' | 'automate';
  target: AutomationTarget;
  value: number;
  when?: number;
}

const scheduled: Scheduled[] = [];
const volumeCalls: VolumeCall[] = [];
const paramCalls: ParamCall[] = [];
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

/**
 * Whether the instrument built for the next run has parameters at all.
 *
 * Read at construction, like `supportsRamp`. False is every backend but the
 * natively-hosted plugins: `automateTarget` and `setTarget` are optional, and an
 * instrument without them cannot be automated at all — there is no coarser
 * fallback the way there is for volume.
 */
let supportsParams = true;

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
      if (supportsParams) {
        Object.assign(this, {
          automateTarget: (target: AutomationTarget, value: number, when: number) => {
            paramCalls.push({ kind: 'automate', target, value, when });
          },
          setTarget: (target: AutomationTarget, value: number) => {
            paramCalls.push({ kind: 'set', target, value });
          },
        });
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
import type { AutomationTarget, Bar, Note, Track } from '@/types/music';
import { laneKey } from '@/engine/parameterAutomation';
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
    paramCalls.length = 0;
    supportsRamp = true;
    supportsParams = true;
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

  describe('the loop seam', () => {
    const looped: PlaybackConfig = { ...config, loopStart: 0, loopEnd: 4, loopEnabled: true };

    // The regression these exist for: the window used to be clamped at the loop
    // end, so a repeat's notes were only handed over once the wrap had been
    // noticed — a tick or more after their moment had already passed. Web Audio
    // clamps a stale note to "now"; a plugin reached over IPC clamps it somewhere
    // else. Same downbeat, two different "immediately", once per repetition.
    it('hands a repeat its notes before the seam arrives', async () => {
      const { result } = renderHook(() => usePlayback(looped));
      await startPlayback(result);
      await advance(3.9);

      // Still short of the seam at 4s, and the repeat's downbeat is already out —
      // placed at 4s, in the future, rather than at whatever the clock reads once
      // the wrap is spotted.
      expect(result.current.getSongTime()).toBeLessThan(4);
      expect(scheduled.filter(n => n.when === 4)).toEqual([
        { midiNote: 60, velocity: 100, when: 4, duration: 1 },
      ]);
    });

    it('places every repetition on the same grid as the first', async () => {
      const { result } = renderHook(() => usePlayback(looped));
      await startPlayback(result);
      await advance(11);

      // Notes sit a beat apart at 60 BPM, so three repetitions of a four-beat
      // range are twelve notes exactly one second apart with no seam to be heard.
      expect(scheduled.map(n => n.when)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });

    it('schedules no note twice across a seam', async () => {
      const { result } = renderHook(() => usePlayback(looped));
      await startPlayback(result);
      await advance(8.5);

      expect(new Set(scheduled.map(n => n.when)).size).toBe(scheduled.length);
    });
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

  /**
   * The phrase editor auditioning one placement.
   *
   * There is no second engine for it: the song is still what is scheduled, and the
   * audition only says which instruments are heard while it plays. It *replaces*
   * mute and solo rather than narrowing them — the user opened the phrase to hear
   * it, so an instrument muted while working on the arrangement still sounds.
   */
  describe('an audition set', () => {
    const OTHER = 'track-other';

    /** Two instruments playing at once, so "only one of them" can be told apart. */
    const duet: PlaybackConfig = {
      ...config,
      bars: [
        {
          ...makeBar(0, [makeNote(60, 0)]),
          content: {
            [TEST_TRACK_ID]: { chords: [], notes: [makeNote(60, 0)] },
            [OTHER]: { chords: [], notes: [makeNote(72, 0)] },
          },
        },
      ],
      tracks: [testTrack, { ...testTrack, id: OTHER, name: 'Lead' }],
    };

    it('sounds both instruments with no audition on', async () => {
      const { result } = renderHook(() => usePlayback(duet));
      await startPlayback(result);

      expect(scheduled.map(n => n.midiNote).sort()).toEqual([60, 72]);
    });

    it('sounds only the instruments it names', async () => {
      const { result } = renderHook(() =>
        usePlayback({ ...duet, audibleTrackIds: [TEST_TRACK_ID] })
      );
      await startPlayback(result);

      expect(scheduled.map(n => n.midiNote)).toEqual([60]);
    });

    it('sounds a muted instrument it names', async () => {
      const { result } = renderHook(() =>
        usePlayback({
          ...duet,
          tracks: [{ ...testTrack, muted: true }, { ...testTrack, id: OTHER, name: 'Lead' }],
          audibleTrackIds: [TEST_TRACK_ID],
        })
      );
      await startPlayback(result);

      expect(scheduled.map(n => n.midiNote)).toEqual([60]);
    });

    it('silences an instrument soloed elsewhere in the song', async () => {
      const { result } = renderHook(() =>
        usePlayback({
          ...duet,
          tracks: [testTrack, { ...testTrack, id: OTHER, name: 'Lead', solo: true }],
          audibleTrackIds: [TEST_TRACK_ID],
        })
      );
      await startPlayback(result);

      expect(scheduled.map(n => n.midiNote)).toEqual([60]);
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

    it('steps back to the curve start at the seam rather than gliding across it', async () => {
      const { result } = renderHook(() =>
        usePlayback({ ...fading, loopStart: 0, loopEnd: 4, loopEnabled: true })
      );
      await startPlayback(result);
      // Far enough to clear the seam at 4s and start the fade a second time.
      await advance(7.5);

      // The repeat's opening level is *scheduled at the seam*, not stated whenever
      // the pass that noticed the wrap happened to run.
      expect(ramps().filter(c => c.when === 4)).toEqual([
        { kind: 'ramp', volume: 1, when: 4 },
      ]);

      // A linear ramp interpolates from the event before it, so the outgoing level
      // is held right up to the seam. Without that the fade's last value would
      // glide up to the repeat's opening across the whole tail of the range.
      const hold = ramps().filter(c => c.when! > 3.99 && c.when! < 4);
      expect(hold).toHaveLength(1);
      expect(hold[0].volume).toBe(0);

      // The curve then runs again in the new frame: beats 1 and 3 of the repeat.
      expect(ramps()).toContainEqual({ kind: 'ramp', volume: 1, when: 5 });
      expect(ramps()).toContainEqual({ kind: 'ramp', volume: 0, when: 7 });

      // Nothing is pinned at the wrap. `setVolume` cancels pending events, and by
      // then the repeat's ramps are already on the timeline.
      expect(volumeCalls.filter(c => c.kind === 'set')).toEqual([
        { kind: 'set', volume: 0.8 },
        { kind: 'set', volume: 1 },
      ]);
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

  describe('plugin parameter automation', () => {
    /** A MIDI controller target, to prove the two kinds advance independently. */
    const CC20 = { kind: 'cc', controller: 20 } as const;

    /** A sweep on parameter 7 across beats 1–3, and a flat lane on parameter 9. */
    const sweeping: PlaybackConfig = {
      ...config,
      tracks: [
        {
          ...testTrack,
          parameterAutomation: [
            {
              target: { kind: 'param', paramId: 7 },
              name: 'Cutoff',
              points: [
                { beat: 1, value: 0.2 },
                { beat: 3, value: 0.9 },
              ],
            },
          ],
        },
      ],
    };

    const automated = () => paramCalls.filter(c => c.kind === 'automate');
    const pinned = () => paramCalls.filter(c => c.kind === 'set');
    /** Everything sent for one target, in the order it was sent. */
    const forTarget = (key: string) =>
      automated().filter(c => laneKey(c.target) === key);

    it('says nothing at all when no parameter is automated', async () => {
      const { result } = renderHook(() => usePlayback(config));
      await startPlayback(result);
      await advance(3);

      expect(paramCalls).toEqual([]);
    });

    // The assertion the whole sampled path exists for. Nothing downstream
    // interpolates a plugin parameter — a change is a value at a sample and holds
    // until the next one — so a sweep sent as its two ends would sit still and
    // jump at the far one. Sending only the breakpoints produces exactly 2 here.
    it('sweeps a ramp rather than jumping at its far end', async () => {
      const { result } = renderHook(() => usePlayback(sweeping));
      await startPlayback(result);
      await advance(4);

      const sent = forTarget('param:7');
      expect(sent.length).toBeGreaterThan(20);

      // Strictly rising, and spanning the whole ramp rather than a corner of it.
      const values = sent.map(c => c.value);
      expect(values).toEqual([...values].sort((a, b) => a - b));
      expect(values[0]).toBeCloseTo(0.2, 1);
      expect(values.at(-1)).toBeCloseTo(0.9, 1);
    });

    // Unlike a plugin's volume, a change carries a time all the way down: VST3's
    // queue takes a sample offset per point. Every sampled value has to arrive
    // with one, in order, or the sweep would be placed as a heap at one instant.
    it('places every value at its own clock time, in order', async () => {
      const { result } = renderHook(() => usePlayback(sweeping));
      await startPlayback(result);
      await advance(4);

      const times = forTarget('param:7').map(c => c.when!);
      expect(times.every(t => typeof t === 'number')).toBe(true);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      // Confined to the ramp: nothing before it starts or after it ends.
      expect(times[0]).toBeGreaterThanOrEqual(1);
      expect(times.at(-1)).toBeLessThanOrEqual(3);
    });

    // A held value costs nothing, which is what makes sampling affordable: the
    // flat stretches either side of the ramp send nothing at all.
    it('sends nothing while the curve is not moving', async () => {
      const { result } = renderHook(() => usePlayback(sweeping));
      await startPlayback(result);
      await advance(4);

      // Beat 3 onward is flat at 0.9, and beats 0-1 flat at 0.2. A sampler that
      // ignored the epsilon would send a point every 10 ms across all four beats.
      expect(forTarget('param:7').length).toBeLessThan(4 / 0.01);
    });

    it('does not re-send a value it has already handed over', async () => {
      const { result } = renderHook(() => usePlayback(sweeping));
      await startPlayback(result);
      await advance(3.9);
      const first = forTarget('param:7').length;

      await advance(1);
      expect(forTarget('param:7')).toHaveLength(first);
    });

    it('schedules no further ahead than the look-ahead window', async () => {
      const { result } = renderHook(() => usePlayback(sweeping));
      await startPlayback(result);

      expect(automated()).toHaveLength(0);
    });

    it('pins the interpolated value when a run starts mid-sweep', async () => {
      const twoBars = [makeBar(0, [makeNote(60, 0)]), makeBar(1, [makeNote(67, 0)])];
      const { result } = renderHook(() =>
        usePlayback({ ...sweeping, bars: twoBars, loopStart: 2, loopEnd: 6 })
      );
      await startPlayback(result);

      // Half way through a 0.2→0.9 sweep running from beat 1 to beat 3.
      expect(pinned().at(-1)).toEqual({
        kind: 'set',
        target: { kind: 'param', paramId: 7 },
        value: 0.55,
      });
    });

    it('advances a parameter curve and a controller curve independently', async () => {
      const both: PlaybackConfig = {
        ...sweeping,
        tracks: [
          {
            ...sweeping.tracks[0],
            parameterAutomation: [
              ...sweeping.tracks[0].parameterAutomation!,
              {
                target: CC20,
                name: 'CC 20',
                // Falling where the parameter rises, and over a different span,
                // so neither curve could be mistaken for the other's.
                points: [
                  { beat: 0, value: 0.8 },
                  { beat: 2, value: 0.1 },
                ],
              },
            ],
          },
        ],
      };
      const { result } = renderHook(() => usePlayback(both));
      await startPlayback(result);
      await advance(4);

      const param = forTarget('param:7').map(c => c.value);
      const cc = forTarget('cc:20').map(c => c.value);

      // Each follows its own curve over its own span: one rising to 0.9 across
      // beats 1-3, the other falling to 0.1 across beats 0-2.
      expect(param.length).toBeGreaterThan(20);
      expect(cc.length).toBeGreaterThan(20);
      expect(param).toEqual([...param].sort((a, b) => a - b));
      expect(cc).toEqual([...cc].sort((a, b) => b - a));
      expect(param.at(-1)).toBeCloseTo(0.9, 1);
      expect(cc.at(-1)).toBeCloseTo(0.1, 1);
    });

    /** A slow full sweep on CC 20, the shape a glissando controller is drawn as. */
    const gliss: PlaybackConfig = {
      ...config,
      tracks: [
        {
          ...testTrack,
          parameterAutomation: [
            {
              target: CC20,
              name: 'Glissando',
              points: [
                { beat: 0, value: 0 },
                { beat: 4, value: 1 },
              ],
            },
          ],
        },
      ],
    };

    // A controller is a 7-bit value, so a normalised value between two steps
    // names a position no controller could have been in. An instrument that acts
    // on controller movement — a harp plays a string per step — hears the
    // difference as a retrigger, which is why this is snapped on the way out
    // rather than left to the plugin's own rounding.
    it('sends a controller curve as exact controller steps', async () => {
      const { result } = renderHook(() => usePlayback(gliss));
      await startPlayback(result);
      await advance(5);

      const values = forTarget('cc:20').map(c => c.value);
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(value * 127).toBeCloseTo(Math.round(value * 127), 10);
      }
    });

    // The grid is 10 ms, so a four-second sweep is 400 samples; a controller has
    // only 128 places to be. Every step is worth sending once and no more —
    // anything beyond that is movement the plugin can hear and the ear cannot.
    it('sends each controller step once, in order, and never repeats one', async () => {
      const { result } = renderHook(() => usePlayback(gliss));
      await startPlayback(result);
      await advance(5);

      const steps = forTarget('cc:20').map(c => Math.round(c.value * 127));
      expect(steps).toEqual([...new Set(steps)]);
      expect(steps).toEqual([...steps].sort((a, b) => a - b));
      expect(steps.at(-1)).toBe(127);
      expect(steps.length).toBeLessThanOrEqual(128);
    });

    // A plugin parameter is genuinely continuous, and snapping it to 128 places
    // would throw away resolution the plugin does have.
    it('leaves a plugin parameter at full resolution', async () => {
      const { result } = renderHook(() => usePlayback(sweeping));
      await startPlayback(result);
      await advance(4);

      const values = forTarget('param:7').map(c => c.value);
      expect(values.some(v => Math.abs(v * 127 - Math.round(v * 127)) > 1e-6)).toBe(true);
    });

    it('pins a controller on its own step when a run starts mid-sweep', async () => {
      const twoBars = [makeBar(0, [makeNote(60, 0)]), makeBar(1, [makeNote(67, 0)])];
      const { result } = renderHook(() =>
        usePlayback({ ...gliss, bars: twoBars, loopStart: 2, loopEnd: 6 })
      );
      await startPlayback(result);

      // Half way through a 0→1 sweep across four beats: 0.5 rounds to step 64.
      expect(pinned().at(-1)).toEqual({
        kind: 'set',
        target: CC20,
        value: 64 / 127,
      });
    });

    it('leaves the volume curve to its own path', async () => {
      const { result } = renderHook(() => usePlayback(sweeping));
      await startPlayback(result);
      await advance(4);

      // The pool's one static setVolume, and nothing else: a parameter sweep is
      // not a reason to touch the level.
      expect(volumeCalls.filter(c => c.kind === 'ramp')).toHaveLength(0);
      expect(volumeCalls.filter(c => c.kind === 'set')).toHaveLength(1);
    });

    // A parameter is not a note. Stopping mid-sweep leaves it where the curve left
    // it, because the host has no better value to impose than the plugin's own.
    it('does not put a parameter back to anything on stop', async () => {
      const { result } = renderHook(() => usePlayback(sweeping));
      await startPlayback(result);
      await advance(2);

      paramCalls.length = 0;
      act(() => {
        result.current.stop();
      });

      expect(paramCalls).toEqual([]);
    });

    it('restates the sweep at the seam on a wrap rather than drifting', async () => {
      const { result } = renderHook(() =>
        usePlayback({ ...sweeping, loopStart: 0, loopEnd: 4, loopEnabled: true })
      );
      await startPlayback(result);
      // Past the seam at 4s and into the repeat's own sweep, which runs 5s to 7s.
      await advance(6.5);

      const fromSeam = automated().filter(c => c.when! >= 4);
      // The curve opens again exactly at the seam, sample-accurate, rather than
      // being stated untimed by whichever pass noticed the wrap.
      expect(fromSeam[0]).toEqual({
        kind: 'automate',
        target: { kind: 'param', paramId: 7 },
        value: 0.2,
        when: 4,
      });
      // And it is re-walked from the bottom instead of carrying on from the 0.9
      // the last repetition ended on.
      expect(fromSeam.at(-1)!.value).toBeGreaterThan(0.2);
      expect(fromSeam.at(-1)!.value).toBeLessThan(0.9);

      // Still only the pin from Play: a wrap places values, it does not state them.
      expect(pinned()).toHaveLength(1);
    });

    it('picks up an edit made while playing', async () => {
      const { result, rerender } = renderHook(({ cfg }) => usePlayback(cfg), {
        initialProps: { cfg: sweeping },
      });
      await startPlayback(result);
      await advance(0.5);

      rerender({
        cfg: {
          ...sweeping,
          tracks: [
            {
              ...sweeping.tracks[0],
              parameterAutomation: [
                {
                  target: { kind: 'param', paramId: 7 },
                  name: 'Cutoff',
                  points: [
                    { beat: 1, value: 0.2 },
                    { beat: 3, value: 0.5 },
                  ],
                },
              ],
            },
          ],
        },
      });

      await advance(3);
      // The edit lowered the ramp's top from 0.9 to 0.5, and the curve is
      // re-pinned against the new array rather than run out against the old one.
      expect(automated().at(-1)!.value).toBeCloseTo(0.5, 2);
    });

    it('drops the cursor for a lane whose points have all gone', async () => {
      const { result, rerender } = renderHook(({ cfg }) => usePlayback(cfg), {
        initialProps: { cfg: sweeping },
      });
      await startPlayback(result);
      await advance(1.5);

      rerender({
        cfg: {
          ...sweeping,
          tracks: [
            {
              ...sweeping.tracks[0],
              parameterAutomation: [
                { target: { kind: 'param', paramId: 7 }, name: 'Cutoff', points: [] },
              ],
            },
          ],
        },
      });

      paramCalls.length = 0;
      await advance(3);

      // An emptied lane drives nothing at all, rather than holding its last value
      // against the plugin.
      expect(paramCalls).toEqual([]);
    });

    describe('a backend with no parameters', () => {
      beforeEach(() => {
        supportsParams = false;
      });

      // No coarser fallback the way volume has one: there is nothing to fall back
      // *to*, so the curve is skipped rather than approximated.
      it('is skipped without throwing', async () => {
        const { result } = renderHook(() => usePlayback(sweeping));
        await startPlayback(result);
        await advance(4);

        expect(paramCalls).toEqual([]);
        // And the notes still play, so skipping the curve costs nothing else.
        expect(scheduled.length).toBeGreaterThan(0);
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
