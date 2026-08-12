import { Soundfont } from 'smplr';
import type { Instrument, ScheduledNote } from '@/engine/instrument';
import { createInstrumentBus, type InstrumentBus } from '@/engine/instrumentBus';
import { gmLabel } from '@/engine/instrumentCatalog';
import { sampleStorage } from '@/engine/sampleCache';

/**
 * Any General MIDI melodic sound, via smplr's Soundfont.
 *
 * Deliberately the same shape as `SmplrPianoInstrument`: both are thin adapters
 * onto smplr sample players, and the scheduler cannot tell them apart. Samples come
 * from smplr's CDN on first load and out of the persistent sample cache thereafter.
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
      storage: sampleStorage(),
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

  /** Held until released, exactly as the piano's is. */
  sustain(note: { midiNote: number; velocity: number }): () => void {
    if (this.disposed || !this.player) return () => {};
    return this.player.start({ note: note.midiNote, velocity: note.velocity });
  }

  stopAll(): void {
    this.player?.stop();
  }

  setVolume(volume: number): void {
    this.bus.setVolume(volume);
  }

  rampVolume(volume: number, when: number): void {
    this.bus.rampVolume(volume, when);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.player?.dispose();
    this.player = null;
    this.bus.disconnect();
  }
}
