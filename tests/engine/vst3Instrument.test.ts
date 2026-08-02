import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Tauri's IPC needs a real native host, so it is mocked wholesale — the same
// treatment `smplrPiano.test.ts` gives `smplr`. What matters here is the
// adapter's contract: that `when` reaches the command as an absolute time, that
// a tick's worth of notes costs one round trip, and that load is idempotent.
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  Vst3Instrument,
  syncVst3Clock,
  resetVst3Clock,
  captureVst3State,
} from '@/engine/vst3Instrument';
import type { ScheduledNote } from '@/engine/instrument';

const CLASS_ID = '565354416d736e6f53757267652058ab';
const TRACK = 'track-1';

/** Just enough AudioContext for the adapter's clock. */
function mockContext(currentTime = 0): AudioContext {
  return { currentTime } as AudioContext;
}

const note = (over: Partial<ScheduledNote> = {}): ScheduledNote => ({
  midiNote: 60,
  velocity: 100,
  when: 12.5,
  duration: 0.5,
  ...over,
});

/**
 * Let the microtask that flushes the batch run.
 *
 * Microtasks rather than a timer, because these tests run on fake timers and a
 * `setTimeout` here would simply never fire.
 */
const flushed = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/** The arguments of the one call to `command`. */
function callsTo(command: string): unknown[][] {
  return invoke.mock.calls.filter(c => c[0] === command).map(c => c.slice(1));
}

function makeLoaded(ctx = mockContext(12)) {
  const instrument = new Vst3Instrument(ctx, TRACK, CLASS_ID, 'Surge XT');
  return instrument;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  vi.useFakeTimers();
  // The sync ticker is shared by every plugin and so outlives any one test.
  resetVst3Clock();
});

afterEach(() => {
  resetVst3Clock();
  vi.useRealTimers();
});

describe('Vst3Instrument', () => {
  it('reports the name it was given', () => {
    expect(makeLoaded().name).toBe('Surge XT');
  });

  // The whole app schedules against the AudioContext clock; a plugin answering
  // with its own would put its notes in a different time frame from every other
  // instrument's.
  it('answers with the AudioContext clock, not its own', () => {
    const ctx = mockContext(41.5);
    expect(makeLoaded(ctx).now()).toBe(41.5);
  });

  describe('load', () => {
    it('asks the native side for the plugin class', async () => {
      const instrument = makeLoaded();
      await instrument.load();

      expect(callsTo('vst3_load')).toEqual([[{ trackId: TRACK, classId: CLASS_ID }]]);
      expect(instrument.isLoaded).toBe(true);
    });

    // Play calls load every time.
    it('is idempotent', async () => {
      const instrument = makeLoaded();
      await Promise.all([instrument.load(), instrument.load()]);
      await instrument.load();

      expect(callsTo('vst3_load')).toHaveLength(1);
    });

    it('is not loaded before the native side answers', () => {
      const instrument = makeLoaded();
      instrument.load();
      expect(instrument.isLoaded).toBe(false);
    });
  });

  describe('schedule', () => {
    it('passes the absolute time through untouched', async () => {
      const instrument = makeLoaded();
      await instrument.load();

      instrument.schedule(note({ when: 99.25 }));
      await flushed();

      expect(callsTo('vst3_schedule')).toEqual([
        [{ trackId: TRACK, notes: [note({ when: 99.25 })] }],
      ]);
    });

    // The scheduler dispatches every due note in one synchronous loop, so a
    // chord must cost one round trip rather than one per note.
    it('batches a tick of notes into a single call', async () => {
      const instrument = makeLoaded();
      await instrument.load();

      instrument.schedule(note({ midiNote: 60 }));
      instrument.schedule(note({ midiNote: 64 }));
      instrument.schedule(note({ midiNote: 67 }));
      await flushed();

      const calls = callsTo('vst3_schedule');
      expect(calls).toHaveLength(1);
      expect((calls[0][0] as { notes: ScheduledNote[] }).notes).toHaveLength(3);
    });

    it('starts a fresh batch for the next tick', async () => {
      const instrument = makeLoaded();
      await instrument.load();

      instrument.schedule(note({ midiNote: 60 }));
      await flushed();
      instrument.schedule(note({ midiNote: 64 }));
      await flushed();

      const calls = callsTo('vst3_schedule');
      expect(calls).toHaveLength(2);
      expect((calls[1][0] as { notes: ScheduledNote[] }).notes).toHaveLength(1);
    });

    // Scheduling into a plugin that does not exist yet would be silently lost
    // native-side; not sending is cheaper and no less correct.
    it('sends nothing before the plugin has loaded', async () => {
      const instrument = makeLoaded();
      instrument.schedule(note());
      await flushed();

      expect(callsTo('vst3_schedule')).toHaveLength(0);
    });
  });

  describe('stopAll', () => {
    it('stops this track rather than every track', async () => {
      const instrument = makeLoaded();
      await instrument.load();

      instrument.stopAll();

      expect(callsTo('vst3_stop')).toEqual([[{ trackId: TRACK }]]);
    });

    // Otherwise Stop is immediately followed over IPC by the very notes it was
    // meant to cancel.
    it('drops notes that were still waiting to be sent', async () => {
      const instrument = makeLoaded();
      await instrument.load();

      instrument.schedule(note());
      instrument.stopAll();
      await flushed();

      expect(callsTo('vst3_schedule')).toHaveLength(0);
    });
  });

  it('forwards volume', async () => {
    const instrument = makeLoaded();
    await instrument.load();

    instrument.setVolume(0.4);

    expect(callsTo('vst3_set_volume')).toEqual([[{ trackId: TRACK, volume: 0.4 }]]);
  });

  describe('dispose', () => {
    it('unloads the plugin', async () => {
      const instrument = makeLoaded();
      await instrument.load();

      instrument.dispose();

      expect(callsTo('vst3_unload')).toEqual([[{ trackId: TRACK }]]);
      expect(instrument.isLoaded).toBe(false);
    });

    it('ignores everything afterwards', async () => {
      const instrument = makeLoaded();
      await instrument.load();
      instrument.dispose();
      invoke.mockClear();

      instrument.schedule(note());
      instrument.stopAll();
      instrument.setVolume(0.5);
      instrument.dispose();
      await flushed();

      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe('clock sync', () => {
    it('anchors as soon as a plugin loads', async () => {
      const instrument = makeLoaded(mockContext(7.5));
      await instrument.load();

      expect(callsTo('vst3_sync')).toEqual([[{ hostTime: 7.5 }]]);
    });

    // A note placed against an anchor half a second old is audibly out.
    it('anchors on demand, for Play', async () => {
      const ctx = mockContext(1);
      const instrument = new Vst3Instrument(ctx, TRACK, CLASS_ID, 'X');
      await instrument.load();
      invoke.mockClear();

      ctx.currentTime = 20;
      syncVst3Clock();

      expect(callsTo('vst3_sync')).toEqual([[{ hostTime: 20 }]]);
    });

    it('keeps re-anchoring while a plugin is loaded', async () => {
      const instrument = makeLoaded();
      await instrument.load();
      invoke.mockClear();

      await vi.advanceTimersByTimeAsync(1_100);

      expect(callsTo('vst3_sync').length).toBeGreaterThanOrEqual(2);
    });

    // A project with no plugins must never open a native audio device, and the
    // sync command is what would start one.
    it('stops once the last plugin is disposed', async () => {
      const instrument = makeLoaded();
      await instrument.load();
      instrument.dispose();
      invoke.mockClear();

      await vi.advanceTimersByTimeAsync(2_000);

      expect(callsTo('vst3_sync')).toHaveLength(0);
    });

    it('keeps syncing while any plugin is still loaded', async () => {
      const one = new Vst3Instrument(mockContext(), 'a', CLASS_ID, 'A');
      const two = new Vst3Instrument(mockContext(), 'b', CLASS_ID, 'B');
      await one.load();
      await two.load();

      one.dispose();
      invoke.mockClear();
      await vi.advanceTimersByTimeAsync(1_100);

      expect(callsTo('vst3_sync').length).toBeGreaterThanOrEqual(1);
      two.dispose();
    });
  });
});

describe('plugin state', () => {
  const project = (tracks: Array<{ id: string; vst3State?: string }>) =>
    ({
      id: 'p',
      name: 'P',
      bpm: 120,
      tracks: tracks.map(t => ({
        id: t.id,
        name: t.id,
        instrument: `vst3:${CLASS_ID}`,
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
        vst3State: t.vst3State,
      })),
    }) as unknown as Parameters<typeof captureVst3State>[0];

  it('restores a saved preset before the plugin can be heard', async () => {
    const instrument = new Vst3Instrument(mockContext(), TRACK, CLASS_ID, 'X', 'AQIDBA==');
    await instrument.load();

    expect(callsTo('vst3_set_state')).toEqual([[{ trackId: TRACK, data: 'AQIDBA==' }]]);
    // The plugin must not count as loaded — and so must not be sent notes —
    // until its own preset is in place.
    const order = invoke.mock.calls.map(c => c[0]);
    expect(order.indexOf('vst3_set_state')).toBeLessThan(order.indexOf('vst3_sync'));
  });

  it('sends no state when the track has none saved', async () => {
    const instrument = makeLoaded();
    await instrument.load();
    expect(callsTo('vst3_set_state')).toHaveLength(0);
  });

  // A preset the plugin will not accept — a different version of it, usually.
  // Playing on defaults beats not playing at all.
  it('still loads when the plugin rejects the saved preset', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    invoke.mockImplementation((cmd: string) =>
      cmd === 'vst3_set_state' ? Promise.reject(new Error('nope')) : Promise.resolve()
    );

    const instrument = new Vst3Instrument(mockContext(), TRACK, CLASS_ID, 'X', 'AQIDBA==');
    await instrument.load();

    expect(instrument.isLoaded).toBe(true);
  });

  it('folds each loaded plugin’s state into the project', async () => {
    const a = new Vst3Instrument(mockContext(), 'a', CLASS_ID, 'A');
    const b = new Vst3Instrument(mockContext(), 'b', CLASS_ID, 'B');
    await a.load();
    await b.load();

    invoke.mockImplementation((cmd: string, args: { trackId: string }) =>
      cmd === 'vst3_get_state' ? Promise.resolve(`state-${args.trackId}`) : Promise.resolve()
    );

    const saved = await captureVst3State(project([{ id: 'a' }, { id: 'b' }]));

    expect(saved.tracks.map(t => t.vst3State)).toEqual(['state-a', 'state-b']);
    a.dispose();
    b.dispose();
  });

  // The common case, and every browser-build project.
  it('leaves a project with no plugins untouched', async () => {
    const original = project([{ id: 'a' }]);
    expect(await captureVst3State(original)).toBe(original);
  });

  it('keeps the previous state when a plugin gives none up', async () => {
    const instrument = new Vst3Instrument(mockContext(), 'a', CLASS_ID, 'A');
    await instrument.load();
    invoke.mockResolvedValue(null);

    const saved = await captureVst3State(project([{ id: 'a', vst3State: 'old' }]));

    expect(saved.tracks[0].vst3State).toBe('old');
    instrument.dispose();
  });

  // Saving a project must not fail because one plugin was uncooperative.
  it('survives a plugin that errors when asked for its state', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const instrument = new Vst3Instrument(mockContext(), 'a', CLASS_ID, 'A');
    await instrument.load();
    invoke.mockRejectedValue(new Error('boom'));

    await expect(captureVst3State(project([{ id: 'a' }]))).resolves.toBeTruthy();
    instrument.dispose();
  });

  it('asks nothing of a plugin that has been disposed', async () => {
    const instrument = new Vst3Instrument(mockContext(), 'a', CLASS_ID, 'A');
    await instrument.load();
    instrument.dispose();
    invoke.mockClear();

    await captureVst3State(project([{ id: 'a' }]));

    expect(callsTo('vst3_get_state')).toHaveLength(0);
  });
});
