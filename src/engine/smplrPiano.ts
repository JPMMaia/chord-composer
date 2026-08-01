import { SplendidGrandPiano } from 'smplr';
import type { Instrument, ScheduledNote } from '@/engine/instrument';

/**
 * A sampled acoustic grand, via smplr's SplendidGrandPiano.
 *
 * Samples are fetched from smplr's CDN on first load, so the very first Play in a
 * session waits on the network; the browser caches them afterwards.
 */

/**
 * Headroom. A chord segment sounds every note of the chord at once, and several
 * segments can overlap, so summing voices at full scale clips. 0.7 leaves room
 * for a handful of simultaneous notes without a limiter.
 */
export const MASTER_GAIN = 0.7;

export class SmplrPianoInstrument implements Instrument {
  readonly name = 'Acoustic Grand Piano';

  private ctx: AudioContext;
  private masterGain: GainNode;
  private limiter: DynamicsCompressorNode;
  private piano: ReturnType<typeof SplendidGrandPiano> | null = null;
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private disposed = false;

  constructor(audioContext: AudioContext) {
    this.ctx = audioContext;

    // master -> limiter -> destination. The limiter is what keeps a six-note chord
    // from clipping when its voices sum, rather than trusting the gain alone.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.limiter.connect(this.ctx.destination);

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = MASTER_GAIN;
    this.masterGain.connect(this.limiter);
  }

  now(): number {
    return this.ctx.currentTime;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Idempotent: the hook calls this on every Play, but the samples are fetched
   * once and every later call awaits the same promise.
   */
  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;

    this.piano = SplendidGrandPiano(this.ctx, {
      destination: this.masterGain,
    });

    this.loadPromise = this.piano.ready.then(() => {
      this.loaded = true;
    });

    return this.loadPromise;
  }

  schedule(note: ScheduledNote): void {
    if (this.disposed || !this.piano) return;

    this.piano.start({
      note: note.midiNote,
      velocity: note.velocity,
      time: note.when,
      duration: note.duration,
    });
  }

  /**
   * Cuts pending notes as well as sounding ones — smplr's `stop()` with no target
   * clears its own scheduler, which is what makes Stop take effect immediately
   * rather than after everything already queued has played.
   */
  stopAll(): void {
    this.piano?.stop();
  }

  setVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.masterGain.gain.value = clamped * MASTER_GAIN;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.piano?.dispose();
    this.piano = null;
    this.masterGain.disconnect();
    this.limiter.disconnect();
  }
}
