import { PIANO_ROLL_KEY_COUNT, PIANO_ROLL_MAX_MIDI } from '@/utils/constants';

/**
 * Snap a value to the nearest grid point.
 * @param value - The value to snap.
 * @param gridSize - The grid size (e.g. 0.25 for 1/16 notes).
 * @returns The snapped value.
 */
export function snapToGrid(value: number, gridSize: number): number {
  if (gridSize <= 0) return value;
  return Math.round(value / gridSize) * gridSize;
}

/**
 * Convert a beat position to pixel coordinate.
 * @param beat - The beat position.
 * @param pixelsPerBeat - Pixels per beat unit.
 * @returns Pixel coordinate.
 */
export function beatToPixel(beat: number, pixelsPerBeat: number): number {
  return beat * pixelsPerBeat;
}

/**
 * Convert a pixel coordinate to beat position.
 * @param pixel - The pixel coordinate.
 * @param pixelsPerBeat - Pixels per beat unit.
 * @returns Beat position.
 */
export function pixelToBeat(pixel: number, pixelsPerBeat: number): number {
  return pixel / pixelsPerBeat;
}

/**
 * Y coordinate of the *top edge* of a MIDI note's key row.
 *
 * Pitch ascends upward, as on a keyboard, so the range's highest note sits at
 * y = 0 and the lowest at the bottom of the bed. Anchoring at the top rather
 * than at middle C is what lets the whole range be drawn into one tall,
 * scrollable canvas whose height is exactly `pitchRangeHeight`.
 *
 * @param midiNote - The MIDI note number.
 * @param pixelsPerOctave - Pixels per octave (12 semitones).
 * @param topMidi - Note drawn at y = 0. Defaults to the top of the piano roll.
 * @returns Pixel Y coordinate of the row's top edge.
 */
export function pitchToPixel(
  midiNote: number,
  pixelsPerOctave: number,
  topMidi: number = PIANO_ROLL_MAX_MIDI
): number {
  return (topMidi - midiNote) * (pixelsPerOctave / 12);
}

/**
 * Continuous inverse of `pitchToPixel`. Because a row is identified by its top
 * edge and pitch descends down the screen, the row a pixel falls inside is
 * `Math.ceil` of this — a point just below C8's top edge is still C8.
 *
 * @param pixel - The pixel Y coordinate.
 * @param pixelsPerOctave - Pixels per octave (12 semitones).
 * @param topMidi - Note drawn at y = 0. Defaults to the top of the piano roll.
 * @returns MIDI note number.
 */
export function pixelToPitch(
  pixel: number,
  pixelsPerOctave: number,
  topMidi: number = PIANO_ROLL_MAX_MIDI
): number {
  return topMidi - pixel * (12 / pixelsPerOctave);
}

/**
 * Total height of the piano roll's key bed, i.e. how tall the scrollable canvas
 * has to be to hold every key.
 *
 * @param pixelsPerOctave - Pixels per octave (12 semitones).
 */
export function pitchRangeHeight(pixelsPerOctave: number): number {
  return PIANO_ROLL_KEY_COUNT * (pixelsPerOctave / 12);
}

/**
 * Bar interface for visibility calculations.
 */
export interface BarView {
  id: string;
  barIndex: number;
  startBeat: number;
  endBeat: number;
}

/**
 * Viewport range for visible bars.
 */
export interface Viewport {
  start: number;
  end: number;
}

/**
 * Returns bars that overlap with the given viewport range.
 * @param viewport - The visible beat range.
 * @param bars - All bars with start/end beat positions.
 * @returns Bars that are at least partially visible.
 */
export function getVisibleBars(
  viewport: Viewport,
  bars: BarView[]
): BarView[] {
  return bars.filter((bar) => {
    // Bar overlaps viewport if bar starts before viewport ends AND bar ends after viewport starts
    return bar.startBeat < viewport.end && bar.endBeat > viewport.start;
  });
}
