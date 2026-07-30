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
 * Convert a MIDI pitch to pixel Y coordinate (relative to base MIDI 60 = C4).
 * @param midiNote - The MIDI note number.
 * @param pixelsPerOctave - Pixels per octave (12 semitones).
 * @returns Pixel Y coordinate (relative to C4).
 */
export function pitchToPixel(midiNote: number, pixelsPerOctave: number): number {
  return (midiNote - 60) * (pixelsPerOctave / 12);
}

/**
 * Convert a pixel Y coordinate to MIDI pitch (relative to base MIDI 60 = C4).
 * @param pixel - The pixel Y coordinate.
 * @param pixelsPerOctave - Pixels per octave (12 semitones).
 * @returns MIDI note number.
 */
export function pixelToPitch(pixel: number, pixelsPerOctave: number): number {
  return 60 + pixel * (12 / pixelsPerOctave);
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
