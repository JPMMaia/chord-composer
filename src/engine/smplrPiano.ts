import { SplendidGrandPiano } from 'smplr';
import type { Instrument, ScheduledNote } from '@/engine/instrument';
import { createInstrumentBus, MASTER_GAIN, type InstrumentBus } from '@/engine/instrumentBus';
import { sampleStorage } from '@/engine/sampleCache';

/**
 * A sampled acoustic grand, via smplr's SplendidGrandPiano.
 *
 * Kept alongside the general soundfont adapter — rather than routing the piano
 * through GM program 0 like every other sound — because this is a markedly better
 * piano, and the piano is the instrument every project starts with.
 *
 * Samples are fetched from smplr's CDN on first load, so the very first Play waits
 * on the network; they go into the persistent sample cache, so later sessions do not.
 */

export { MASTER_GAIN };

export class SmplrPianoInstrument implements Instrument {
  readonly name = 'Acoustic Grand Piano';

  private ctx: AudioContext;
  private bus: InstrumentBus;
  private piano: ReturnType<typeof SplendidGrandPiano> | null = null;
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private disposed = false;

  /**
   * @param destination - Where to render. Omitted, the instrument builds its own
   *   limiter and wires to the context destination, which is right for a lone
   *   instrument; the pool passes its shared limiter instead.
   */
  constructor(audioContext: AudioContext, destination?: AudioNode) {
    this.ctx = audioContext;
    this.bus = createInstrumentBus(audioContext, destination);
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
      destination: this.bus.input,
      storage: sampleStorage(),
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
   * smplr's `start` already returns the stopper for the voices it began, so holding
   * a note is just declining to call it yet.
   */
  sustain(note: { midiNote: number; velocity: number }): () => void {
    if (this.disposed || !this.piano) return () => {};
    return this.piano.start({ note: note.midiNote, velocity: note.velocity });
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
    this.bus.setVolume(volume);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.piano?.dispose();
    this.piano = null;
    this.bus.disconnect();
  }
}
