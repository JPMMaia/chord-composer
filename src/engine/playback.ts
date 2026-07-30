import type { Bar, TimeSignature } from '@/types/music';

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
  loopStart: number | null;
  loopEnd: number | null;
}

/**
 * Calculate the duration of one beat in seconds based on BPM.
 */
function beatDuration(bpm: number): number {
  return 60 / bpm;
}

/**
 * Calculate absolute start time in seconds for a note at a given bar and beat position.
 */
function noteStartTime(
  barIndex: number,
  startBeat: number,
  beatsPerMeasure: number,
  beatDur: number
): number {
  return (barIndex * beatsPerMeasure + startBeat) * beatDur;
}

/**
 * Calculate timing information for all notes in all bars.
 */
export function calculateNoteTiming(config: PlaybackConfig): NoteTiming[] {
  const beatDur = beatDuration(config.bpm);
  const bpm = config.bpm;
  const beatsPerMeasure = config.timeSignature.beatsPerMeasure;
  const timings: NoteTiming[] = [];

  for (const bar of config.bars) {
    for (const note of bar.notes) {
      timings.push({
        midiNote: note.pitch,
        startTime: noteStartTime(
          bar.barIndex,
          note.startBeat,
          beatsPerMeasure,
          beatDur
        ),
        duration: note.duration * beatDuration(bpm),
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
  const beatsPerMeasure = config.timeSignature.beatsPerMeasure;
  const totalBeats = config.bars.length * beatsPerMeasure;

  if (config.loopStart !== null && config.loopEnd !== null) {
    return (config.loopEnd - config.loopStart) * beatDur;
  }

  return totalBeats * beatDur;
}

/**
 * Calculate metronome click times for all beats in the project.
 */
export function calculateMetronomeBeats(
  timeSignature: TimeSignature,
  totalBars: number
): number[] {
  const beatDur = 1; // Return in beat units, caller scales by BPM
  const beatsPerMeasure = timeSignature.beatsPerMeasure;
  const totalBeats = totalBars * beatsPerMeasure;
  const beats: number[] = [];

  for (let i = 0; i < totalBeats; i++) {
    beats.push(i * beatDur);
  }

  return beats;
}
