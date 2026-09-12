import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/engine/platform';

/**
 * How hard the machine is asked to work to make sound, and how it is doing.
 *
 * Separate from `audioOutput`, which answers *where* the sound comes out. These
 * answer *how*: the block size the output device is asked for, and the counters
 * that say whether that size is big enough. Both are properties of the machine
 * rather than of the piece, so they live in `localStorage` beside the output
 * device and the SFZ library list rather than in the project file.
 *
 * The block size is the lever every sample library's manual reaches for first
 * when its sound crackles, and it earns that twice over. A block's deadline is
 * the time that block will play for, so asking for a longer one buys the plugins
 * longer to render it; and cpal passes the size to WASAPI as a buffer duration,
 * so the ring of already-rendered audio in front of the device grows with it and
 * a render that overruns eats slack instead of leaving a gap. The cost is
 * latency, in exactly the way a DAW's buffer setting costs latency.
 *
 * Nothing here means anything outside the desktop build: the block size belongs
 * to the native plugin engine, and a browser has no such control.
 */

/** Versioned so a future change of record shape can orphan the old value. */
export const AUDIO_PREFS_STORAGE_KEY = 'chord-composer-audio-prefs-v1';

/**
 * The block sizes offered, in frames.
 *
 * Powers of two because that is what audio hardware and every other host deals
 * in, and stopping at 4096 because beyond it the latency is longer than the gap
 * between a key and its sound being tolerable — around 85 ms at 48 kHz.
 */
export const BUFFER_SIZES = [256, 512, 1024, 2048, 4096] as const;

/**
 * Headroom offered, in milliseconds of audio kept ahead of the device.
 *
 * Zero renders inside the audio callback, which is what every session did before
 * rendering ahead existed, and is kept as a real choice rather than a disabled
 * one so the two can be compared by ear. Past 200 ms the delay between a key and
 * its sound is worse than the dropout it cures.
 */
export const HEADROOM_CHOICES = [0, 20, 50, 100, 200] as const;

/** What the app remembers about how it renders. */
export interface AudioPrefs {
  /**
   * Frames the output device is asked for per block. `null` asks for nothing,
   * which leaves the device on its own preference — around 480 frames on
   * Windows, and what every session had before this was settable.
   */
  bufferFrames: number | null;
  /**
   * Milliseconds of audio kept rendered in front of the device.
   *
   * The lever that actually breaks the link between a slow block and a gap: with
   * audio rendered ahead, a block that takes longer than its deadline spends
   * slack instead of leaving silence. 0 renders in the audio callback.
   */
  headroomMs: number;
  /**
   * Whether hosted instruments are put back as they loaded once the transport
   * has been idle a moment.
   *
   * A detailed sampled instrument can get slower the longer it plays, and no
   * buffer cures that — it only puts off the moment the shortfall is heard.
   * Reloading the instrument is what clears it, and Stop is when that is free.
   */
  resetOnStop: boolean;
}

/** The state of an unconfigured machine: whatever the hardware prefers. */
export const DEFAULT_AUDIO_PREFS: AudioPrefs = {
  bufferFrames: null,
  headroomMs: 0,
  resetOnStop: true,
};

/** What became of an attempt to change how the machine renders. */
export interface ApplyPrefsOutcome {
  /** Why it did not happen at all, if it did not. */
  error: string | null;
  /**
   * Why it did not happen quite as asked, if it did not — a block size the
   * device refused, say. The setting still applied; it is not the one running.
   */
  note: string | null;
}

/**
 * What the machine has been told to do, or the defaults.
 *
 * Every field is checked rather than trusted: this is hand-editable storage that
 * may have been written by an older build, and a bad number here would be asked
 * of an audio device.
 */
export function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(AUDIO_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_AUDIO_PREFS;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_AUDIO_PREFS;

    const { bufferFrames, headroomMs, resetOnStop } = parsed as {
      bufferFrames?: unknown;
      headroomMs?: unknown;
      resetOnStop?: unknown;
    };
    return {
      bufferFrames: (BUFFER_SIZES as readonly number[]).includes(bufferFrames as number)
        ? (bufferFrames as number)
        : null,
      headroomMs: (HEADROOM_CHOICES as readonly number[]).includes(headroomMs as number)
        ? (headroomMs as number)
        : 0,
      // Absent reads as on, so a machine configured before this existed gets it.
      resetOnStop: resetOnStop !== false,
    };
  } catch {
    // No storage, or nothing readable in it, is the same as no choice.
    return DEFAULT_AUDIO_PREFS;
  }
}

/** Remember how the machine should render. */
export function storeAudioPrefs(prefs: AudioPrefs): void {
  try {
    localStorage.setItem(AUDIO_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // The choice still applies to this session; it just will not be remembered.
  }
}

/**
 * Ask the output device for blocks of `frames`, or for whatever it prefers.
 *
 * Remembered whatever happens, on the same terms as the output device: a size
 * the hardware would not take today is still what the user asked for, and the
 * next machine or the next driver may well take it.
 *
 * Outside the desktop build this only remembers. There is no second engine to
 * tell, because there is no plugin engine at all.
 */
export async function applyBufferSize(frames: number | null): Promise<ApplyPrefsOutcome> {
  storeAudioPrefs({ ...loadAudioPrefs(), bufferFrames: frames });

  if (!isTauri()) return { error: null, note: null };

  try {
    const note = await invoke<string | null>('vst3_set_buffer_size', { frames });
    return { error: null, note: note ?? null };
  } catch (error) {
    return {
      error: typeof error === 'string' ? error : 'the plugin engine refused that block size',
      note: null,
    };
  }
}

/**
 * Keep `ms` of already-rendered audio in front of the device.
 *
 * Cannot fail the way a block size can: no stream is rebuilt, because nothing
 * about the device changes. The pump simply fills to a different level.
 */
export async function applyHeadroom(ms: number): Promise<void> {
  storeAudioPrefs({ ...loadAudioPrefs(), headroomMs: ms });

  if (!isTauri()) return;

  try {
    await invoke('vst3_set_headroom', { ms });
  } catch {
    // The choice is remembered and applies to the next engine; there is nothing
    // useful to say about a command that only exists where an engine does.
  }
}

/**
 * Put instruments back as they loaded once the transport has been idle.
 *
 * Read by `usePlayback` rather than pushed to the engine: the engine is told to
 * reset when the moment comes, so there is nothing to prime.
 */
export async function applyResetOnStop(on: boolean): Promise<void> {
  storeAudioPrefs({ ...loadAudioPrefs(), resetOnStop: on });
}

/**
 * Tell the plugin engine what this machine was last set to, at start-up.
 *
 * Without this the settings would only reach the engine when the dialog was
 * opened: the Rust side starts each session knowing nothing, so a block size
 * chosen last week would sit in storage looking applied and not be. Neither
 * command opens an audio device — they record the choice for whenever a plugin
 * is first loaded — so this costs a session with no plugins in it nothing.
 */
export async function primeAudioPrefs(): Promise<void> {
  if (!isTauri()) return;

  const prefs = loadAudioPrefs();
  await Promise.all([
    applyBufferSize(prefs.bufferFrames),
    prefs.headroomMs > 0 ? applyHeadroom(prefs.headroomMs) : Promise.resolve(),
  ]);
}

/** What the audio thread has cost since this was last asked. */
export interface AudioHealth {
  /** Callbacks that took longer than the audio they produced will play for. */
  late: number;
  /** The worst of them, in microseconds. */
  worstUs: number;
  /** Frames the device asked for and did not get. */
  starved: number;
  /** Render time over deadline. 1.0 means rendering took exactly as long as it had. */
  load: number;
  /** Frames in the last block the device asked for. */
  block: number;
  sampleRate: number;
}

/**
 * How the plugin engine is doing, or null when there is no engine running.
 *
 * Null is the honest answer for a session that has never loaded a plugin: a row
 * of confident zeroes would read as "nothing is dropping out" rather than as
 * "nothing is playing". Reading is destructive on the Rust side, so each call
 * answers the stretch since the last one — which is what makes it a reading of
 * now rather than a total that only ever grows.
 */
export async function readAudioHealth(): Promise<AudioHealth | null> {
  if (!isTauri()) return null;

  try {
    return (await invoke<AudioHealth | null>('vst3_audio_health')) ?? null;
  } catch {
    return null;
  }
}

/**
 * How long a block of `frames` takes to play, in milliseconds.
 *
 * The latency the block size costs, which is the whole of what it costs. Shown
 * beside the choice so it is a trade rather than a bigger-is-better dial.
 */
export function bufferLatencyMs(frames: number, sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  return (frames / sampleRate) * 1000;
}
