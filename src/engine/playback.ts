import type { Bar, TimeSignature, Track } from '@/types/music';
import { allBarNotes, getBarStartBeat, getTotalBeats } from '@/engine/timeline';

export interface NoteTiming {
  midiNote: number;
  startTime: number;
  duration: number;
  velocity: number;
  barIndex: number;
  /** The instrument that plays this note. */
  trackId: string;
}

export interface PlaybackConfig {
  bpm: number;
  timeSignature: TimeSignature;
  bars: Bar[];
  /**
   * The project's instruments. Mute and solo are read at dispatch time rather than
   * filtered out here, so toggling either mid-playback takes effect immediately
   * instead of at the next Play.
   */
  tracks: Track[];
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
 * Calculate timing information for every instrument's notes in all bars.
 *
 * Bars may each be in their own metre, so a bar's position is the accumulated
 * length of everything before it rather than `barIndex × beatsPerMeasure`.
 *
 * Every instrument's notes are included regardless of mute and solo: the result is
 * computed once per Play, and filtering here would freeze the mute state at that
 * moment. Whether a note is actually sounded is decided when it is dispatched.
 */
export function calculateNoteTiming(config: PlaybackConfig): NoteTiming[] {
  const beatDur = beatDuration(config.bpm);
  const timings: NoteTiming[] = [];

  for (let i = 0; i < config.bars.length; i++) {
    const bar = config.bars[i];
    const barStartBeat = getBarStartBeat(config.bars, i, config.timeSignature);

    for (const { note, trackId } of allBarNotes(bar)) {
      timings.push({
        midiNote: note.pitch,
        startTime: (barStartBeat + note.startBeat) * beatDur,
        duration: note.duration * beatDur,
        velocity: note.velocity,
        barIndex: bar.barIndex,
        trackId,
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
