/**
 * How a MIDI keyboard's touch is read.
 *
 * Keyboards differ in how hard a key has to be struck to reach a given velocity,
 * and one that needs a heavy hand to sound loud makes every take come out quiet.
 * The cure every keyboard and DAW offers is a velocity curve: the same press is
 * bent towards louder (a light touch) or softer (a hard one), while a full-force
 * press still reaches the top. That is what this is.
 *
 * A property of the player and their keyboard rather than of the piece, so it
 * lives in `localStorage` beside the audio preferences rather than in the project
 * file.
 */

/** Versioned so a future change of record shape can orphan the old value. */
export const MIDI_PREFS_STORAGE_KEY = 'chord-composer-midi-prefs-v1';

/** The ends of the touch scale: hardest to lightest. */
export const TOUCH_MIN = -100;
export const TOUCH_MAX = 100;

/** The highest floor that still leaves the curve a step to climb. */
export const MIN_VELOCITY_MAX = 126;

/** What the app remembers about how a keyboard is played. */
export interface MidiPrefs {
  /**
   * How light the touch is, from -100 (hard) to +100 (light). 0 passes velocity
   * through untouched. Each 50 halves or doubles the curve's exponent.
   */
  touch: number;
  /** The quietest a pressed key can sound, 0-126. 0 leaves the bottom alone. */
  minVelocity: number;
}

/** The keyboard as it comes: velocity passed through unchanged. */
export const DEFAULT_MIDI_PREFS: MidiPrefs = { touch: 0, minVelocity: 0 };

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/** A stored number made safe, or the fallback when there is no number to make safe. */
const readInt = (value: unknown, low: number, high: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? clamp(Math.round(value), low, high)
    : fallback;

/**
 * The velocity a key struck at `velocity` should sound at.
 *
 * `out = min + (127 - min) * (in / 127)^γ`, with `γ = 2^(-touch / 50)`. A light
 * touch is an exponent below one, which lifts the middle of the range and leaves
 * both ends where they were — a full-force press is still 127. Never returns 0,
 * because a note-on at velocity 0 is a note-off.
 */
export function shapeVelocity(velocity: number, prefs: MidiPrefs): number {
  const input = clamp(velocity, 0, 127) / 127;
  const gamma = Math.pow(2, -prefs.touch / 50);
  const out = prefs.minVelocity + (127 - prefs.minVelocity) * Math.pow(input, gamma);
  return clamp(Math.round(out), 1, 127);
}

/**
 * What the keyboard has been set to, or the defaults.
 *
 * Every field is checked rather than trusted: this is hand-editable storage that
 * may have been written by an older build.
 */
export function loadMidiPrefs(): MidiPrefs {
  try {
    const raw = localStorage.getItem(MIDI_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_MIDI_PREFS;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_MIDI_PREFS;

    const { touch, minVelocity } = parsed as { touch?: unknown; minVelocity?: unknown };
    return {
      touch: readInt(touch, TOUCH_MIN, TOUCH_MAX, 0),
      minVelocity: readInt(minVelocity, 0, MIN_VELOCITY_MAX, 0),
    };
  } catch {
    // No storage, or nothing readable in it, is the same as no choice.
    return DEFAULT_MIDI_PREFS;
  }
}

/** Remember how the keyboard should be read. */
export function storeMidiPrefs(prefs: MidiPrefs): void {
  try {
    localStorage.setItem(MIDI_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // The choice still applies to this session; it just will not be remembered.
  }
}

/**
 * The setting in force, held in memory.
 *
 * Read on every key press, which is no place to be parsing JSON. Loaded lazily so
 * a test that seeds storage before the first key is honoured.
 */
let current: MidiPrefs | null = null;

/** The setting every key press is shaped by. */
export function getMidiPrefs(): MidiPrefs {
  current ??= loadMidiPrefs();
  return current;
}

/** Change how the keyboard is read, for this key press onwards and for next time. */
export function applyMidiPrefs(change: Partial<MidiPrefs>): MidiPrefs {
  const next: MidiPrefs = {
    touch: readInt(change.touch ?? getMidiPrefs().touch, TOUCH_MIN, TOUCH_MAX, 0),
    minVelocity: readInt(
      change.minVelocity ?? getMidiPrefs().minVelocity,
      0,
      MIN_VELOCITY_MAX,
      0
    ),
  };
  current = next;
  storeMidiPrefs(next);
  return next;
}

/** Forget the in-memory setting, so the next read comes from storage. For tests. */
export function resetMidiPrefsCache(): void {
  current = null;
}

/**
 * The raw velocity of the last key pressed, for the settings readout.
 *
 * Passed along here rather than read off a second MIDI listener: a port holds one
 * `onmidimessage`, so a dialog listening for itself would take the keyboard away
 * from the instrument it is meant to be tuning.
 */
const velocityListeners = new Set<(velocity: number) => void>();

/** Tell whoever is watching what velocity a key just arrived at. */
export function reportVelocity(velocity: number): void {
  for (const listener of velocityListeners) listener(velocity);
}

/** Hear about each key's raw velocity as it arrives. Returns the unsubscribe. */
export function subscribeLastVelocity(listener: (velocity: number) => void): () => void {
  velocityListeners.add(listener);
  return () => {
    velocityListeners.delete(listener);
  };
}
