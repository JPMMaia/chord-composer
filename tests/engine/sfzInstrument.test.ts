import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SmplrPreset } from 'smplr';

// Tauri's IPC needs a real native host and smplr needs real Web Audio, so both are
// mocked wholesale — the same treatment `vst3Instrument.test.ts` and
// `smplrPiano.test.ts` give them. What is under test is the adapter's contract: that
// the definition and its samples are read once each, that the preset handed to smplr
// says what the SFZ said, and that loop points are converted at the *file's* rate.
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const start = vi.hoisted(() => vi.fn());
const stop = vi.hoisted(() => vi.fn());
const dispose = vi.hoisted(() => vi.fn());
const Sampler = vi.hoisted(() =>
  vi.fn(() => ({ ready: Promise.resolve(), start, stop, dispose }))
);
vi.mock('smplr', () => ({ Sampler }));

import { SfzInstrument, resetSfzSampleCache } from '@/engine/sfzInstrument';
import { resetSfzCatalog } from '@/engine/sfzCatalog';

const MARKER = '__TAURI_INTERNALS__';
const SFZ_PATH = 'C:/lib/Ocarina/Ocarina 20241002.sfz';

const DEFINITION = `//+ Name: Ocarina
<global>
 ampeg_release=0.4
<group>
 loop_mode=loop_continuous
<region>
 lokey=60 hikey=70
 pitch_keycenter=66
 loop_start=14805 loop_end=45027
 sample=samples/F#4.wav
<region>
 key=76
 sample=samples/E5_01.wav
`;

/** A 48 kHz WAV header — the rate the ocarina samples were actually recorded at. */
function wavBytes(rate = 48000): ArrayBuffer {
  const bytes: number[] = [];
  const push = (text: string) => bytes.push(...[...text].map(c => c.charCodeAt(0)));
  const pushU32 = (v: number) =>
    bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);

  push('RIFF');
  pushU32(0);
  push('WAVE');
  push('fmt ');
  pushU32(16);
  bytes.push(0x01, 0x00, 0x01, 0x00);
  pushU32(rate);
  pushU32(0);
  bytes.push(0x03, 0x00, 0x18, 0x00);

  return Uint8Array.from(bytes).buffer;
}

/**
 * An audio context whose decoder resamples to 44.1 kHz, as a real one does.
 *
 * The mismatch is the point: a decoded buffer reports the *context's* rate, so any
 * code that took loop frames over `buffer.sampleRate` would be about 9% out.
 */
function mockContext(currentTime = 0): AudioContext {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  return {
    currentTime,
    destination: node(),
    createGain: vi.fn(() => ({ ...node(), gain: { value: 1 } })),
    createDynamicsCompressor: vi.fn(() => ({
      ...node(),
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
    })),
    decodeAudioData: vi.fn(async () => ({ sampleRate: 44100, duration: 2 })),
  } as unknown as AudioContext;
}

/** The preset the instrument handed to smplr. */
const presetGiven = (): SmplrPreset => Sampler.mock.calls[0][1].preset;

/** The buffers the instrument handed to smplr, keyed as smplr keys them. */
const buffersGiven = async (): Promise<Map<string, AudioBuffer>> =>
  Sampler.mock.calls[0][1].loader.load();

/** Answer each native read with what that command should return. */
function nativeFiles(definition = DEFINITION, rate = 48000) {
  invoke.mockImplementation((command: string) =>
    command === 'file_read_text' ? Promise.resolve(definition) : Promise.resolve(wavBytes(rate))
  );
}

beforeEach(() => {
  invoke.mockReset();
  Sampler.mockClear();
  start.mockReset();
  stop.mockReset();
  dispose.mockReset();
  resetSfzSampleCache();
  resetSfzCatalog();
  (window as unknown as Record<string, unknown>)[MARKER] = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[MARKER];
});

describe('loading', () => {
  it('reads the definition and each sample it names', async () => {
    nativeFiles();
    await new SfzInstrument(mockContext(), SFZ_PATH).load();

    expect(invoke).toHaveBeenCalledWith('file_read_text', { path: SFZ_PATH });
    expect(invoke).toHaveBeenCalledWith('file_read_bytes', {
      path: 'C:/lib/Ocarina/samples/F#4.wav',
    });
    expect(invoke).toHaveBeenCalledWith('file_read_bytes', {
      path: 'C:/lib/Ocarina/samples/E5_01.wav',
    });
  });

  it('reads a sample named by two regions only once', async () => {
    nativeFiles(`
      <region> key=60 sample=samples/a.wav
      <region> key=61 sample=samples/a.wav
    `);
    await new SfzInstrument(mockContext(), SFZ_PATH).load();

    const reads = invoke.mock.calls.filter(c => c[0] === 'file_read_bytes');
    expect(reads).toHaveLength(1);
  });

  it('does not read a library a second instrument already pulled across', async () => {
    nativeFiles();
    await new SfzInstrument(mockContext(), SFZ_PATH).load();
    invoke.mockClear();
    nativeFiles();

    await new SfzInstrument(mockContext(), SFZ_PATH).load();

    expect(invoke.mock.calls.filter(c => c[0] === 'file_read_bytes')).toHaveLength(0);
  });

  it('is idempotent, since Play calls it on every press', async () => {
    nativeFiles();
    const instrument = new SfzInstrument(mockContext(), SFZ_PATH);

    await Promise.all([instrument.load(), instrument.load()]);
    await instrument.load();

    expect(invoke.mock.calls.filter(c => c[0] === 'file_read_text')).toHaveLength(1);
    expect(Sampler).toHaveBeenCalledTimes(1);
  });

  it('reports itself loaded only once smplr is ready', async () => {
    nativeFiles();
    const instrument = new SfzInstrument(mockContext(), SFZ_PATH);

    expect(instrument.isLoaded).toBe(false);
    await instrument.load();
    expect(instrument.isLoaded).toBe(true);
  });

  it('renders into the bus it was given, not straight at the destination', async () => {
    nativeFiles();
    const ctx = mockContext();
    await new SfzInstrument(ctx, SFZ_PATH, ctx.destination).load();

    expect(Sampler.mock.calls[0][1].destination).toBeDefined();
    expect(Sampler.mock.calls[0][1].destination).not.toBe(ctx.destination);
  });

  it('builds no player when disposed while the files were being read', async () => {
    nativeFiles();
    const instrument = new SfzInstrument(mockContext(), SFZ_PATH);

    const loading = instrument.load();
    instrument.dispose();
    await loading;

    expect(Sampler).not.toHaveBeenCalled();
  });
});

describe('the preset it builds', () => {
  it('says what the SFZ said about ranges and centres', async () => {
    nativeFiles();
    await new SfzInstrument(mockContext(), SFZ_PATH).load();

    expect(presetGiven().groups[0].regions[0]).toMatchObject({
      sample: 'samples/F#4',
      keyRange: [60, 70],
      pitch: 66,
      ampRelease: 0.4,
    });
  });

  it('converts loop points at the file\u2019s rate, not the decoded buffer\u2019s', async () => {
    // The regression this design exists for. The file is 48000 and the context
    // decodes to 44100; dividing by the latter would put the loop ~9% out.
    nativeFiles();
    await new SfzInstrument(mockContext(), SFZ_PATH).load();

    const region = presetGiven().groups[0].regions[0];
    expect(region.loop).toBe(true);
    expect(region.loopStart).toBeCloseTo(14805 / 48000, 10);
    expect(region.loopEnd).toBeCloseTo(45028 / 48000, 10);
    expect(region.loopStart).not.toBeCloseTo(14805 / 44100, 6);
  });

  it('leaves a region unlooped when its header will not parse', async () => {
    invoke.mockImplementation((command: string) =>
      command === 'file_read_text'
        ? Promise.resolve(DEFINITION)
        : Promise.resolve(Uint8Array.from([1, 2, 3, 4]).buffer)
    );
    await new SfzInstrument(mockContext(), SFZ_PATH).load();

    expect(presetGiven().groups[0].regions[0].loopStart).toBeUndefined();
  });

  it('hands smplr the decoded buffers, keyed without the extension', async () => {
    nativeFiles();
    await new SfzInstrument(mockContext(), SFZ_PATH).load();

    expect([...(await buffersGiven()).keys()]).toEqual(['samples/F#4', 'samples/E5_01']);
  });

  it('plays the samples it could read when one of them is missing', async () => {
    invoke.mockImplementation((command: string, args: { path: string }) => {
      if (command === 'file_read_text') return Promise.resolve(DEFINITION);
      return args.path.includes('E5_01')
        ? Promise.reject(new Error('no such file'))
        : Promise.resolve(wavBytes());
    });

    const instrument = new SfzInstrument(mockContext(), SFZ_PATH);
    await expect(instrument.load()).resolves.toBeUndefined();

    expect(instrument.isLoaded).toBe(true);
    expect([...(await buffersGiven()).keys()]).toEqual(['samples/F#4']);
  });
});

describe('playing', () => {
  const loaded = async (currentTime = 12) => {
    nativeFiles();
    const instrument = new SfzInstrument(mockContext(currentTime), SFZ_PATH);
    await instrument.load();
    return instrument;
  };

  it('takes its clock from the audio context', async () => {
    expect((await loaded(7)).now()).toBe(7);
  });

  it('schedules a note at the absolute time it was given', async () => {
    const instrument = await loaded();
    instrument.schedule({ midiNote: 64, velocity: 90, when: 12.5, duration: 0.5 });

    expect(start).toHaveBeenCalledWith({
      note: 64,
      velocity: 90,
      time: 12.5,
      duration: 0.5,
    });
  });

  it('holds a sustained note until the stopper is called', async () => {
    const stopper = vi.fn();
    start.mockReturnValue(stopper);
    const instrument = await loaded();

    const release = instrument.sustain({ midiNote: 60, velocity: 100 });

    expect(start).toHaveBeenCalledWith({ note: 60, velocity: 100 });
    release();
    expect(stopper).toHaveBeenCalled();
  });

  it('makes no sound once disposed', async () => {
    const instrument = await loaded();
    instrument.dispose();

    instrument.schedule({ midiNote: 60, velocity: 100, when: 1, duration: 1 });
    instrument.sustain({ midiNote: 60, velocity: 100 })();

    expect(start).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
  });

  it('cuts everything sounding', async () => {
    (await loaded()).stopAll();
    expect(stop).toHaveBeenCalled();
  });

  it('names itself from the file, for a library it has never seen', async () => {
    expect(new SfzInstrument(mockContext(), SFZ_PATH).name).toBe('Ocarina 20241002');
  });
});
