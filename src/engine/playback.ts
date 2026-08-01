import type { Bar, TimeSignature } from '@/types/music';
import { getBarStartBeat, getTotalBeats } from '@/engine/timeline';

export interface NoteTiming {
  midiNote: number;
  startTime: number;
  duration: number;
  velocity: number;
  barIndex: number;
}

export interface PlaybackConfig {
  bpm: number;
  timeSignature: TimeSignature;
  bars: Bar[];
  tracks: string[];
  /** Play range bounds, in beats. Null means "the whole project". */
  loopStart: number | null;
  loopEnd: number | null;
  /** Whether reaching the end of the range wraps back to its start. */
  loopEnabled: boolean;
}

/**
 * Calculate the duration of one beat in seconds based on BPM.
 */
function beatDuration(bpm: number): number {
  return 60 / bpm;
}

/**
 * Calculate timing information for all notes in all bars.
 *
 * Bars may each be in their own metre, so a bar's position is the accumulated
 * length of everything before it rather than `barIndex × beatsPerMeasure`.
 */
export function calculateNoteTiming(config: PlaybackConfig): NoteTiming[] {
  const beatDur = beatDuration(config.bpm);
  const timings: NoteTiming[] = [];

  for (let i = 0; i < config.bars.length; i++) {
    const bar = config.bars[i];
    const barStartBeat = getBarStartBeat(config.bars, i, config.timeSignature);

    for (const note of bar.notes) {
      timings.push({
        midiNote: note.pitch,
        startTime: (barStartBeat + note.startBeat) * beatDur,
        duration: note.duration * beatDur,
        velocity: note.velocity,
        barIndex: bar.barIndex,
      });
    }
  }

  return timings;
}

/**
 * Get the total duration or loop region duration in seconds.
 */
export function getLoopDuration(config: PlaybackConfig): number {
  const beatDur = beatDuration(config.bpm);

  if (config.loopStart !== null && config.loopEnd !== null) {
    return (config.loopEnd - config.loopStart) * beatDur;
  }

  return getTotalBeats(config.bars, config.timeSignature) * beatDur;
}

/**
 * Calculate metronome click positions, in beats from the start of the project.
 *
 * Takes the bars themselves rather than a bar count because each may be in its
 * own metre; the caller scales the result by BPM.
 */
export function calculateMetronomeBeats(
  bars: Bar[],
  projectTs: TimeSignature
): number[] {
  const totalBeats = getTotalBeats(bars, projectTs);
  return Array.from({ length: totalBeats }, (_, i) => i);
}
