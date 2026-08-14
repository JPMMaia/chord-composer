/**
 * The seam between the sequencer and whatever actually makes sound.
 *
 * Deliberately narrow and time-based: an implementation is handed absolute times
 * and told to honour them, and nothing more. That is what lets a sampled piano
 * running in Web Audio and a natively-hosted VST3 sit behind the same interface —
 * the scheduler never learns which one it is driving.
 *
 * No React and no stores. Notes arrive already resolved to MIDI pitches and
 * seconds. The one project type named here is `AutomationTarget`, which is a
 * description of what to drive rather than a piece of the document — the
 * scheduler has to be able to say *which* knob, and there is no narrower way to.
 */

import type { AutomationTarget } from '@/types/music';

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

  /** Master volume, 0-1, applied immediately and cancelling any pending ramp. */
  setVolume(volume: number): void;

  /**
   * Ramp the master volume so it reads `volume` at `when` on this instrument's
   * clock — the same domain as `ScheduledNote.when`.
   *
   * Optional, like `sustain` and for the same kind of reason: a backend whose level
   * is set through something other than an audio graph has no way to promise a
   * value at a time. A caller without it steps `setVolume` once per scheduling
   * pass instead, which is coarser but never silent.
   */
  rampVolume?(volume: number, when: number): void;

  /**
   * Drive one of the instrument's own targets to `value` at `when` on its clock
   * — the same domain as `ScheduledNote.when`.
   *
   * `value` is normalised 0-1, which is both the range every level in this app
   * uses and the range VST3 works in, so a breakpoint travels from a curve to a
   * plugin unconverted.
   *
   * Optional, like `sustain` and `rampVolume`: a backend with no parameters to
   * drive has nothing to implement, and a caller finding it absent simply does
   * not automate that instrument. Unlike `rampVolume` there is no coarser
   * fallback, because there is nothing to fall back *to* — an instrument that
   * cannot be automated is not one whose parameters can be stepped instead.
   */
  automateTarget?(target: AutomationTarget, value: number, when: number): void;

  /**
   * State a target now rather than at a moment in the future.
   *
   * What pins a curve's value at Play, and what previews one while it is being
   * drawn. Present exactly when `automateTarget` is.
   */
  setTarget?(target: AutomationTarget, value: number): void;

  /** Release resources. The instrument is unusable afterwards. */
  dispose(): void;
}
