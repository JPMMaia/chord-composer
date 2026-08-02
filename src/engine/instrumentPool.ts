import type { Track } from '@/types/music';
import type { Instrument } from '@/engine/instrument';
import { configureLimiter } from '@/engine/instrumentBus';
import { DEFAULT_INSTRUMENT_ID } from '@/engine/instrumentCatalog';
import { SmplrPianoInstrument } from '@/engine/smplrPiano';
import { SoundfontInstrument } from '@/engine/soundfontInstrument';

/**
 * One live `Instrument` per project track.
 *
 * The pool is what turns the project's list of instruments into sound. It owns the
 * single limiter every instrument renders through — with one limiter each, N
 * instruments would sum unlimited at the destination and clip exactly when the
 * arrangement got busy — and it reconciles itself against the track list rather
 * than being told what changed, so a rename, a re-order or a swapped sound all
 * arrive through the same call.
 *
 * The clock comes from here rather than from any one instrument, so the scheduler's
 * frame of reference survives instruments being added and removed mid-session.
 */
export class InstrumentPool {
  private ctx: AudioContext;
  private limiter: DynamicsCompressorNode;
  private entries = new Map<string, { instrumentId: string; instrument: Instrument }>();
  private disposed = false;

  constructor(audioContext: AudioContext) {
    this.ctx = audioContext;
    this.limiter = configureLimiter(audioContext.createDynamicsCompressor());
    this.limiter.connect(audioContext.destination);
  }

  /** The shared clock, in seconds — the domain of `ScheduledNote.when`. */
  now(): number {
    return this.ctx.currentTime;
  }

  /**
   * Bring the pool in line with the project's instruments: build what is new,
   * rebuild anything whose sound changed, and dispose what is gone.
   *
   * An instrument whose sound is unchanged is left strictly alone, so editing one
   * instrument never re-downloads another's samples.
   */
  ensure(tracks: Track[]): void {
    if (this.disposed) return;

    const live = new Set(tracks.map(t => t.id));
    for (const [trackId, entry] of this.entries) {
      if (!live.has(trackId)) {
        entry.instrument.dispose();
        this.entries.delete(trackId);
      }
    }

    for (const track of tracks) {
      const instrumentId = track.instrument || DEFAULT_INSTRUMENT_ID;
      const existing = this.entries.get(track.id);

      if (existing) {
        if (existing.instrumentId === instrumentId) {
          existing.instrument.setVolume(track.volume);
          continue;
        }
        // The sound changed, so the old sampler is of no further use.
        existing.instrument.dispose();
      }

      const instrument = this.create(instrumentId);
      instrument.setVolume(track.volume);
      this.entries.set(track.id, { instrumentId, instrument });
    }
  }

  /**
   * The acoustic grand gets smplr's dedicated piano; everything else goes through
   * the GM soundfont. This is the one place that distinction is made.
   */
  private create(instrumentId: string): Instrument {
    return instrumentId === DEFAULT_INSTRUMENT_ID
      ? new SmplrPianoInstrument(this.ctx, this.limiter)
      : new SoundfontInstrument(this.ctx, instrumentId, this.limiter);
  }

  get(trackId: string): Instrument | undefined {
    return this.entries.get(trackId)?.instrument;
  }

  /** Whether every instrument currently in the pool can make sound. */
  get isLoaded(): boolean {
    return [...this.entries.values()].every(entry => entry.instrument.isLoaded);
  }

  /**
   * Resolve once every instrument is ready. Loading them together rather than in
   * turn means a five-instrument project waits for the slowest download, not the
   * sum of all five.
   */
  async loadAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map(entry => entry.instrument.load()));
  }

  stopAll(): void {
    for (const entry of this.entries.values()) entry.instrument.stopAll();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) entry.instrument.dispose();
    this.entries.clear();
    this.limiter.disconnect();
  }
}

/**
 * Whether a track should be heard, given the project's mute and solo state.
 *
 * Solo is a project-wide mode rather than a per-track flag: the moment any track is
 * soloed, every track that is not becomes silent. Mute still wins over solo, so
 * soloing a muted track does not un-mute it.
 */
export function isTrackAudible(track: Track, tracks: Track[]): boolean {
  if (track.muted) return false;
  const anySoloed = tracks.some(t => t.solo);
  return !anySoloed || track.solo;
}
