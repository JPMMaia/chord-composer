import { describe, it, expect, beforeEach, vi } from 'vitest';

// Every backend is a module boundary needing the network, real Web Audio or a
// native host. What is under test is the dispatch: that a track's instrument id
// picks the right one.
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const SmplrPianoInstrument = vi.hoisted(() => vi.fn());
const SoundfontInstrument = vi.hoisted(() => vi.fn());
const Vst3Instrument = vi.hoisted(() => vi.fn());

vi.mock('@/engine/smplrPiano', () => ({ SmplrPianoInstrument }));
vi.mock('@/engine/soundfontInstrument', () => ({ SoundfontInstrument }));
vi.mock('@/engine/vst3Instrument', () => ({
  Vst3Instrument,
  syncVst3Clock: vi.fn(),
  resetVst3Clock: vi.fn(),
}));

import { InstrumentPool, isTrackAudible } from '@/engine/instrumentPool';
import { DEFAULT_INSTRUMENT_ID } from '@/engine/instrumentCatalog';
import type { Track } from '@/types/music';

const CLASS_ID = '565354416d736e6f53757267652058ab';

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

  for (const backend of [SmplrPianoInstrument, SoundfontInstrument, Vst3Instrument]) {
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
});
