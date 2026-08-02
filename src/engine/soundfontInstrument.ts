import { Soundfont } from 'smplr';
import type { Instrument, ScheduledNote } from '@/engine/instrument';
import { createInstrumentBus, type InstrumentBus } from '@/engine/instrumentBus';
import { gmLabel } from '@/engine/instrumentCatalog';

/**
 * Any General MIDI melodic sound, via smplr's Soundfont.
 *
 * Deliberately the same shape as `SmplrPianoInstrument`: both are thin adapters
 * onto smplr sample players, and the scheduler cannot tell them apart. Samples come
 * from smplr's CDN on first load and are cached by the browser thereafter.
 */
export class SoundfontInstrument implements Instrument {
  readonly name: string;

  private ctx: AudioContext;
  private bus: InstrumentBus;
  private instrumentId: string;
  private player: ReturnType<typeof Soundfont> | null = null;
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private disposed = false;

  constructor(audioContext: AudioContext, instrumentId: string, destination?: AudioNode) {
    this.ctx = audioContext;
    this.instrumentId = instrumentId;
    this.name = gmLabel(instrumentId);
    this.bus = createInstrumentBus(audioContext, destination);
  }

  now(): number {
    return this.ctx.currentTime;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Idempotent, for the same reason the piano's is: Play calls it every time. */
  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;

    this.player = Soundfont(this.ctx, {
      instrument: this.instrumentId,
      destination: this.bus.input,
    });

    this.loadPromise = this.player.ready.then(() => {
      this.loaded = true;
    });

    return this.loadPromise;
  }

  schedule(note: ScheduledNote): void {
    if (this.disposed || !this.player) return;

    this.player.start({
      note: note.midiNote,
      velocity: note.velocity,
      time: note.when,
      duration: note.duration,
    });
  }

  stopAll(): void {
    this.player?.stop();
  }

  setVolume(volume: number): void {
    this.bus.setVolume(volume);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.player?.dispose();
    this.player = null;
    this.bus.disconnect();
  }
}
