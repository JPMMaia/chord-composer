import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MASTER_GAIN, createInstrumentBus } from '@/engine/instrumentBus';

/** A GainNode stub recording the automation calls made against its gain param. */
function makeGain() {
  return {
    gain: {
      value: 0,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

let gain: ReturnType<typeof makeGain>;
let ctx: AudioContext;

beforeEach(() => {
  gain = makeGain();
  ctx = {
    currentTime: 10,
    createGain: () => gain,
    createDynamicsCompressor: () => ({
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    destination: {} as AudioNode,
  } as unknown as AudioContext;
});

describe('createInstrumentBus', () => {
  it('opens at the shared headroom', () => {
    createInstrumentBus(ctx, {} as AudioNode);
    expect(gain.gain.value).toBe(MASTER_GAIN);
  });

  it('connects straight to a supplied destination and owns no limiter', () => {
    const destination = {} as AudioNode;
    const bus = createInstrumentBus(ctx, destination);
    expect(gain.connect).toHaveBeenCalledWith(destination);
    bus.disconnect();
    expect(gain.disconnect).toHaveBeenCalled();
  });
});

describe('setVolume', () => {
  it('cancels pending automation before pinning the level', () => {
    const bus = createInstrumentBus(ctx, {} as AudioNode);
    bus.setVolume(0.5);

    expect(gain.gain.cancelScheduledValues).toHaveBeenCalledWith(10);
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0.5 * MASTER_GAIN, 10);
    // Cancel has to come first, or the pin is what gets cancelled.
    expect(gain.gain.cancelScheduledValues.mock.invocationCallOrder[0]).toBeLessThan(
      gain.gain.setValueAtTime.mock.invocationCallOrder[0]
    );
  });

  it('clamps out-of-range levels', () => {
    const bus = createInstrumentBus(ctx, {} as AudioNode);
    bus.setVolume(3);
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(MASTER_GAIN, 10);
    bus.setVolume(-1);
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 10);
  });

  it('ignores a non-finite level rather than silencing the instrument', () => {
    const bus = createInstrumentBus(ctx, {} as AudioNode);
    bus.setVolume(Number.NaN);
    expect(gain.gain.setValueAtTime).not.toHaveBeenCalled();
  });
});

describe('rampVolume', () => {
  it('ramps to the level, scaled by the headroom, arriving at the given time', () => {
    const bus = createInstrumentBus(ctx, {} as AudioNode);
    bus.rampVolume(0.25, 12.5);
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.25 * MASTER_GAIN, 12.5);
  });

  it('does not cancel: ramps chain breakpoint to breakpoint', () => {
    const bus = createInstrumentBus(ctx, {} as AudioNode);
    bus.rampVolume(0.25, 12.5);
    bus.rampVolume(1, 16);
    expect(gain.gain.cancelScheduledValues).not.toHaveBeenCalled();
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledTimes(2);
  });

  it('clamps the level and ignores a non-finite time', () => {
    const bus = createInstrumentBus(ctx, {} as AudioNode);
    bus.rampVolume(2, 12);
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(MASTER_GAIN, 12);

    bus.rampVolume(0.5, Number.NaN);
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledTimes(1);
  });
});
