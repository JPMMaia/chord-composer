/**
 * The gain stage every sampled instrument sits behind.
 *
 * Shared by the piano and the soundfont adapters so headroom and limiting are
 * defined once. A bus either owns its limiter (a lone instrument, wired straight at
 * the destination) or feeds one somebody else owns — which is what lets the
 * instrument pool put a *single* limiter downstream of every instrument. With one
 * limiter each, N instruments would sum unlimited at the destination and clip
 * exactly when the arrangement got busy.
 */

/**
 * Headroom. A chord segment sounds every note of the chord at once, and several
 * segments can overlap, so summing voices at full scale clips. 0.7 leaves room
 * for a handful of simultaneous notes without a limiter.
 */
export const MASTER_GAIN = 0.7;

/** Configure a compressor as the brick-wall limiter this app expects. */
export function configureLimiter(limiter: DynamicsCompressorNode): DynamicsCompressorNode {
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  return limiter;
}

export interface InstrumentBus {
  /** Node an instrument should render into. */
  readonly input: GainNode;
  /**
   * Set this instrument's level, 0-1, within the shared headroom, *now*.
   *
   * Cancels anything previously scheduled, which is what makes it the reset used
   * at Play and Stop: a run must not inherit the level a fade in the last one
   * happened to end on.
   */
  setVolume(volume: number): void;
  /**
   * Ramp linearly to `volume`, arriving at `when` on the context clock.
   *
   * Deliberately writes no starting value: automation is scheduled breakpoint by
   * breakpoint in order, so the previous event is already the anchor, and pinning
   * one here would flatten every ramp into a step at its own arrival time.
   */
  rampVolume(volume: number, when: number): void;
  disconnect(): void;
}

/**
 * Build an instrument's output stage.
 *
 * @param ctx - The audio context.
 * @param destination - Where to send it. Omitted, the bus creates its own limiter
 *   and wires to `ctx.destination`; supplied, it connects straight there and leaves
 *   limiting to whoever owns that node.
 */
export function createInstrumentBus(
  ctx: AudioContext,
  destination?: AudioNode
): InstrumentBus {
  let limiter: DynamicsCompressorNode | null = null;

  const input = ctx.createGain();
  input.gain.value = MASTER_GAIN;

  if (destination) {
    input.connect(destination);
  } else {
    limiter = configureLimiter(ctx.createDynamicsCompressor());
    limiter.connect(ctx.destination);
    input.connect(limiter);
  }

  /** A level as a gain figure, or null when it is not a number at all. */
  const gainFor = (volume: number): number | null =>
    Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) * MASTER_GAIN : null;

  return {
    input,
    setVolume(volume: number) {
      const gain = gainFor(volume);
      if (gain === null) return;

      // Cancel first: a pending ramp scheduled past `now` would otherwise sail
      // straight over the value being pinned here.
      input.gain.cancelScheduledValues(ctx.currentTime);
      input.gain.setValueAtTime(gain, ctx.currentTime);
    },
    rampVolume(volume: number, when: number) {
      const gain = gainFor(volume);
      if (gain === null || !Number.isFinite(when)) return;

      input.gain.linearRampToValueAtTime(gain, when);
    },
    disconnect() {
      input.disconnect();
      limiter?.disconnect();
    },
  };
}
