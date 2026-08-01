import type { NoteTiming } from '@/engine/playback';

/**
 * Look-ahead scheduling arithmetic, kept free of React and Web Audio so it can be
 * tested with plain numbers.
 *
 * The model: `calculateNoteTiming` gives every note a position in *song time* —
 * seconds from the start of the project. Playback maps song time onto the
 * instrument's clock by remembering what the clock read when song position 0 was
 * reached. A timer wakes up periodically and hands the instrument only the notes
 * falling in the next short window, so edits and Stop take effect promptly instead
 * of fighting a queue containing the whole project.
 */

/**
 * How far past the current clock reading each pass schedules. Long enough that a
 * late or throttled timer tick cannot leave a gap, short enough that Stop feels
 * immediate.
 */
export const LOOKAHEAD_SECONDS = 0.2;

/** Interval between scheduling passes. Comfortably shorter than the look-ahead. */
export const TICK_MS = 50;

export interface ScheduleWindow {
  /** All the project's notes, in song time. From `calculateNoteTiming`. */
  timings: NoteTiming[];
  /** Window start in song time, in seconds. Inclusive. */
  fromSong: number;
  /** Window end in song time, in seconds. Exclusive. */
  toSong: number;
}

/**
 * The notes starting inside a window.
 *
 * Half-open on purpose: consecutive windows share a boundary, so a note landing
 * exactly on it must belong to precisely one of them or it plays twice.
 */
export function notesInWindow({ timings, fromSong, toSong }: ScheduleWindow): NoteTiming[] {
  return timings.filter(t => t.startTime >= fromSong && t.startTime < toSong);
}

/**
 * Song time to a reading on the instrument's clock.
 *
 * @param songTime - Seconds from the start of the project.
 * @param songStartClockTime - What the clock read when song position 0 was reached.
 *   For a project resumed mid-way this is in the past, which is expected.
 */
export function toClockTime(songTime: number, songStartClockTime: number): number {
  return songStartClockTime + songTime;
}

/** Song time to a beat position, for the playhead. Inverse of `playback.ts`'s beat scaling. */
export function songTimeToBeat(songTime: number, bpm: number): number {
  if (!Number.isFinite(songTime) || !Number.isFinite(bpm) || bpm <= 0) return 0;
  return Math.max(0, songTime) * (bpm / 60);
}

/** Beat position to song time. The inverse of `songTimeToBeat`. */
export function beatToSongTime(beat: number, bpm: number): number {
  if (!Number.isFinite(beat) || !Number.isFinite(bpm) || bpm <= 0) return 0;
  return Math.max(0, beat) * (60 / bpm);
}
