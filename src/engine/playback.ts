import type { Bar, TimeSignature, Track } from '@/types/music';
import { allBarNotes, getBarPulse, getBarStartBeat, getTotalBeats } from '@/engine/timeline';

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
 * re-derived only when the bars change, and filtering here would freeze the mute
 * state at that moment. Whether a note is actually sounded is decided when it is
 * dispatched.
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
 * A `calculateNoteTiming` that recomputes only when the bars actually change.
 *
 * Every store mutation replaces the `bars` array, so identity is a sound key: the
 * scheduling loop can ask for the timings on every tick — and so hear an edit made
 * mid-playback — while still paying for the walk only once per edit.
 *
 * Tempo is fixed at construction rather than read per call. It scales every
 * `startTime`, so letting it change mid-run would move the notes out from under a
 * playhead that has already passed them.
 */
export function createTimingCache(
  bpm: number,
  timeSignature: TimeSignature
): (bars: Bar[]) => NoteTiming[] {
  let lastBars: Bar[] | null = null;
  let lastTimings: NoteTiming[] = [];

  return bars => {
    if (bars !== lastBars) {
      lastBars = bars;
      lastTimings = calculateNoteTiming({
        bpm,
        timeSignature,
        bars,
        tracks: [],
        loopStart: null,
        loopEnd: null,
        loopEnabled: false,
      });
    }
    return lastTimings;
  };
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

/** Whether a click opens a bar or falls on a beat within it. */
export type ClickAccent = 'downbeat' | 'pulse';

export interface MetronomeClick {
  /** Beats from the start of the project. */
  beat: number;
  accent: ClickAccent;
}

/**
 * Calculate metronome click positions, in beats from the start of the project.
 *
 * Clicks land on the metre's pulse rather than on every beat, so 6/8 gives two
 * clicks a bar at 0 and 1.5 where 3/4 gives three at 0, 1 and 2 — the audible
 * difference between two metres that occupy the same three beats.
 *
 * Takes the bars themselves rather than a bar count because each may be in its
 * own metre; the caller scales the result by BPM.
 */
export function calculateMetronomeBeats(
  bars: Bar[],
  projectTs: TimeSignature
): MetronomeClick[] {
  const clicks: MetronomeClick[] = [];

  for (let i = 0; i < bars.length; i++) {
    const barStartBeat = getBarStartBeat(bars, i, projectTs);
    const { pulseBeats, pulseCount } = getBarPulse(bars[i], projectTs);

    for (let pulse = 0; pulse < pulseCount; pulse++) {
      clicks.push({
        beat: barStartBeat + pulse * pulseBeats,
        accent: pulse === 0 ? 'downbeat' : 'pulse',
      });
    }
  }

  return clicks;
}
