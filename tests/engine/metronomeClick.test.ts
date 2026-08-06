import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildClickQueue,
  processClickQueue,
  notifyLoopWrap,
  resetClickQueue,
  resetMetronome,
  resetAudioContext,
  setAudioContextFactory,
  defaultAudioContextFactory,
  type ScheduledClick,
} from '@/engine/metronomeClick';
import type { Bar, TimeSignature } from '@/types/music';
import { soloContent, TEST_TRACK_ID } from '../helpers/tracks';

/** Helpers used across tests. */
const makeBar = (
  barIndex: number,
  beatsPerMeasure: number,
  beatUnit = 4,
  trackId = TEST_TRACK_ID
): Bar => ({
  id: `bar-${barIndex}`,
  barIndex,
  timeSignature: { beatsPerMeasure, beatUnit },
  content: soloContent([], [], trackId),
});

const inheritingBar = (barIndex: number, trackId = TEST_TRACK_ID): Bar => ({
  id: `bar-${barIndex}`,
  barIndex,
  content: soloContent([], [], trackId),
});

// ---------------------------------------------------------------------------
// Shared counter (hoisted so it lives across module boundaries).
// ---------------------------------------------------------------------------
const { sharedState } = vi.hoisted(() => ({
  sharedState: { oscillatorCount: 0 },
}));

/**
 * Build a test AudioContext with a spy on createOscillator.
 *
 * Returns an object with the context and the spy so we can assert on calls.
 */
function createTestContext(): {
  ctx: AudioContext;
  createOscillatorSpy: ReturnType<typeof vi.fn>;
} {
  sharedState.oscillatorCount = 0;

  const createOscillatorSpy = vi.fn().mockImplementation(() => {
    sharedState.oscillatorCount++;
    return {
      type: 'sine' as const,
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn().mockReturnThis(),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as ReturnType<AudioContext['createOscillator']>;
  });

  const ctx = {
    currentTime: 0,
    state: 'running' as AudioContextState,
    sampleRate: 48000,
    resume: vi.fn().mockResolvedValue(undefined),
    createOscillator: createOscillatorSpy,
    createGain: vi.fn().mockReturnValue({
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn().mockReturnThis(),
    }),
    destination: {},
  } as unknown as AudioContext;

  return { ctx, createOscillatorSpy };
}

// ---------------------------------------------------------------------------
// buildClickQueue
// ---------------------------------------------------------------------------

describe('buildClickQueue', () => {
  beforeEach(() => {
    resetMetronome();
    setAudioContextFactory(defaultAudioContextFactory);
  });

  afterEach(() => {
    setAudioContextFactory(defaultAudioContextFactory);
  });

  it('returns a click on every beat for a 4/4 bar', () => {
    const bars = [makeBar(0, 4)];
    const clicks = buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);
    expect(clicks).toHaveLength(4);
    expect(clicks[0].freq).toBe(1200);
    expect(clicks[1].freq).toBe(800);
  });

  it('returns a click on every beat for a 3/4 bar', () => {
    const clicks = buildClickQueue([makeBar(0, 3)], { beatsPerMeasure: 3, beatUnit: 4 }, 120);
    expect(clicks).toHaveLength(3);
  });

  it('returns two clicks per bar for 6/8', () => {
    const clicks = buildClickQueue([makeBar(0, 6, 8)], { beatsPerMeasure: 6, beatUnit: 8 }, 120);
    expect(clicks).toHaveLength(2);
    expect(clicks[0].freq).toBe(1200);
    expect(clicks[1].freq).toBe(800);
  });

  it('returns four clicks per bar for 12/8', () => {
    const clicks = buildClickQueue([makeBar(0, 12, 8)], { beatsPerMeasure: 12, beatUnit: 8 }, 120);
    expect(clicks).toHaveLength(4);
    expect(clicks[0].freq).toBe(1200);
  });

  it('places one click per eighth for 7/8', () => {
    const clicks = buildClickQueue([makeBar(0, 7, 8)], { beatsPerMeasure: 7, beatUnit: 8 }, 120);
    expect(clicks).toHaveLength(7);
  });

  it('scales songTime by BPM', () => {
    const bars = [makeBar(0, 4)];
    const clicks120 = buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);
    const clicks60 = buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 60);

    for (let i = 0; i < 4; i++) {
      expect(clicks120[i].songTime).toBeCloseTo(i * 0.5, 10);
      expect(clicks60[i].songTime).toBeCloseTo(i * 1.0, 10);
    }
  });

  it('places correct songTime positions across multiple bars', () => {
    const bars = [makeBar(0, 4), makeBar(1, 4)];
    const clicks = buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 60);
    expect(clicks.map(c => c.songTime)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('handles bars with differing time signatures', () => {
    const clicks = buildClickQueue(
      [makeBar(0, 3), makeBar(1, 2)],
      { beatsPerMeasure: 4, beatUnit: 4 },
      60
    );
    expect(clicks).toHaveLength(5);
    expect(clicks.map(c => c.songTime)).toEqual([0, 1, 2, 3, 4]);
  });

  it('uses the project time signature for inheriting bars', () => {
    const clicks = buildClickQueue(
      [inheritingBar(0), inheritingBar(1)],
      { beatsPerMeasure: 4, beatUnit: 4 },
      60
    );
    expect(clicks).toHaveLength(8);
  });

  it('has one downbeat per bar', () => {
    const bars = [makeBar(0, 4), makeBar(1, 4), makeBar(2, 4)];
    const clicks = buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);
    const downbeats = clicks.filter(c => c.freq === 1200);
    expect(downbeats).toHaveLength(3);
    expect(downbeats[0].songTime).toBe(0);
    expect(downbeats[1].songTime).toBe(2);
    expect(downbeats[2].songTime).toBe(4);
  });

  it('returns an empty queue for zero bars', () => {
    expect(buildClickQueue([], { beatsPerMeasure: 4, beatUnit: 4 }, 120)).toEqual([]);
  });

  it('returns two clicks for a single bar with 2/4', () => {
    const clicks = buildClickQueue([makeBar(0, 2)], { beatsPerMeasure: 4, beatUnit: 4 }, 120);
    expect(clicks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// processClickQueue
// ---------------------------------------------------------------------------

describe('processClickQueue', () => {
  let createOscillatorSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const { ctx, createOscillatorSpy: spy } = createTestContext();
    createOscillatorSpy = spy;
    // Set the factory to return the pre-created context.
    setAudioContextFactory(() => ctx);
    resetMetronome();
    resetAudioContext();
    sharedState.oscillatorCount = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMetronome();
    resetAudioContext();
  });

  it('schedules clicks that fall within the look-ahead window', () => {
    const bars = [makeBar(0, 4)];
    buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);
    // 120 BPM → beat every 0.5s. With 0.2s look-ahead, only the first click at t=0 is due.
    processClickQueue(0, 0.2);
    expect(sharedState.oscillatorCount).toBe(1);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(1);
  });

  it('schedules two clicks when the window covers 0.55 seconds', () => {
    const bars = [makeBar(0, 4)];
    buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);
    // 120 BPM → beat every 0.5s. Window catches beats at t=0 and t=0.5.
    processClickQueue(0, 0.55);
    expect(sharedState.oscillatorCount).toBe(2);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(2);
  });

  it('schedules multiple clicks as time advances', () => {
    const bars = [makeBar(0, 4)];
    buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);

    // Catches beats at t=0 and t=0.5.
    processClickQueue(0, 0.55);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(2);

    // Catches beat at t=1.0.
    processClickQueue(0.5, 0.55);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(3);

    // Catches beat at t=1.5.
    processClickQueue(1.0, 0.55);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(4);
  });

  it('skips clicks that are past the look-ahead window', () => {
    const bars = [makeBar(0, 4)];
    buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 60);
    processClickQueue(0, 0.5);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(1);
  });

  it('schedules nothing more once the last click of the song is queued', () => {
    const bars = [makeBar(0, 4)];
    buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 60);
    processClickQueue(0, 4);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(4);

    // Still inside the last bar, only now past the end of the queue. Treating an
    // exhausted queue as a loop wrap here is what used to replay the song's clicks
    // on top of the final bar.
    processClickQueue(3.5, 0.5);
    processClickQueue(4, 0.5);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(4);
  });

  it('does not double-click the last bar when look-ahead runs past the queue', () => {
    // Two 4/4 bars at 60 BPM → clicks every second, last at t=7.
    const bars = [makeBar(0, 4), makeBar(1, 4)];
    buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 60);

    // Walk the playhead through the whole song in scheduler-sized steps.
    for (let t = 0; t <= 8; t += 0.1) {
      processClickQueue(t, 0.2);
    }

    // Exactly one click per beat, no phantom burst in the final bar.
    expect(createOscillatorSpy).toHaveBeenCalledTimes(8);
  });

  it('replays the queue when song time jumps backward mid-run', () => {
    const bars = [makeBar(0, 4)];
    buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 60);
    processClickQueue(0, 4);
    processClickQueue(3.9, 0.2);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(4);

    // A wrap or a seek shows up as song time jumping backward.
    processClickQueue(0, 0.5);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(5);
  });

  it('replays the queue after an explicit resetClickQueue (re-Play)', () => {
    const bars = [makeBar(0, 4)];
    buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 60);
    processClickQueue(0, 4);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(4);

    // Play from a stop re-arms the queue at the same song time it last ran from,
    // which no backward-motion check can see — the caller has to say so.
    resetClickQueue();
    processClickQueue(0, 0.5);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(5);
  });

  it('resets the queue when song time goes backward', () => {
    const bars = [makeBar(0, 4)];
    buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 60);

    processClickQueue(1, 1.5);
    const afterFirst = createOscillatorSpy.mock.calls.length;

    processClickQueue(0.5, 1.5);
    expect(createOscillatorSpy.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('does nothing when the queue is empty', () => {
    processClickQueue(0, 0.2);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(0);
  });

  it('handles an AudioContext factory that throws', () => {
    resetMetronome();
    resetAudioContext();
    setAudioContextFactory(() => {
      throw new Error('AudioContext unavailable');
    });

    const bars = [makeBar(0, 4)];
    buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);
    expect(() => processClickQueue(0, 0.2)).not.toThrow();
    expect(createOscillatorSpy).toHaveBeenCalledTimes(0);
  });

  it('handles a very long project without crashing', () => {
    const bars = Array.from({ length: 64 }, (_, i) => makeBar(i, 4));
    buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);
    processClickQueue(0, 0.2);
    expect(createOscillatorSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// resetClickQueue
// ---------------------------------------------------------------------------

describe('resetClickQueue', () => {
  let createOscillatorSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const { ctx, createOscillatorSpy: spy } = createTestContext();
    createOscillatorSpy = spy;
    setAudioContextFactory(() => ctx);
    resetMetronome();
    resetAudioContext();
    sharedState.oscillatorCount = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMetronome();
    resetAudioContext();
  });

  it('resets the queue index without clearing the queue', () => {
    const bars = [makeBar(0, 4)];
    buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);

    processClickQueue(0, 0.5);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(1);

    resetClickQueue();
    processClickQueue(0, 0.5);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// resetMetronome
// ---------------------------------------------------------------------------

describe('resetMetronome', () => {
  let createOscillatorSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const { ctx, createOscillatorSpy: spy } = createTestContext();
    createOscillatorSpy = spy;
    setAudioContextFactory(() => ctx);
    resetMetronome();
    resetAudioContext();
    sharedState.oscillatorCount = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMetronome();
    resetAudioContext();
  });

  it('clears the click queue', () => {
    const bars = [makeBar(0, 4)];
    buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);

    processClickQueue(0, 0.5);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(1);

    resetMetronome();
    processClickQueue(0, 0.5);
    expect(createOscillatorSpy).toHaveBeenCalledTimes(1);
  });

  it('is safe to call when no queue has been built', () => {
    expect(() => resetMetronome()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Edge cases and invariants
// ---------------------------------------------------------------------------

describe('metronome click invariants', () => {
  beforeEach(() => {
    resetMetronome();
    setAudioContextFactory(defaultAudioContextFactory);
  });

  it('clicks are always sorted by songTime', () => {
    const bars = Array.from({ length: 10 }, (_, i) => makeBar(i, 4));
    const clicks = buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);

    for (let i = 1; i < clicks.length; i++) {
      expect(clicks[i].songTime).toBeGreaterThanOrEqual(clicks[i - 1].songTime);
    }
  });

  it('all frequencies are valid oscillator frequencies', () => {
    const bars = [makeBar(0, 4)];
    const clicks = buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);

    for (const click of clicks) {
      expect(click.freq).toBeGreaterThan(0);
      expect(click.freq).toBeLessThanOrEqual(10000);
    }
  });

  it('bpm does not affect frequency, only timing', () => {
    const bars = [makeBar(0, 4)];
    const clicks60 = buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 60);
    const clicks180 = buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 180);

    expect(clicks60.map(c => c.freq)).toEqual(clicks180.map(c => c.freq));
    expect(clicks60.map(c => c.songTime)).not.toEqual(clicks180.map(c => c.songTime));
  });

  it('songTime is zero for the first click', () => {
    const bars = [makeBar(0, 4)];
    const clicks = buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);
    expect(clicks[0].songTime).toBe(0);
  });

  it('songTime increments by 60/bpm for simple metres', () => {
    const bars = [makeBar(0, 4)];
    const clicks = buildClickQueue(bars, { beatsPerMeasure: 4, beatUnit: 4 }, 120);
    const beatDur = 60 / 120;

    for (let i = 0; i < clicks.length; i++) {
      expect(clicks[i].songTime).toBeCloseTo(i * beatDur, 10);
    }
  });

  it('handles a 2/2 time signature correctly', () => {
    const clicks = buildClickQueue([makeBar(0, 2, 2)], { beatsPerMeasure: 2, beatUnit: 2 }, 60);
    expect(clicks).toHaveLength(2);
    expect(clicks[0].freq).toBe(1200);
  });

  it('places clicks on an unbroken grid across loop seams', () => {
    // A moving clock, unlike the shared fixture's frozen one: the seam bug is only
    // visible in the times the oscillators are actually started.
    let now = 0;
    const started: number[] = [];
    const ctx = {
      get currentTime() {
        return now;
      },
      state: 'running' as AudioContextState,
      resume: vi.fn().mockResolvedValue(undefined),
      destination: {},
      createGain: vi.fn().mockReturnValue({
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn().mockReturnThis(),
      }),
      createOscillator: vi.fn().mockImplementation(() => ({
        type: 'sine' as const,
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn().mockReturnThis(),
        start: (t: number) => started.push(Number(t.toFixed(4))),
        stop: vi.fn(),
      })),
    } as unknown as AudioContext;

    resetMetronome();
    resetAudioContext();
    setAudioContextFactory(() => ctx);

    // One 4/4 bar at 120 BPM: clicks every 0.5s, loop 2s long.
    buildClickQueue([makeBar(0, 4)], { beatsPerMeasure: 4, beatUnit: 4 }, 120);
    resetClickQueue();

    const loop = { from: 0, duration: 2 };
    const lookAhead = 0.2;
    const tick = 0.05;
    let songStart = 0;

    // Drive three repetitions exactly as usePlayback's scheduling pass does.
    for (let i = 0; i < 120; i++) {
      const elapsed = now - songStart;
      processClickQueue(elapsed, lookAhead, loop);
      if (elapsed >= loop.duration) {
        songStart += loop.duration;
        notifyLoopWrap(loop.duration);
      }
      now = Number((now + tick).toFixed(6));
    }

    // Every click 0.5s after the last, with no gap at 2s or 4s where the seam is.
    expect(started.length).toBeGreaterThanOrEqual(11);
    for (let i = 0; i < started.length; i++) {
      expect(started[i]).toBeCloseTo(i * 0.5, 6);
    }

    resetMetronome();
    resetAudioContext();
  });

  it('compound metre gives fractional beat positions', () => {
    const clicks = buildClickQueue([makeBar(0, 6, 8)], { beatsPerMeasure: 6, beatUnit: 8 }, 120);
    expect(clicks[0].songTime).toBe(0);
    expect(clicks[1].songTime).toBeCloseTo(0.75, 10);
  });
});
