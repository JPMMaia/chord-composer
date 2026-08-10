import type { Bar, TimeSignature } from '@/types/music';
import { beatToSongTime, songTimeToBeat } from '@/engine/scheduler';
import { getBarIndexAtBeat, getBarStartBeat } from '@/engine/timeline';

/**
 * Where a song position sits in wall-clock terms, for the transport's readout.
 *
 * Playback already thinks in seconds from the start of the project, so the elapsed
 * time is the position itself. The other half — how far into the current bar we are
 * — has to be walked rather than divided: bars may each be in their own metre, so
 * bar N does not start at `N × beatsPerMeasure`.
 */

/** Beats compare equal within this, so float drift cannot report beat 0 as beat 4. */
const EPSILON = 1e-6;

export interface TimerReadout {
  /** Seconds from the start of the project. */
  songElapsed: number;
  /** Seconds since the downbeat of the bar the position falls in. */
  barElapsed: number;
  /** 1-based bar number, as the timeline draws it. */
  barNumber: number;
  /** 1-based beat within that bar. */
  beatInBar: number;
}

/** What an unplayable project reads as: the top of bar 1. */
const ZERO: TimerReadout = { songElapsed: 0, barElapsed: 0, barNumber: 1, beatInBar: 1 };

/**
 * Locate a song position in both time and bars.
 *
 * @param songTime - Seconds from the start of the project.
 * @param bpm - The project tempo. Tempo is global here, so seconds and beats are one
 *   linear conversion.
 */
export function getTimerReadout(
  songTime: number,
  bars: Bar[],
  projectTs: TimeSignature,
  bpm: number
): TimerReadout {
  if (!Number.isFinite(songTime) || !Number.isFinite(bpm) || bpm <= 0) return ZERO;
  if (bars.length === 0) return { ...ZERO, songElapsed: Math.max(0, songTime) };

  const elapsed = Math.max(0, songTime);
  const beat = songTimeToBeat(elapsed, bpm);
  const barIndex = getBarIndexAtBeat(bars, projectTs, beat);
  const beatInBar = Math.max(0, beat - getBarStartBeat(bars, barIndex, projectTs));

  return {
    songElapsed: elapsed,
    barElapsed: beatToSongTime(beatInBar, bpm),
    barNumber: barIndex + 1,
    beatInBar: Math.floor(beatInBar + EPSILON) + 1,
  };
}

/**
 * Elapsed time as `1:23.450` — minutes, zero-padded seconds, milliseconds.
 *
 * Milliseconds rather than tenths because the readout is also how a recorded take is
 * checked against the grid, where a tenth of a beat is plainly audible.
 */
export function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.000';

  const totalMs = Math.floor(seconds * 1000);
  const minutes = Math.floor(totalMs / 60000);
  const secs = Math.floor(totalMs / 1000) % 60;
  const ms = totalMs % 1000;

  return `${minutes}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** Time since the bar line as `+0.612`. Signed to read as an offset, not a duration. */
export function formatBarOffset(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return `+${safe.toFixed(3)}`;
}

/** Musical position as `12.3` — bar number and the beat within it. */
export function formatPosition(readout: TimerReadout): string {
  return `${readout.barNumber}.${readout.beatInBar}`;
}
