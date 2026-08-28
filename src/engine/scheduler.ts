import type { NoteTiming } from '@/engine/playback';
import type { Track } from '@/types/music';

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

/** The stretch of song time a run is confined to, and whether it repeats. */
export interface LoopRegion {
  /** Song time at which the region begins, in seconds. Inclusive. */
  from: number;
  /** Song time at which it ends, in seconds. Exclusive. */
  end: number;
  /** Whether reaching `end` starts the region again rather than stopping. */
  repeat: boolean;
}

/** One repetition's share of a look-ahead window. */
export interface CycleWindow {
  /** Window start in song time, in seconds. Inclusive. */
  fromSong: number;
  /** Window end in song time, in seconds. Exclusive. */
  toSong: number;
  /**
   * What the clock reads at song position 0 *for this repetition*.
   *
   * One loop length further on than the previous slice's, which is what places a
   * note belonging to the next repeat at the right moment while the current one is
   * still sounding.
   */
  songStartClockTime: number;
}

/**
 * Most repetitions one window may be cut into.
 *
 * A look-ahead shorter than the loop can only ever span one seam, so the bound is
 * never reached in practice; it exists so a degenerate loop — one shorter than a
 * single tick — cannot spin here.
 */
const MAX_CYCLES_PER_WINDOW = 4;

/**
 * Cut a look-ahead window into one slice per repetition it touches.
 *
 * The window is given on the *clock* rather than in song time, because a window
 * reaching past a seam covers a song time that is about to come round again;
 * the clock does not repeat, so a cursor on it can only move forward and no note
 * can be handed out twice.
 *
 * Scheduling the far side of a seam before the seam arrives is the whole point.
 * Stopping at the loop end and waiting for the wrap to be noticed leaves the
 * notes at the top of a repeat with no look-ahead at all — they reach the
 * instruments only once their moment has already passed, and each backend places
 * a stale note at its own idea of "immediately".
 *
 * @param fromClock - Clock reading already scheduled up to. Inclusive.
 * @param toClock - Clock reading to schedule up to. Exclusive.
 * @param songStartClockTime - What the clock read at song position 0 for the
 *   repetition currently sounding.
 */
export function cycleWindows(
  fromClock: number,
  toClock: number,
  songStartClockTime: number,
  region: LoopRegion
): CycleWindow[] {
  const slices: CycleWindow[] = [];
  const duration = region.end - region.from;
  let base = songStartClockTime;

  for (let cycle = 0; cycle < MAX_CYCLES_PER_WINDOW; cycle++) {
    const fromSong = Math.max(fromClock - base, region.from);
    const toSong = Math.min(toClock - base, region.end);
    if (toSong > fromSong) {
      slices.push({ fromSong, toSong, songStartClockTime: base });
    }

    // A window ending inside this repetition has nothing left to give the next
    // one. Neither has one that does not repeat, or a region with no length to
    // repeat over.
    if (!region.repeat || duration <= 0) break;
    if (toClock - base <= region.end) break;

    base += duration;
  }

  return slices;
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

/**
 * Widest nudge an instrument may be given, in milliseconds either way.
 *
 * Half a second is far past any plugin's undeclared latency and still short enough
 * that the pre-roll it forces on Play is not mistaken for the transport hanging.
 */
export const MAX_TIME_OFFSET_MS = 500;

/**
 * One instrument's nudge, in seconds, ready to be added to a note's `when`.
 *
 * Negative sounds it earlier. Absent, non-finite and out-of-range values all read as
 * 0 rather than throwing: this is applied on every scheduling pass, and a bad number
 * arriving from an old file should cost the instrument its nudge, not its notes.
 */
export function trackOffsetSeconds(track: Pick<Track, 'timeOffsetMs'>): number {
  const ms = track.timeOffsetMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 0;
  return Math.max(-MAX_TIME_OFFSET_MS, Math.min(MAX_TIME_OFFSET_MS, ms)) / 1000;
}

/** Every instrument's nudge by id, for a scheduling pass to look up per note. */
export function trackOffsets(tracks: readonly Track[]): Map<string, number> {
  return new Map(tracks.map(t => [t.id, trackOffsetSeconds(t)]));
}

/**
 * How long Play must wait before song position 0 is reached, in seconds.
 *
 * The deepest negative nudge in the project, or 0 when nothing is nudged early.
 * A note at the top of the range asked to sound 150ms before Play was pressed
 * cannot be placed there: Web Audio would sound it immediately and the VST3
 * scheduler clamps a late event to the start of its block, which is precisely the
 * lateness the nudge exists to remove — and only at the top, so it would read as
 * the first bar being wrong rather than as the setting not working.
 *
 * Delaying the whole transport instead buys every instrument the room to be early.
 * It costs a fraction of a second before sound starts, which is what a DAW does
 * with the same problem and for the same reason.
 */
export function preRollSeconds(tracks: readonly Track[]): number {
  let deepest = 0;
  for (const track of tracks) deepest = Math.min(deepest, trackOffsetSeconds(track));
  // Guarded rather than negated outright, so a project with nothing early returns a
  // plain 0 instead of -0 — which compares equal but reads as a bug at a call site.
  return deepest < 0 ? -deepest : 0;
}
