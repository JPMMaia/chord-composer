import { useRef, useCallback, useEffect, useState } from 'react';
import { InstrumentPool, isTrackAudible } from '@/engine/instrumentPool';
import { createTimingCache, getLoopDuration } from '@/engine/playback';
import type { NoteTiming, PlaybackConfig } from '@/engine/playback';
import type { AutomationPoint, Bar } from '@/types/music';
import {
  LOOKAHEAD_SECONDS,
  TICK_MS,
  beatToSongTime,
  notesInWindow,
  songTimeToBeat,
  toClockTime,
} from '@/engine/scheduler';
import { firstPointAtOrAfter, valueAtBeat } from '@/engine/volumeAutomation';
import { laneKey, VOLUME_LANE_KEY } from '@/engine/parameterAutomation';
import { syncVst3Clock } from '@/engine/vst3Instrument';
import { registerAudioContext } from '@/engine/audioOutput';
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
 * Smallest level change worth sending to a backend that has to be stepped rather
 * than ramped. Twenty passes a second over a flat stretch of curve would otherwise
 * be twenty commands a second saying nothing.
 */
const VOLUME_STEP_EPSILON = 0.005;

/**
 * How far through one instrument's curve the scheduler has got in this run.
 *
 * `points` is the array the cursor was counted against, not a copy: a mid-playback
 * edit replaces it, and that change of identity is what invalidates the cursor —
 * the same trick `createTimingCache` uses on the bars.
 */
interface AutomationCursor {
  /** Index of the next breakpoint not yet handed to the instrument. */
  index: number;
  /**
   * Song time of the next *sampled* value, for a curve walked on a grid rather
   * than breakpoint by breakpoint. Unused when `index` is what advances.
   */
  nextSongTime: number;
  points: AutomationPoint[];
  /** Last level sent, for backends stepped per pass rather than ramped. */
  lastValue: number;
}

/**
 * How far apart sampled points are, in song seconds.
 *
 * Ten milliseconds reproduces a corner in the curve closely enough that no sweep
 * can show the difference, while a 200 ms look-ahead window costs only twenty
 * points per lane per pass. See `advanceCurve`'s `maxStep` for why a plugin
 * parameter has to be sampled at all.
 */
const PARAM_GRID_SECONDS = 0.01;

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
  /**
   * How far through each curve this run has got, keyed by `<trackId>|<laneKey>`.
   *
   * Keyed by lane rather than by track because an instrument now has several
   * curves — its volume, and one per automated plugin parameter — and each
   * advances independently.
   */
  const automationRef = useRef(new Map<string, AutomationCursor>());
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

  /**
   * Put every instrument back on its flat `Track.volume` and forget the curves.
   *
   * Used at Play, Pause and Stop. Without it a run that ended mid-fade would leave
   * the gain node sitting whereever the fade reached, and the next Play would open
   * at that level — a project that gets quieter every time you press Play.
   *
   * Plugin parameters are deliberately *not* reset with it. Volume has a flat
   * value to go back to; a parameter does not, and inventing one would mean
   * overwriting whatever the plugin's preset or its own editor last said. So a
   * parameter is left where the curve left it, and the pin at the next Play
   * states it from the curve — which makes the result deterministic without the
   * app ever making a value up. Only the cursors go.
   *
   * Deliberately not `pool.ensure`, which would also reconcile instruments and so
   * could start a sample download from a Stop handler.
   */
  const resetAutomation = useCallback(() => {
    automationRef.current.clear();

    const pool = poolRef.current;
    if (!pool) return;
    for (const track of configRef.current.tracks) {
      pool.get(track.id)?.setVolume(track.volume);
    }
  }, []);

  /**
   * Advance one curve, returning the cursor it left off at.
   *
   * The shared half of every kind of automation: notice when the curve underneath
   * the cursor has been replaced and re-pin against it, then hand out whatever
   * falls inside the look-ahead window. What differs between a volume curve and a
   * plugin parameter is only *how* a value is stated and scheduled, which is what
   * `pin` and `emit` carry in.
   *
   * @param pin - State the value now. Called on a fresh run, a loop wrap, or an
   *   edit made mid-playback — which is what makes a Play from the middle of a
   *   ramp start at the level the ramp had reached rather than at its opening.
   * @param emit - Place a value at a moment on the instrument's clock, or null
   *   for a backend that cannot promise a value at a time.
   * @param maxStep - The longest gap between emitted values, in song seconds, or
   *   null to emit only at the curve's own breakpoints.
   *
   *   Volume passes null because `rampVolume` is `linearRampToValueAtTime`, which
   *   draws the line between two points itself — sending the ends is sending the
   *   ramp. A plugin has nothing that does: a parameter change is a value at a
   *   sample and holds until the next one, so a four-bar sweep described by its
   *   two ends would sit still and jump at the far one. Sampling the curve is
   *   what makes a sweep a sweep.
   */
  const advanceCurve = useCallback(
    (
      key: string,
      points: AutomationPoint[],
      fallback: number,
      elapsedBeat: number,
      bpm: number,
      horizon: number,
      pin: (value: number) => void,
      emit: ((value: number, when: number) => void) | null,
      maxStep: number | null
    ) => {
      let cursor = automationRef.current.get(key);
      if (!cursor || cursor.points !== points) {
        // Pinning cancels whatever was scheduled against the old curve and states
        // the value here.
        const value = valueAtBeat(points, elapsedBeat, fallback);
        pin(value);
        cursor = {
          index: firstPointAtOrAfter(points, elapsedBeat),
          // From where playback actually is, so a Play from the middle of a ramp
          // samples from there rather than replaying the curve's opening.
          nextSongTime: beatToSongTime(elapsedBeat, bpm),
          points,
          lastValue: value,
        };
        automationRef.current.set(key, cursor);
      }

      if (!emit) {
        // Stepped instead of scheduled, for a backend whose value is set through
        // something with no notion of time. Only on a real change: a flat stretch
        // of curve is not twenty commands a second.
        const value = valueAtBeat(points, elapsedBeat, fallback);
        if (Math.abs(value - cursor.lastValue) > VOLUME_STEP_EPSILON) {
          pin(value);
          cursor.lastValue = value;
        }
        return;
      }

      if (maxStep === null) {
        // Breakpoint by breakpoint rather than window by window: a ramp arrives at
        // the *next* breakpoint, which may be many windows out, so slicing the curve
        // by window would stair-step every long fade into a series of 50 ms steps.
        while (cursor.index < points.length) {
          const songTime = beatToSongTime(points[cursor.index].beat, bpm);
          if (songTime >= horizon) break;

          emit(points[cursor.index].value, toClockTime(songTime, songStartClockRef.current));
          cursor.index++;
        }
        return;
      }

      // Sampled on a fixed grid. A held value still costs nothing: the same
      // epsilon the stepped path uses skips it, so a curve only sends while it is
      // actually moving.
      while (cursor.nextSongTime < horizon) {
        const songTime = cursor.nextSongTime;
        cursor.nextSongTime += maxStep;

        const value = valueAtBeat(points, songTimeToBeat(songTime, bpm), fallback);
        if (Math.abs(value - cursor.lastValue) <= VOLUME_STEP_EPSILON) continue;

        emit(value, toClockTime(songTime, songStartClockRef.current));
        cursor.lastValue = value;
      }
    },
    []
  );

  /**
   * Hand each instrument the part of every curve it owns that falls inside this
   * pass's look-ahead window: its volume, and one lane per automated plugin
   * parameter.
   */
  const scheduleAutomation = useCallback(
    (cfg: PlaybackConfig, pool: InstrumentPool, elapsed: number, horizon: number) => {
      const elapsedBeat = songTimeToBeat(elapsed, cfg.bpm);

      for (const track of cfg.tracks) {
        const instrument = pool.get(track.id);
        if (!instrument) continue;

        const volumeKey = `${track.id}|${VOLUME_LANE_KEY}`;
        const points = track.volumeAutomation ?? [];
        if (points.length === 0) {
          // No curve: the flat volume the pool applied when it built the instrument
          // still stands, and a cursor left from a curve just deleted must not.
          automationRef.current.delete(volumeKey);
        } else {
          advanceCurve(
            volumeKey,
            points,
            track.volume,
            elapsedBeat,
            cfg.bpm,
            horizon,
            value => instrument.setVolume(value),
            instrument.rampVolume
              ? (value, when) => instrument.rampVolume!(value, when)
              : null,
            // The ends are enough: `rampVolume` draws the line between them.
            null
          );
        }

        // Plugin targets. An instrument with no `automateTarget` cannot be driven
        // at all — unlike volume there is no coarser fallback, because there is
        // nothing to fall back *to* — so it is skipped outright.
        if (!instrument.automateTarget || !instrument.setTarget) continue;

        for (const lane of track.parameterAutomation ?? []) {
          const key = `${track.id}|${laneKey(lane.target)}`;
          if (lane.points.length === 0) {
            automationRef.current.delete(key);
            continue;
          }

          advanceCurve(
            key,
            lane.points,
            // No flat value to fall back to, and none is ever reached: `fallback`
            // is only consulted for an empty curve, which the guard above excludes.
            0,
            elapsedBeat,
            cfg.bpm,
            horizon,
            value => instrument.setTarget!(lane.target, value),
            // Sample-accurate, unlike a plugin's volume: a change goes through
            // VST3's own queue, which carries a sample offset per point.
            (value, when) => instrument.automateTarget!(lane.target, value, when),
            PARAM_GRID_SECONDS
          );
        }
      }
    },
    [advanceCurve]
  );

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

    // Levels after notes, on the same horizon: a fade is scheduled onto the gain
    // node rather than baked into the notes, so it is heard *through* a held chord
    // instead of only at the next note boundary.
    scheduleAutomation(cfg, pool, elapsed, Math.min(horizon, endSong));

    scheduledUpToRef.current = Math.max(scheduledUpToRef.current, horizon);
  
    // Reaching the end either wraps the loop or ends playback. Wrapping shifts the
    // frame of reference forward by one loop length rather than resetting it to
    // `now`, so the wrap lands on the beat instead of wherever the tick fired.
    if (elapsed >= endSong) {
      if (cfg.loopEnabled) {
        songStartClockRef.current += loopDuration;
        scheduledUpToRef.current = loopFrom;
        // Forgetting the cursors makes the next pass re-pin each level at the top of
        // the range, so a repeat opens where the curve opens instead of gliding back
        // up from wherever the last pass ended.
        automationRef.current.clear();
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
      resetAutomation();
      setIsPlaying(false);
      // Back to the start of the range rather than of the song, so pressing Play
      // again repeats what was just heard.
      setCurrentTime(loopFrom);
      resumeFromRef.current = 0;
      return;
    }

    setCurrentTime(Math.max(0, Math.min(elapsed, endSong)));
  }, [clearTimer, buildClicks, scheduleAutomation, resetAutomation]);

  /**
   * Bring the audio graph up: context, instrument pool, samples loaded.
   *
   * Split out of `play` because Play is no longer the only thing that needs sound.
   * A MIDI key pressed before the transport has ever run has to have something to
   * sound on, and waiting for the user to press Play first would make the keyboard
   * mysteriously dead until they did.
   *
   * Safe to call repeatedly: everything in it is idempotent, and an instrument
   * whose samples are already loaded is not re-downloaded.
   */
  const ensureAudio = useCallback(async (): Promise<InstrumentPool> => {
    // The context is created here, inside a click handler, rather than on mount:
    // one created without a user gesture starts suspended, and scheduling against a
    // suspended context's clock is what makes timing drift on the first Play.
    if (!ctxRef.current) {
      ctxRef.current = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext)();

      // Handed over as it is made, so a context that has never played a note is
      // already pointed at the speakers the user chose in an earlier session.
      registerAudioContext(ctxRef.current);
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

    return pool;
  }, []);

  const play = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;

    try {
      const pool = await ensureAudio();

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

      // Forget the last run's curves so this one re-pins from its own resume
      // position. The levels themselves need no restoring here: `ensureAudio` has
      // just been through `pool.ensure`, which re-applies every static volume.
      automationRef.current.clear();

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
  }, [clearTimer, tick, buildClicks, ensureAudio]);

  const pause = useCallback(() => {
    clearTimer();
    poolRef.current?.stopAll();
    resetAutomation();
    resetMetronome();
    clickQueueBuiltRef.current = false;

    const pool = poolRef.current;
    resumeFromRef.current = pool
      ? Math.max(0, pool.now() - songStartClockRef.current)
      : 0;

    setIsPaused(true);
    setIsPlaying(false);
  }, [clearTimer, resetAutomation]);

  const stop = useCallback(() => {
    clearTimer();
    poolRef.current?.stopAll();
    resetAutomation();
    resetMetronome();
    clickQueueBuiltRef.current = false;

    resumeFromRef.current = 0;
    scheduledUpToRef.current = 0;
    setIsPlaying(false);
    setIsPaused(false);
    setCurrentTime(0);
  }, [clearTimer, resetAutomation]);

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
    ensureAudio,
    pool: poolRef.current,
  };
}
