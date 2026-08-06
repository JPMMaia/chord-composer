/**
 * The seam between the sequencer and whatever actually makes sound.
 *
 * Deliberately narrow and time-based: an implementation is handed absolute times
 * and told to honour them, and nothing more. That is what lets a sampled piano
 * running in Web Audio and a natively-hosted VST3 sit behind the same interface —
 * the scheduler never learns which one it is driving.
 *
 * No React, no stores, no project types. Notes arrive already resolved to MIDI
 * pitches and seconds.
 */

/** A single note, fully resolved against the instrument's own clock. */
export interface ScheduledNote {
  /** MIDI pitch, 0-127. */
  midiNote: number;
  /** MIDI velocity, 0-127. */
  velocity: number;
  /** Absolute time on the instrument's clock, in seconds. Usually in the future. */
  when: number;
  /** Sounding length in seconds. */
  duration: number;
}

export interface Instrument {
  /** Human-readable name, for the UI. */
  readonly name: string;

  /**
   * The instrument's own clock, in seconds, matching the domain of
   * `ScheduledNote.when`.
   *
   * The scheduler reads time from here rather than from an `AudioContext` it
   * owns, so a backend whose audio lives outside the browser can supply its own
   * clock without the scheduler changing.
   */
  now(): number;

  /** Resolves once the instrument can make sound. Safe to call more than once. */
  load(): Promise<void>;

  readonly isLoaded: boolean;

  /**
   * Schedule one note. Must be sample-accurate with respect to `when`; an
   * implementation may not simply play the note on arrival.
   */
  schedule(note: ScheduledNote): void;

  /**
   * Start a note now and hold it until the returned function is called.
   *
   * The one departure from this interface's time-based rule, and a deliberate one:
   * a key being held down has no duration yet, so live playing cannot be expressed
   * as a `ScheduledNote`. Optional, because not every backend can retract a note it
   * has already handed on — a caller with no `sustain` falls back to a short
   * `schedule`, which is a worse preview but never a stuck one.
   */
  sustain?(note: { midiNote: number; velocity: number }): () => void;

  /** Cut everything sounding or pending, immediately. */
  stopAll(): void;

  /** Master volume, 0-1. */
  setVolume(volume: number): void;

  /** Release resources. The instrument is unusable afterwards. */
  dispose(): void;
}
