import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * smplr is a module boundary that needs the network and real Web Audio, so it is
 * mocked wholesale. What matters here is the adapter's contract: that `when`
 * reaches smplr as an absolute `time`, and that the graph is wired through the
 * adapter's own bus rather than straight at the destination.
 */
const pianoStart = vi.fn();
const pianoStop = vi.fn();
const pianoDispose = vi.fn();
let readyResolve: () => void;
let capturedOptions: Record<string, unknown> | undefined;

vi.mock('smplr', () => ({
  SplendidGrandPiano: vi.fn((_ctx: unknown, options?: Record<string, unknown>) => {
    capturedOptions = options;
    return {
      ready: new Promise<void>(resolve => {
        readyResolve = resolve;
      }),
      start: pianoStart,
      stop: pianoStop,
      dispose: pianoDispose,
    };
  }),
}));

const storage = { id: 'sample-storage' };
vi.mock('@/engine/sampleCache', () => ({ sampleStorage: () => storage }));

import { SmplrPianoInstrument, MASTER_GAIN } from '@/engine/smplrPiano';

interface MockNode {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockGainParam {
  value: number;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
}

function createMockAudioContext() {
  const gainNodes: Array<MockNode & { gain: MockGainParam }> = [];
  const compressorNodes: MockNode[] = [];
  const destination = { id: 'destination' };

  const ctx = {
    currentTime: 4.25,
    destination,
    createGain: vi.fn(() => {
      // `setValueAtTime` writes through to `value` so the assertions below can read
      // the level off the node, the way they could when the bus assigned it directly.
      const gain: MockGainParam = {
        value: 1,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn((value: number) => {
          gain.value = value;
        }),
        linearRampToValueAtTime: vi.fn(),
      };
      const node = { gain, connect: vi.fn(), disconnect: vi.fn() };
      gainNodes.push(node);
      return node;
    }),
    createDynamicsCompressor: vi.fn(() => {
      const node = {
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      compressorNodes.push(node);
      return node;
    }),
  };

  return { ctx: ctx as unknown as AudioContext, gainNodes, compressorNodes, destination };
}

describe('SmplrPianoInstrument', () => {
  let mock: ReturnType<typeof createMockAudioContext>;
  let piano: SmplrPianoInstrument;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions = undefined;
    mock = createMockAudioContext();
    piano = new SmplrPianoInstrument(mock.ctx);
  });

  describe('audio graph', () => {
    it('routes master gain through a limiter into the destination', () => {
      const [masterGain] = mock.gainNodes;
      const [limiter] = mock.compressorNodes;

      expect(masterGain.connect).toHaveBeenCalledWith(limiter);
      expect(limiter.connect).toHaveBeenCalledWith(mock.destination);
    });

    it('leaves headroom rather than summing voices at unity gain', () => {
      expect(mock.gainNodes[0].gain.value).toBe(MASTER_GAIN);
      expect(MASTER_GAIN).toBeLessThan(1);
    });

    it('sends smplr into its own bus, not straight at the destination', () => {
      piano.load();
      expect(capturedOptions?.destination).toBe(mock.gainNodes[0]);
      expect(capturedOptions?.destination).not.toBe(mock.destination);
    });
  });

  describe('now', () => {
    it('reports the audio context clock', () => {
      expect(piano.now()).toBe(4.25);
    });
  });

  describe('load', () => {
    it('is not loaded until the samples resolve', async () => {
      expect(piano.isLoaded).toBe(false);
      const loading = piano.load();
      expect(piano.isLoaded).toBe(false);

      readyResolve();
      await loading;
      expect(piano.isLoaded).toBe(true);
    });

    it('fetches through the persistent sample cache, not plain http', () => {
      piano.load();
      expect(capturedOptions?.storage).toBe(storage);
    });

    it('fetches the samples once however often it is called', async () => {
      const { SplendidGrandPiano } = await import('smplr');
      const first = piano.load();
      const second = piano.load();

      readyResolve();
      await Promise.all([first, second]);

      expect(SplendidGrandPiano).toHaveBeenCalledTimes(1);
      expect(first).toBe(second);
    });
  });

  describe('schedule', () => {
    beforeEach(async () => {
      const loading = piano.load();
      readyResolve();
      await loading;
    });

    it('passes `when` through as an absolute time', () => {
      piano.schedule({ midiNote: 60, velocity: 100, when: 9.75, duration: 0.5 });

      expect(pianoStart).toHaveBeenCalledWith({
        note: 60,
        velocity: 100,
        time: 9.75,
        duration: 0.5,
      });
    });

    it('schedules each note of a chord at the same time', () => {
      for (const midiNote of [60, 64, 67]) {
        piano.schedule({ midiNote, velocity: 90, when: 2, duration: 1 });
      }

      const times = pianoStart.mock.calls.map(([event]) => event.time);
      expect(times).toEqual([2, 2, 2]);
      expect(pianoStart.mock.calls.map(([event]) => event.note)).toEqual([60, 64, 67]);
    });

    it('retriggering a pitch adds a voice instead of cutting the previous one', () => {
      piano.schedule({ midiNote: 60, velocity: 100, when: 1, duration: 2 });
      piano.schedule({ midiNote: 60, velocity: 100, when: 1.5, duration: 2 });

      expect(pianoStart).toHaveBeenCalledTimes(2);
      expect(pianoStop).not.toHaveBeenCalled();
    });

    it('does nothing after dispose rather than throwing', () => {
      piano.dispose();
      expect(() =>
        piano.schedule({ midiNote: 60, velocity: 100, when: 1, duration: 1 })
      ).not.toThrow();
      expect(pianoStart).not.toHaveBeenCalled();
    });
  });

  describe('stopAll', () => {
    it('stops everything sounding and pending', async () => {
      const loading = piano.load();
      readyResolve();
      await loading;

      piano.stopAll();
      expect(pianoStop).toHaveBeenCalledWith();
    });

    it('is safe before anything has loaded', () => {
      expect(() => piano.stopAll()).not.toThrow();
    });
  });

  describe('setVolume', () => {
    it('scales within the headroom', () => {
      piano.setVolume(0.5);
      expect(mock.gainNodes[0].gain.value).toBeCloseTo(0.5 * MASTER_GAIN, 10);
    });

    it('clamps out-of-range values', () => {
      piano.setVolume(1.5);
      expect(mock.gainNodes[0].gain.value).toBe(MASTER_GAIN);

      piano.setVolume(-1);
      expect(mock.gainNodes[0].gain.value).toBe(0);
    });
  });

  describe('rampVolume', () => {
    it('schedules a ramp on the bus rather than jumping the level', () => {
      piano.rampVolume(0.25, 9);
      expect(mock.gainNodes[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(
        0.25 * MASTER_GAIN,
        9
      );
    });
  });

  describe('dispose', () => {
    it('tears down smplr and the graph', async () => {
      const loading = piano.load();
      readyResolve();
      await loading;

      piano.dispose();

      expect(pianoDispose).toHaveBeenCalled();
      expect(mock.gainNodes[0].disconnect).toHaveBeenCalled();
      expect(mock.compressorNodes[0].disconnect).toHaveBeenCalled();
    });

    it('is idempotent', () => {
      piano.dispose();
      piano.dispose();
      expect(mock.gainNodes[0].disconnect).toHaveBeenCalledTimes(1);
    });
  });
});
