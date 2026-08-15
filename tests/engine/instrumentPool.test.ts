import { describe, it, expect, beforeEach, vi } from 'vitest';

// Every backend is a module boundary needing the network, real Web Audio or a
// native host. What is under test is the dispatch: that a track's instrument id
// picks the right one.
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const SmplrPianoInstrument = vi.hoisted(() => vi.fn());
const SoundfontInstrument = vi.hoisted(() => vi.fn());
const Vst3Instrument = vi.hoisted(() => vi.fn());
const SfzInstrument = vi.hoisted(() => vi.fn());

vi.mock('@/engine/smplrPiano', () => ({ SmplrPianoInstrument }));
vi.mock('@/engine/soundfontInstrument', () => ({ SoundfontInstrument }));
vi.mock('@/engine/sfzInstrument', () => ({ SfzInstrument, resetSfzSampleCache: vi.fn() }));
vi.mock('@/engine/vst3Instrument', () => ({
  Vst3Instrument,
  syncVst3Clock: vi.fn(),
  resetVst3Clock: vi.fn(),
}));

import { InstrumentPool, isTrackAudible } from '@/engine/instrumentPool';
import { DEFAULT_INSTRUMENT_ID } from '@/engine/instrumentCatalog';
import type { Track, TrackGroup } from '@/types/music';

const CLASS_ID = '565354416d736e6f53757267652058ab';
const SFZ_PATH = 'C:/lib/Ocarina/Ocarina 20241002.sfz';

const track = (over: Partial<Track> = {}): Track => ({
  id: 'track-1',
  name: 'Piano',
  instrument: DEFAULT_INSTRUMENT_ID,
  volume: 0.8,
  pan: 0,
  muted: false,
  solo: false,
  ...over,
});

/** Enough AudioContext for the pool's graph. */
function mockContext(): AudioContext {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  return {
    currentTime: 5,
    destination: node(),
    createDynamicsCompressor: vi.fn(() => ({
      ...node(),
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
    })),
  } as unknown as AudioContext;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);

  for (const backend of [
    SmplrPianoInstrument,
    SoundfontInstrument,
    Vst3Instrument,
    SfzInstrument,
  ]) {
    backend.mockReset();
    backend.mockImplementation(function (this: Record<string, unknown>) {
      this.setVolume = vi.fn();
      this.dispose = vi.fn();
      this.stopAll = vi.fn();
      this.load = vi.fn(() => Promise.resolve());
      this.isLoaded = true;
    });
  }
});

describe('InstrumentPool backend dispatch', () => {
  it('gives the acoustic grand smplr’s dedicated piano', () => {
    new InstrumentPool(mockContext()).ensure([track({ instrument: DEFAULT_INSTRUMENT_ID })]);

    expect(SmplrPianoInstrument).toHaveBeenCalledTimes(1);
    expect(SoundfontInstrument).not.toHaveBeenCalled();
    expect(Vst3Instrument).not.toHaveBeenCalled();
  });

  it('gives every other General MIDI sound the soundfont', () => {
    new InstrumentPool(mockContext()).ensure([track({ instrument: 'string_ensemble_1' })]);

    expect(SoundfontInstrument).toHaveBeenCalledTimes(1);
    expect(SoundfontInstrument.mock.calls[0][1]).toBe('string_ensemble_1');
    expect(SmplrPianoInstrument).not.toHaveBeenCalled();
  });

  it('gives a namespaced plugin id the native host', () => {
    new InstrumentPool(mockContext()).ensure([
      track({ id: 'abc', instrument: `vst3:${CLASS_ID}` }),
    ]);

    expect(Vst3Instrument).toHaveBeenCalledTimes(1);
    const [, trackId, classId] = Vst3Instrument.mock.calls[0];
    expect(trackId).toBe('abc');
    expect(classId).toBe(CLASS_ID);
  });

  it('gives a namespaced path the local sample player', () => {
    new InstrumentPool(mockContext()).ensure([
      track({ id: 'abc', instrument: `sfz:${SFZ_PATH}` }),
    ]);

    expect(SfzInstrument).toHaveBeenCalledTimes(1);
    expect(SfzInstrument.mock.calls[0][1]).toBe(SFZ_PATH);
    expect(SoundfontInstrument).not.toHaveBeenCalled();
  });

  // The files are on this machine already, so there is nothing to download and no
  // reason to make the user press Play before the first audition sounds.
  it('loads a sample set as soon as it is chosen', () => {
    new InstrumentPool(mockContext()).ensure([track({ instrument: `sfz:${SFZ_PATH}` })]);

    const instance = SfzInstrument.mock.instances[0] as { load: ReturnType<typeof vi.fn> };
    expect(instance.load).toHaveBeenCalled();
  });

  it('rebuilds a sample set when its path changes', () => {
    const pool = new InstrumentPool(mockContext());
    pool.ensure([track({ id: 'a', instrument: `sfz:${SFZ_PATH}` })]);
    pool.ensure([track({ id: 'a', instrument: 'sfz:C:/lib/Other/Other.sfz' })]);

    expect(SfzInstrument).toHaveBeenCalledTimes(2);
  });

  it('leaves a sample set alone when nothing about it changed', () => {
    const pool = new InstrumentPool(mockContext());
    const sampled = track({ id: 'a', instrument: `sfz:${SFZ_PATH}` });

    pool.ensure([sampled]);
    pool.ensure([{ ...sampled, volume: 0.5 }]);

    expect(SfzInstrument).toHaveBeenCalledTimes(1);
  });

  // A prefix naming no file is as malformed as a bad class id.
  it('falls back to the piano for an empty sample-set path', () => {
    new InstrumentPool(mockContext()).ensure([track({ instrument: 'sfz:' })]);

    expect(SfzInstrument).not.toHaveBeenCalled();
    expect(SoundfontInstrument).toHaveBeenCalledTimes(1);
  });

  // Files written before instruments could choose a sound leave this behind,
  // and they sounded like a piano.
  it('falls back to the piano for a track with no sound set', () => {
    new InstrumentPool(mockContext()).ensure([track({ instrument: '' })]);
    expect(SmplrPianoInstrument).toHaveBeenCalledTimes(1);
  });

  // A malformed plugin id must not take the whole pool down with it.
  it('falls back to the piano for a malformed plugin id', () => {
    new InstrumentPool(mockContext()).ensure([track({ instrument: 'vst3:nonsense' })]);

    expect(Vst3Instrument).not.toHaveBeenCalled();
    expect(SoundfontInstrument).toHaveBeenCalledTimes(1);
  });

  it('rebuilds only the track whose sound changed', () => {
    const pool = new InstrumentPool(mockContext());
    const a = track({ id: 'a', instrument: 'violin' });
    const b = track({ id: 'b', instrument: 'flute' });

    pool.ensure([a, b]);
    expect(SoundfontInstrument).toHaveBeenCalledTimes(2);

    pool.ensure([a, { ...b, instrument: `vst3:${CLASS_ID}` }]);

    expect(SoundfontInstrument).toHaveBeenCalledTimes(2);
    expect(Vst3Instrument).toHaveBeenCalledTimes(1);
  });

  // Until the plugin exists there is nothing for its editor to show, so a
  // freshly chosen plugin has to come up without waiting for Play.
  it('loads a plugin as soon as it is chosen', () => {
    new InstrumentPool(mockContext()).ensure([
      track({ id: 'abc', instrument: `vst3:${CLASS_ID}` }),
    ]);

    const instance = Vst3Instrument.mock.instances[0] as { load: ReturnType<typeof vi.fn> };
    expect(instance.load).toHaveBeenCalled();
  });

  // Samplers download their samples, which is not work to do before it is asked
  // for.
  it('leaves a sampler to load at Play', () => {
    new InstrumentPool(mockContext()).ensure([track({ instrument: 'string_ensemble_1' })]);

    const instance = SoundfontInstrument.mock.instances[0] as {
      load: ReturnType<typeof vi.fn>;
    };
    expect(instance.load).not.toHaveBeenCalled();
  });

  it('disposes a plugin when its track goes away', () => {
    const pool = new InstrumentPool(mockContext());
    pool.ensure([track({ id: 'a', instrument: `vst3:${CLASS_ID}` })]);

    const instance = Vst3Instrument.mock.instances[0] as { dispose: ReturnType<typeof vi.fn> };
    pool.ensure([]);

    expect(instance.dispose).toHaveBeenCalled();
  });
});

// Mute wins over solo, so soloing a muted track does not un-mute it.
describe('isTrackAudible', () => {
  it('is true for an ordinary track', () => {
    const tracks = [track()];
    expect(isTrackAudible(tracks[0], tracks)).toBe(true);
  });

  it('is false for a muted track', () => {
    const tracks = [track({ muted: true })];
    expect(isTrackAudible(tracks[0], tracks)).toBe(false);
  });

  it('silences every track that is not soloed, once any is', () => {
    const tracks = [track({ id: 'a' }), track({ id: 'b', solo: true })];
    expect(isTrackAudible(tracks[0], tracks)).toBe(false);
    expect(isTrackAudible(tracks[1], tracks)).toBe(true);
  });

  it('keeps a soloed track muted if it is also muted', () => {
    const tracks = [track({ solo: true, muted: true })];
    expect(isTrackAudible(tracks[0], tracks)).toBe(false);
  });

  // A group's mute and solo read exactly as a track's own, and sit beside them
  // rather than replacing them — so ungrouping hands back the mix the user built.
  describe('with groups', () => {
    const rhythm: TrackGroup = { id: 'rhythm', name: 'Rhythm' };

    it('silences a member of a muted group', () => {
      const tracks = [track({ groupId: 'rhythm' })];
      expect(isTrackAudible(tracks[0], tracks, [{ ...rhythm, muted: true }])).toBe(false);
    });

    it('leaves an instrument outside the muted group sounding', () => {
      const tracks = [track({ id: 'a', groupId: 'rhythm' }), track({ id: 'b' })];
      expect(isTrackAudible(tracks[1], tracks, [{ ...rhythm, muted: true }])).toBe(true);
    });

    it('puts every member of a soloed group into the solo set', () => {
      const tracks = [track({ id: 'a', groupId: 'rhythm' }), track({ id: 'b' })];
      const groups = [{ ...rhythm, solo: true }];
      expect(isTrackAudible(tracks[0], tracks, groups)).toBe(true);
      expect(isTrackAudible(tracks[1], tracks, groups)).toBe(false);
    });

    // One project-wide solo mode, not one per group: soloing a group and soloing a
    // loose instrument has to leave both sounding.
    it('adds a soloed track to a soloed group rather than replacing it', () => {
      const tracks = [
        track({ id: 'a', groupId: 'rhythm' }),
        track({ id: 'b', solo: true }),
        track({ id: 'c' }),
      ];
      const groups = [{ ...rhythm, solo: true }];
      expect(isTrackAudible(tracks[0], tracks, groups)).toBe(true);
      expect(isTrackAudible(tracks[1], tracks, groups)).toBe(true);
      expect(isTrackAudible(tracks[2], tracks, groups)).toBe(false);
    });

    it('keeps a member muted by its own flag inside a soloed group', () => {
      const tracks = [track({ groupId: 'rhythm', muted: true })];
      expect(isTrackAudible(tracks[0], tracks, [{ ...rhythm, solo: true }])).toBe(false);
    });

    // A groupId left behind by a removed group must not silence anything.
    it('ignores a groupId naming no group', () => {
      const tracks = [track({ groupId: 'gone' })];
      expect(isTrackAudible(tracks[0], tracks, [{ ...rhythm, muted: true }])).toBe(true);
    });
  });
});
