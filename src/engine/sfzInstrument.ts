import { Sampler } from 'smplr';
import type { Instrument, ScheduledNote } from '@/engine/instrument';
import { createInstrumentBus, type InstrumentBus } from '@/engine/instrumentBus';
import { directoryOf, readLocalBytes, readLocalText, resolvePath } from '@/engine/localFile';
import { parseSfz, sampleKey, sfzSamples, sfzToPreset } from '@/engine/sfzParser';
import { sfzNameFor } from '@/engine/sfzCatalog';
import { wavSampleRate } from '@/engine/wavHeader';

/**
 * A sample set the user already has on disk, described by an `.sfz` file.
 *
 * The same shape as `SoundfontInstrument` — a thin adapter onto one of smplr's sample
 * players — with one real difference: where the soundfont fetches its notes from a CDN
 * and lets smplr decode them, this reads the files itself and hands smplr the finished
 * buffers through its `loader` seam.
 *
 * That is not a preference. Two things force it:
 *
 * - Loop points. SFZ counts them in frames, Web Audio in seconds, so converting needs
 *   the rate the *file* was recorded at. `decodeAudioData` resamples to the audio
 *   context's rate, so asking the decoded buffer gives the wrong number — 48 kHz
 *   samples in a 44.1 kHz context would put every loop about 9% out. The rate has to
 *   come from the WAV header, before decoding, and the preset has to carry the result
 *   before the player is built from it.
 * - Paths. smplr percent-escapes `#` and spaces on its way to a URL, which is right
 *   for a CDN and wrong for `.../Ocarina SFZ+WAV/samples/F#4.wav`. Loading the bytes
 *   ourselves keeps the escaping away from something that was never a URL.
 */
export class SfzInstrument implements Instrument {
  readonly name: string;

  private ctx: AudioContext;
  private bus: InstrumentBus;
  private path: string;
  private player: ReturnType<typeof Sampler> | null = null;
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private disposed = false;

  constructor(audioContext: AudioContext, path: string, destination?: AudioNode) {
    this.ctx = audioContext;
    this.path = path;
    this.name = sfzNameFor(path);
    this.bus = createInstrumentBus(audioContext, destination);
  }

  now(): number {
    return this.ctx.currentTime;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Idempotent, like every other instrument's: Play calls it on every press. */
  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.read();
    return this.loadPromise;
  }

  private async read(): Promise<void> {
    const definition = await readLocalText(this.path);
    const parsed = parseSfz(definition);
    const directory = directoryOf(this.path);

    const samples = await Promise.all(
      sfzSamples(parsed).map(sample => this.readSample(directory, sample))
    );

    // A dispose while the files were being read: building a player now would leave
    // one running with nothing to stop it.
    if (this.disposed) return;

    const rates = new Map<string, number>();
    const buffers = new Map<string, AudioBuffer>();
    for (const loaded of samples) {
      if (!loaded) continue;
      if (loaded.sampleRate !== undefined) rates.set(loaded.sample, loaded.sampleRate);
      buffers.set(sampleKey(loaded.sample), loaded.buffer);
    }

    const preset = sfzToPreset(parsed, {
      baseUrl: directory,
      sampleRate: sample => rates.get(sample),
    });

    this.player = Sampler(this.ctx, {
      preset,
      destination: this.bus.input,
      // Every buffer is decoded already, so there is nothing to fetch. smplr keys
      // them by `region.sample`, which is what `sampleKey` produced above.
      loader: { load: async () => buffers },
    });

    await this.player.ready;
    this.loaded = true;
  }

  /**
   * One sample, read and decoded, or null if it could not be.
   *
   * A missing or unreadable file is not fatal: smplr simply finds no buffer for that
   * region, so the rest of the instrument still plays. Half an ocarina beats none, and
   * beats an error the user cannot act on mid-performance.
   */
  private async readSample(
    directory: string,
    sample: string
  ): Promise<{ sample: string; buffer: AudioBuffer; sampleRate: number | undefined } | null> {
    const path = resolvePath(directory, sample);

    try {
      const bytes = await cachedBytes(path);
      // Before decoding, and from our own copy: `decodeAudioData` detaches the buffer
      // it is given, which would empty the cached entry for the next instrument.
      //
      // Deliberately *not* falling back to `buffer.sampleRate` when the header cannot
      // be read. That number is the context's rate, not the file's, so using it to
      // divide frame counts would put every loop point out by whatever resampling
      // did — which is the mistake this whole path exists to avoid. An unknown rate
      // means the region plays through instead, which is merely a worse note.
      const sampleRate = wavSampleRate(bytes);
      const buffer = await this.ctx.decodeAudioData(bytes.slice(0));

      return { sample, buffer, sampleRate };
    } catch (err) {
      console.warn(`sfz: could not load ${path}`, err);
      return null;
    }
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

  /** Held until released, exactly as the soundfont's is. */
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.player?.dispose();
    this.player = null;
    this.bus.disconnect();
  }
}

/**
 * The bytes of every sample read this session, by absolute path.
 *
 * Duplicating a track, or changing an instrument and changing it back, otherwise means
 * pulling the whole library across the IPC bridge again — several megabytes for a
 * modest sample set. Raw bytes rather than decoded buffers, so nothing here is tied to
 * an `AudioContext` that a later Play may have replaced.
 *
 * In-memory only: these files are on this machine already, so there is nothing a
 * persistent cache would save that the filesystem does not.
 */
const bytesByPath = new Map<string, Promise<ArrayBuffer>>();

function cachedBytes(path: string): Promise<ArrayBuffer> {
  const cached = bytesByPath.get(path);
  if (cached) return cached;

  // A failed read is not cached: the file may simply have been busy, and the next
  // Play should be free to try again.
  const reading = readLocalBytes(path).catch(err => {
    bytesByPath.delete(path);
    throw err;
  });

  bytesByPath.set(path, reading);
  return reading;
}

/** Drop the cached sample bytes. Exists for tests. */
export function resetSfzSampleCache(): void {
  bytesByPath.clear();
}
