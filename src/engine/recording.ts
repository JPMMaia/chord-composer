import { songTimeToBeat } from '@/engine/scheduler';
import { MIN_SEGMENT_BEATS, snapBeat } from '@/engine/timeline';

/**
 * How a take is fitted to the grid, as the transport's Quantize button sets it.
 *
 * Passed in rather than read off `editorStore` so this stays pure: nothing in
 * `engine/` reaches for a store, and the two recorders that share these rules —
 * the number keys and the MIDI keyboard — read their own settings and hand them in.
 */
export interface RecordQuantization {
  /** False keeps the timing the take was played with. */
  recordQuantize: boolean;
  /** The musical grid, in beats, when quantizing. */
  snapBeats: number;
}

/**
 * The shortest a recorded block may be.
 *
 * Quantized, that is one grid step — tapping a key on a 1/4 grid means a beat, not
 * the sliver the arithmetic would otherwise round it down to. Unquantized it is the
 * engine's own floor: the choice the button offers is between the musical grid and
 * the finest one, not between grid and chaos.
 */
export function recordFloor({ recordQuantize, snapBeats }: RecordQuantization): number {
  return recordQuantize ? snapBeats : MIN_SEGMENT_BEATS;
}

/**
 * Where the playhead is, in the edited surface's own beats, snapped as the user asked.
 *
 * The song time must come from the live audio clock rather than from the playhead
 * React renders, which is up to a scheduling pass (50 ms) stale — a tenth of a beat
 * at 120 BPM, and plainly audible in the result.
 *
 * @param originBeat - The absolute song beat that the edited surface's own beat 0 sits
 *   on: `audition.baseBeat` while a phrase is open, 0 in the arrangement. The clock
 *   speaks in song beats and `recordSegment` writes into the phrase's own bar grid, so
 *   the two frames have to be reconciled somewhere; here is that somewhere, and it is
 *   the same subtraction the drawn playhead makes. Stated rather than defaulted, so a
 *   caller has to say which frame it is in.
 *
 *   A position before the surface begins reads as its opening rather than as a negative
 *   beat — `snapBeat` clamps at 0. Nothing should reach that: an audition's play range
 *   is confined to the placement being heard.
 */
export function recordBeat(
  songTime: number,
  bpm: number,
  quantization: RecordQuantization,
  originBeat: number
): number {
  return snapBeat(songTimeToBeat(songTime, bpm) - originBeat, recordFloor(quantization));
}
