import { useRef, useCallback, useEffect, useState } from 'react';
import { InstrumentPool, isTrackAudible } from '@/engine/instrumentPool';
import { calculateNoteTiming, getLoopDuration } from '@/engine/playback';
import type { NoteTiming, PlaybackConfig } from '@/engine/playback';
import {
  LOOKAHEAD_SECONDS,
  TICK_MS,
  beatToSongTime,
  notesInWindow,
  toClockTime,
} from '@/engine/scheduler';

/**
 * Where the play range begins, in song time.
 *
 * The config states the range in beats while everything the scheduler does is in
 * seconds, so the conversion belongs here rather than at each use.
 */
function rangeStart(config: PlaybackConfig): number {
  return config.loopStart === null || config.loopEnd === null
    ? 0
    : beatToSongTime(config.loopStart, config.bpm);
}

/**
 * Drives playback: owns the AudioContext, the instrument pool, and the look-ahead
 * scheduling loop.
 *
 * The scheduling arithmetic lives in `@/engine/scheduler` and the sound in the
 * pool's `Instrument`s; this hook is the part that has to care about React
 * lifecycles and the browser's autoplay rules.
 */
export function usePlayback(config: PlaybackConfig) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const ctxRef = useRef<AudioContext | null>(null);
  const poolRef = useRef<InstrumentPool | null>(null);

  /** Clock reading at song position 0. Playback's whole frame of reference. */
  const songStartClockRef = useRef(0);
  /** Song time up to which notes have already been handed to the instrument. */
  const scheduledUpToRef = useRef(0);
  /** Song position to resume from. Non-zero only after Pause. */
  const resumeFromRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Guards against a second Play landing while the first is still loading samples. */
  const startingRef = useRef(false);

  /**
   * The config is rebuilt on every render by the caller, so the scheduling loop
   * reads it from a ref. Otherwise every keystroke would tear down the interval.
   */
  const configRef = useRef(config);
  configRef.current = config;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * One scheduling pass: hand the instrument every note between where we left off
   * and the look-ahead horizon, then advance the playhead.
   */
  const tick = useCallback(
    (timings: NoteTiming[]) => {
      const pool = poolRef.current;
      if (!pool) return;

      const cfg = configRef.current;
      const elapsed = pool.now() - songStartClockRef.current;
      const loopDuration = getLoopDuration(cfg);
      const loopFrom = rangeStart(cfg);

      const horizon = elapsed + LOOKAHEAD_SECONDS;
      /** Song time at which playback ends or wraps. */
      const endSong = loopFrom + loopDuration;

      const due = notesInWindow({
        timings,
        fromSong: scheduledUpToRef.current,
        toSong: Math.min(horizon, endSong),
      });

      // Mute and solo are read here, per note, rather than baked into `timings`,
      // so toggling either during playback is heard on the next tick.
      const audible = new Set(
        cfg.tracks.filter(t => isTrackAudible(t, cfg.tracks)).map(t => t.id)
      );

      for (const note of due) {
        if (!audible.has(note.trackId)) continue;

        pool.get(note.trackId)?.schedule({
          midiNote: note.midiNote,
          velocity: note.velocity,
          when: toClockTime(note.startTime, songStartClockRef.current),
          duration: note.duration,
        });
      }

      scheduledUpToRef.current = Math.max(scheduledUpToRef.current, horizon);

      // Reaching the end either wraps the loop or ends playback. Wrapping shifts the
      // frame of reference forward by one loop length rather than resetting it to
      // `now`, so the wrap lands on the beat instead of wherever the tick fired.
      if (elapsed >= endSong) {
        if (cfg.loopEnabled) {
          songStartClockRef.current += loopDuration;
          scheduledUpToRef.current = loopFrom;
          setCurrentTime(loopFrom);
          return;
        }

        clearTimer();
        pool.stopAll();
        setIsPlaying(false);
        // Back to the start of the range rather than of the song, so pressing Play
        // again repeats what was just heard.
        setCurrentTime(loopFrom);
        resumeFromRef.current = 0;
        return;
      }

      setCurrentTime(Math.max(0, Math.min(elapsed, endSong)));
    },
    [clearTimer]
  );

  const play = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;

    try {
      // The context is created here, inside the click handler, rather than on mount:
      // one created without a user gesture starts suspended, and scheduling against a
      // suspended context's clock is what makes timing drift on the first Play.
      if (!ctxRef.current) {
        ctxRef.current = new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext)();
      }
      const ctx = ctxRef.current;

      if (!poolRef.current) {
        poolRef.current = new InstrumentPool(ctx);
      }
      const pool = poolRef.current;

      // Reconcile before loading: an instrument added or re-voiced since the last
      // Play has to exist before there is anything to wait for.
      pool.ensure(configRef.current.tracks);

      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      // First Play in a session waits on the sample download; the transport shows a
      // loading state rather than appearing to do nothing. Adding an instrument
      // later puts it back into that state for just that instrument's samples.
      if (!pool.isLoaded) {
        setIsLoading(true);
        try {
          await pool.loadAll();
        } finally {
          setIsLoading(false);
        }
      }

      const timings = calculateNoteTiming(configRef.current);
      // A range confines playback whether or not repeat is on, so a Play from a
      // stopped transport starts at the range rather than at the top of the song.
      const resumeFrom = Math.max(resumeFromRef.current, rangeStart(configRef.current));

      // Anchoring the reference *behind* `now` by the resume offset is what makes a
      // paused project pick up where it left off with the same arithmetic.
      songStartClockRef.current = pool.now() - resumeFrom;
      scheduledUpToRef.current = resumeFrom;

      setIsPlaying(true);
      setIsPaused(false);
      setCurrentTime(resumeFrom);

      clearTimer();
      tick(timings);
      timerRef.current = setInterval(() => tick(timings), TICK_MS);
    } finally {
      startingRef.current = false;
    }
  }, [clearTimer, tick]);

  const pause = useCallback(() => {
    clearTimer();
    poolRef.current?.stopAll();

    const pool = poolRef.current;
    resumeFromRef.current = pool
      ? Math.max(0, pool.now() - songStartClockRef.current)
      : 0;

    setIsPaused(true);
    setIsPlaying(false);
  }, [clearTimer]);

  const stop = useCallback(() => {
    clearTimer();
    poolRef.current?.stopAll();

    resumeFromRef.current = 0;
    scheduledUpToRef.current = 0;
    setIsPlaying(false);
    setIsPaused(false);
    setCurrentTime(0);
  }, [clearTimer]);

  // Tear down on unmount only. The pool and context are deliberately kept across
  // config changes so a BPM edit does not re-download the samples.
  useEffect(() => {
    return () => {
      clearTimer();
      poolRef.current?.dispose();
      poolRef.current = null;
      ctxRef.current?.close();
      ctxRef.current = null;
    };
  }, [clearTimer]);

  return {
    isPlaying,
    isPaused,
    isLoading,
    currentTime,
    play,
    pause,
    stop,
    pool: poolRef.current,
  };
}
