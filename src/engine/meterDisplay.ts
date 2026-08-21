import type { TimeSignature } from '@/types/music';
import { getMeterPulse } from '@/engine/timeline';

/**
 * Turning the app's internal unit into something a musician reads.
 *
 * Positions and durations are stored in beats, where a beat is always a quarter
 * note — one linear time axis, whatever metre a bar is in. That is the right thing
 * to compute in and the wrong thing to *show*: a dotted quarter is not "1.5 beats",
 * and a 6/8 bar is not "3 beats". Everything user-facing goes through here so the
 * naming lives in one place rather than being re-derived per label.
 */

/** Note names by length in beats, longest first. */
const NOTE_VALUES: Array<{ beats: number; name: string }> = [
  { beats: 4, name: 'whole' },
  { beats: 3, name: 'dotted half' },
  { beats: 2, name: 'half' },
  { beats: 1.5, name: 'dotted quarter' },
  { beats: 1, name: 'quarter' },
  { beats: 0.75, name: 'dotted eighth' },
  { beats: 0.5, name: 'eighth' },
  { beats: 0.375, name: 'dotted sixteenth' },
  { beats: 0.25, name: 'sixteenth' },
  { beats: 0.1875, name: 'dotted thirty-second' },
  { beats: 0.125, name: 'thirty-second' },
];

/** Plural names for the denominators a time signature may use. */
const UNIT_PLURALS: Record<number, string> = {
  2: 'halves',
  4: 'quarters',
  8: 'eighths',
  16: 'sixteenths',
};

/** Beats compare equal within this, so 0.1 + 0.2 + 1.2 still names a dotted quarter. */
const EPSILON = 1e-6;

/** A beat count as a short decimal, without a trailing `.0`. */
function formatBeats(beats: number): string {
  return `${Number(beats.toFixed(3))}`;
}

/**
 * A duration in beats as a note name — "dotted quarter", "eighth".
 *
 * Only the values a note can actually be written as are named. A duration that is
 * none of them — a tuplet, or a block dragged to an odd length — falls back to its
 * beat count rather than being forced onto the nearest name, because rounding a
 * length in a label would misreport what the block does.
 */
export function formatNoteValue(beats: number): string {
  if (!Number.isFinite(beats)) return '—';

  const match = NOTE_VALUES.find(value => Math.abs(value.beats - beats) < EPSILON);
  if (match) return match.name;

  return `${formatBeats(beats)} beat${Math.abs(beats - 1) < EPSILON ? '' : 's'}`;
}

/**
 * How a bar of this metre reads: "3 beats · 3 quarters", "2 beats · 6 eighths".
 *
 * Both halves are needed to tell 3/4 from 6/8 — they hold the same music but
 * count it differently, which is the whole point of the distinction.
 */
export function describeMeter(ts: TimeSignature): string {
  const { pulseCount } = getMeterPulse(ts);
  const unit = UNIT_PLURALS[ts.beatUnit] ?? `1/${ts.beatUnit} notes`;
  return `${pulseCount} beat${pulseCount === 1 ? '' : 's'} · ${ts.beatsPerMeasure} ${unit}`;
}

/**
 * Which beat of the bar a position falls on, counted the way the metre is: in 6/8,
 * beat 1.5 is the second of two beats, not the middle of three.
 *
 * Positions that do not land on a pulse name the beat they follow and how far past
 * it they sit — "beat 2 of 3 + eighth" — so an off-beat block is still locatable.
 */
export function describePosition(beatInBar: number, ts: TimeSignature): string {
  const { pulseBeats, pulseCount } = getMeterPulse(ts);
  const clamped = Math.max(0, beatInBar);

  const pulse = Math.min(pulseCount - 1, Math.floor(clamped / pulseBeats + EPSILON));
  const offset = clamped - pulse * pulseBeats;
  const label = `beat ${pulse + 1} of ${pulseCount}`;

  return offset < EPSILON ? label : `${label} + ${formatNoteValue(offset)}`;
}

/**
 * Metres a bar may be set to.
 *
 * Lives here beside `describeMeter` rather than in whichever view happens to draw the
 * picker: the arrangement offers it per bar, and the project settings offer the same
 * list for the piece as a whole.
 */
export const TIME_SIGNATURES: TimeSignature[] = [
  { beatsPerMeasure: 2, beatUnit: 4 },
  { beatsPerMeasure: 3, beatUnit: 4 },
  { beatsPerMeasure: 4, beatUnit: 4 },
  { beatsPerMeasure: 5, beatUnit: 4 },
  { beatsPerMeasure: 6, beatUnit: 8 },
  { beatsPerMeasure: 7, beatUnit: 8 },
  { beatsPerMeasure: 12, beatUnit: 8 },
];

/** A metre as "4/4" — what the picker shows and what its option values carry. */
export function formatTs(ts: TimeSignature): string {
  return `${ts.beatsPerMeasure}/${ts.beatUnit}`;
}

/** The inverse of `formatTs`, for reading a picker's value back. */
export function parseTs(value: string): TimeSignature {
  const [beatsPerMeasure, beatUnit] = value.split('/').map(Number);
  return { beatsPerMeasure, beatUnit };
}
