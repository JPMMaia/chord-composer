/**
 * Metronome click engine using the Web Audio API.
 *
 * Schedules clicks for every metronome pulse (the audible "tick" positions).
 * Uses `calculateMetronomeBeats` from `@/engine/playback` which correctly handles
 * both simple metres (3/4 = 3 clicks/bar) and compound metres (6/8 = 2 clicks/bar
 * at 0 and 1.5).
 */

import type { Bar, TimeSignature } from '@/types/music';
import { calculateMetronomeBeats } from '@/engine/playback';

/** Volume of the click relative to other playback. */
const CLICK_VOLUME = 0.35;
/** Click frequency for downbeats (first beat of bar). */
const DOWNBEAT_FREQ = 1200;
/** Click frequency for non-downbeats (sub-beat pulses). */
const PULSE_FREQ = 800;
/** Duration of a click in seconds. */
const CLICK_DURATION = 0.05;

/** A click event to fire at a specific time. */
interface ScheduledClick {
  /** Song-time seconds from the start of the project when the click should fire. */
  songTime: number;
  /** Frequency for the oscillator. */
  freq: number;
}

/** Factory for creating an AudioContext (testable). */
export type AudioContextFactory = () => AudioContext;

/** Default factory: reads from window. */
export function defaultAudioContextFactory(): AudioContext {
  return new (window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext)();
}

/** The AudioContext factory in use (swappable for testing). */
let audioContextFactory: AudioContextFactory = defaultAudioContextFactory;
let audioContextRef: AudioContext | null = null;
/** Clicks scheduled for this playback run, sorted by time. */
let clickQueue: ScheduledClick[] = [];
/** Index of the next click in the queue to process. */
let clickIndex = 0;
/**
 * Seconds to add to a queued click's songTime to place it in the caller's current
 * frame of reference.
 *
 * Non-zero only across a loop seam: the look-ahead reaches into the next
 * repetition while the caller still counts time in the current one, so those
 * clicks are one loop length further out than their songTime says.
 */
let cycleOffset = 0;
/** Last elapsed-song-time passed to processClickQueue (for backward-detection). */
let lastElapsedSongTime = 0;

/**
 * Set the AudioContext factory used by the metronome.
 *
 * Call during tests to inject a mock context.
 */
export function setAudioContextFactory(factory: AudioContextFactory): void {
  audioContextFactory = factory;
}

/**
 * Build the click queue for the current project layout.
 *
 * Call once when metronome is enabled or the project layout changes.
 */
export function buildClickQueue(
  bars: Bar[],
  projectTs: TimeSignature,
  bpm: number
): ScheduledClick[] {
  const clicks = calculateMetronomeBeats(bars, projectTs);
  const beatDur = 60 / bpm;
  clickQueue = clicks.map(c => ({
    songTime: c.beat * beatDur,
    freq: c.accent === 'downbeat' ? DOWNBEAT_FREQ : PULSE_FREQ,
  }));
  return clickQueue;
}

/**
 * Reset the queue for a new playback run.
 *
 * Call on Play / Pause / Stop to re-sync the queue index.
 */
export function resetClickQueue(): void {
  clickIndex = 0;
  cycleOffset = 0;
}

/** The repeating region of song time, in seconds. */
export interface LoopWindow {
  /** Song time at which the loop begins. */
  from: number;
  /** Length of the loop in seconds. */
  duration: number;
}

/** Index of the first queued click at or after `songTime`. */
function firstClickAtOrAfter(songTime: number): number {
  const i = clickQueue.findIndex(c => c.songTime >= songTime - 1e-9);
  return i === -1 ? clickQueue.length : i;
}

/**
 * Tell the metronome the caller's frame of reference just moved forward by one
 * loop length.
 *
 * The clicks just past the seam were already scheduled against the old frame, so
 * this only re-labels them; it deliberately does not re-schedule anything.
 */
export function notifyLoopWrap(loopDuration: number): void {
  cycleOffset = Math.max(0, cycleOffset - loopDuration);
  // The caller's song time has jumped backward by design. Stop the
  // backward-detection below from reading that as a seek and rewinding the queue
  // over clicks that are already scheduled.
  lastElapsedSongTime = 0;
}

/**
 * Process the click queue. Call from the scheduling loop on every tick.
 *
 * Click positions are absolute song times, so a pass only ever hands the context
 * the clicks between the playhead and the look-ahead horizon. Running out of
 * queue is not a wrap — it just means the last click of the song has been
 * scheduled, which happens a look-ahead window *before* it is heard.
 *
 * When a `loop` is given, a window reaching past the loop end carries on into the
 * next repetition rather than stopping at the seam. Scheduling the seam only once
 * the caller reports the wrap would be too late by a whole tick: the downbeat is
 * already in the past by then, and gets dropped as stale.
 *
 * @param elapsedSongTime - Current song time in seconds (relative to song start).
 * @param lookAhead - How far ahead in seconds to look for clicks (same as scheduler).
 * @param loop - The repeating region, or null when playback runs to the end once.
 */
export function processClickQueue(
  elapsedSongTime: number,
  lookAhead: number,
  loop: LoopWindow | null = null
): void {
  // Song time went backward without a wrap being reported — a seek, or a resume
  // from a pause at an earlier position.
  if (elapsedSongTime < lastElapsedSongTime) {
    clickIndex = firstClickAtOrAfter(loop?.from ?? 0);
    cycleOffset = 0;
  }
  lastElapsedSongTime = elapsedSongTime;

  const ctx = getAudioContext();
  if (!ctx) return;

  const endSong = elapsedSongTime + lookAhead;
  const loopEnd = loop ? loop.from + loop.duration : Infinity;

  // One iteration per repetition the window touches. A look-ahead shorter than a
  // loop can only ever span one seam, but the bound keeps a degenerate loop (one
  // shorter than a tick, say) from spinning here.
  for (let cycle = 0; cycle < 4; cycle++) {
    while (clickIndex < clickQueue.length) {
      const click = clickQueue[clickIndex];
      // Clicks past the loop end belong to a part of the song this run repeats
      // before reaching.
      if (click.songTime >= loopEnd) break;

      const when = click.songTime + cycleOffset;
      if (when >= endSong) return;

      scheduleClickOnContext(ctx, click.freq, when, elapsedSongTime);
      clickIndex++;
    }

    // Out of clicks for this repetition. Without a loop that is the end of it.
    if (!loop) return;
    // The window stops short of the seam; the next pass picks it up.
    if (loopEnd + cycleOffset >= endSong) return;

    clickIndex = firstClickAtOrAfter(loop.from);
    cycleOffset += loop.duration;
    if (clickIndex >= clickQueue.length) return;
  }
}

function getAudioContext(): AudioContext | null {
  if (!audioContextRef) {
    try {
      audioContextRef = audioContextFactory();
    } catch {
      // AudioContext creation failed (no Web Audio API available).
      return null;
    }
  }
  const ctx = audioContextRef;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

/**
 * Schedule a click on the given AudioContext.
 *
 * @param ctx - The AudioContext to schedule on.
 * @param freq - Oscillator frequency in Hz.
 * @param songTime - When the click should fire, in song-time seconds.
 * @param elapsedSongTime - How many seconds into the song we currently are.
 */
function scheduleClickOnContext(
  ctx: AudioContext,
  freq: number,
  songTime: number,
  elapsedSongTime: number
): void {
  // Convert song-time to audio-context time. The difference between when the
  // click should happen (songTime) and now (elapsedSongTime) is the offset.
  const whenAhead = songTime - elapsedSongTime;
  if (whenAhead < -0.01) return; // Past the look-ahead window, skip.

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, ctx.currentTime + Math.max(0, whenAhead));
  gain.gain.setValueAtTime(CLICK_VOLUME, ctx.currentTime + Math.max(0, whenAhead));
  gain.gain.exponentialRampToValueAtTime(
    0.001,
    ctx.currentTime + Math.max(0, whenAhead) + CLICK_DURATION
  );

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(ctx.currentTime + Math.max(0, whenAhead));
  osc.stop(ctx.currentTime + Math.max(0, whenAhead) + CLICK_DURATION + 0.01);
}

/**
 * Stop all pending clicks and reset state.
 *
 * Called when playback stops or pauses.
 */
export function resetMetronome(): void {
  clickQueue = [];
  clickIndex = 0;
  cycleOffset = 0;
  audioContextRef = null;
  lastElapsedSongTime = 0;
}

/**
 * Reset the cached AudioContext (without clearing the queue).
 *
 * Useful when a test wants to swap context factories between calls.
 */
export function resetAudioContext(): void {
  audioContextRef = null;
}
