import { useRef, useCallback, useEffect, useState } from 'react';
import { InstrumentPool, isTrackAudible } from '@/engine/instrumentPool';
import { createTimingCache, getLoopDuration } from '@/engine/playback';
import type { NoteTiming, PlaybackConfig } from '@/engine/playback';
import type { Bar } from '@/types/music';
import {
  LOOKAHEAD_SECONDS,
  TICK_MS,
  beatToSongTime,
  notesInWindow,
  toClockTime,
} from '@/engine/scheduler';
import { syncVst3Clock } from '@/engine/vst3Instrument';
import {
  buildClickQueue,
  resetClickQueue,
  processClickQueue,
  notifyLoopWrap,
  resetMetronome,
  setAudioContextFactory,
} from '@/engine/metronomeClick';

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
export function usePlayback(config: PlaybackConfig, metronomeEnabled = false) {
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
   *
   * The note list is derived from this ref on every pass rather than captured at
   * Play, which is what lets an edit made mid-playback be heard from the next
   * scheduling window instead of only at the next Play.
   */
  const configRef = useRef(config);
  configRef.current = config;

  /**
   * Read through a ref for the same reason as the config: `tick` is memoised for
   * the life of the run, so a value captured in its closure would stay at whatever
   * it was on the first render and toggling the metronome would never be heard.
   */
  const metronomeEnabledRef = useRef(metronomeEnabled);
  metronomeEnabledRef.current = metronomeEnabled;

  /**
   * Mirrors of the two pieces of state `getSongTime` needs. It is called from event
   * handlers rather than from a render, so it cannot close over either value.
   */
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  /** Memoised `calculateNoteTiming` for this run. Null while stopped. */
  const timingsRef = useRef<((bars: Bar[]) => NoteTiming[]) | null>(null);
  /** Whether the click queue has been built for the current playback run. */
  const clickQueueBuiltRef = useRef(false);

  /**
   * Build the click queue from the current config and re-sync the queue index.
   *
   * Cheap enough to run from a scheduling pass, which is what lets the metronome
   * be switched on mid-playback rather than only before Play.
   */
  const buildClicks = useCallback(() => {
    const cfg = configRef.current;
    buildClickQueue(cfg.bars, cfg.timeSignature, cfg.bpm);
    resetClickQueue();
    clickQueueBuiltRef.current = true;
  }, []);

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
  const tick = useCallback(() => {
    const pool = poolRef.current;
    if (!pool) return;

    const cfg = configRef.current;
    // Re-derived here, not at Play: an edit since the last pass is already in the
    // config, and a note it changed is only ever dispatched once because
    // `scheduledUpToRef` moves forward only.
    const timings = timingsRef.current?.(cfg.bars) ?? [];
    const elapsed = pool.now() - songStartClockRef.current;
    const loopDuration = getLoopDuration(cfg);

    const loopFrom = rangeStart(cfg);

    // --- Metronome clicks ---
    // Built here rather than only at Play so switching the metronome on during a
    // run is heard from the next window. The loop window goes with it so the
    // click after the seam is scheduled before the seam arrives.
    if (metronomeEnabledRef.current) {
      if (!clickQueueBuiltRef.current) buildClicks();
      processClickQueue(
        elapsed,
        LOOKAHEAD_SECONDS,
        cfg.loopEnabled ? { from: loopFrom, duration: loopDuration } : null
      );
    }

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
        // Re-label the clicks already scheduled past the seam into the new frame.
        // Inferring the wrap from song time moving backward would not do: it fails
        // when the range starts at the top of the song and the wrap lands on the
        // same reading it started on.
        notifyLoopWrap(loopDuration);
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
  }, [clearTimer, buildClicks]);

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

      // The clicks share playback's context rather than opening one of their own:
      // a second context would be created outside the click handler (from the
      // scheduling loop), start suspended under the autoplay policy, and run on a
      // clock the note arithmetic knows nothing about. A browser also only allows
      // a handful of contexts per page, and the metronome discards its reference
      // on every Stop.
      setAudioContextFactory(() => ctx);

      if (!poolRef.current) {
        poolRef.current = new InstrumentPool(ctx);
      }
      const pool = poolRef.current;

      // Reconcile before loading: an instrument added or re-voiced since the last
      // Play has to exist before there is anything to wait for. Deliberately only
      // here, unlike the note list: building an instrument means downloading its
      // samples, which is not something to start from inside a scheduling pass.
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

      // Any natively-hosted plugin renders on its own audio device, whose clock
      // is only kept in step with this one periodically. Re-anchoring here means
      // the very first note is placed against a fresh reading rather than one up
      // to half a second old — which would be plainly audible.
      syncVst3Clock();

      // Tempo is fixed for the run here; everything else about the notes is read
      // afresh on each pass.
      timingsRef.current = createTimingCache(
        configRef.current.bpm,
        configRef.current.timeSignature
      );

      // Pre-build the metronome click queue for this playback run.
      clickQueueBuiltRef.current = false;
      if (metronomeEnabledRef.current) {
        buildClicks();
      }

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
      tick();
      timerRef.current = setInterval(tick, TICK_MS);
    } finally {
      startingRef.current = false;
    }
  }, [clearTimer, tick, buildClicks]);

  const pause = useCallback(() => {
    clearTimer();
    poolRef.current?.stopAll();
    resetMetronome();
    clickQueueBuiltRef.current = false;

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
    resetMetronome();
    clickQueueBuiltRef.current = false;

    resumeFromRef.current = 0;
    scheduledUpToRef.current = 0;
    setIsPlaying(false);
    setIsPaused(false);
    setCurrentTime(0);
  }, [clearTimer]);

  /**
   * The live song position in seconds, read straight off the audio clock.
   *
   * `currentTime` is only refreshed once per 50 ms scheduling pass — a tenth of a
   * beat at 120 BPM, which is plainly audible in a recorded take. This is the same
   * arithmetic `tick` performs, evaluated at the moment it is asked, and it stays
   * correct across a loop wrap because the wrap shifts the reference forward rather
   * than resetting it. While stopped there is no clock to read, so the last
   * published position stands.
   */
  const getSongTime = useCallback(() => {
    const pool = poolRef.current;
    if (!pool || !isPlayingRef.current) return currentTimeRef.current;
    return Math.max(0, pool.now() - songStartClockRef.current);
  }, []);

  /**
   * The live instrument pool. Returned as a getter beside the render-time snapshot
   * below, because an event handler firing between renders needs the pool as it is
   * now — not as it was when the component last drew.
   */
  const getPool = useCallback(() => poolRef.current, []);

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
    getSongTime,
    getPool,
    pool: poolRef.current,
  };
}
