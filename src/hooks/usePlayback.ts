import { useRef, useCallback, useEffect, useState } from 'react';
import { InstrumentPool, isTrackAudible } from '@/engine/instrumentPool';
import { createTimingCache, getLoopDuration } from '@/engine/playback';
import type { NoteTiming, PlaybackConfig } from '@/engine/playback';
import type { AutomationPoint, Bar } from '@/types/music';
import {
  LOOKAHEAD_SECONDS,
  TICK_MS,
  beatToSongTime,
  cycleWindows,
  notesInWindow,
  preRollSeconds,
  songTimeToBeat,
  toClockTime,
  trackOffsets,
} from '@/engine/scheduler';
import type { CycleWindow } from '@/engine/scheduler';
import { firstPointAtOrAfter, valueAtBeat } from '@/engine/volumeAutomation';
import { laneKey, VOLUME_LANE_KEY } from '@/engine/parameterAutomation';
import { toControllerStep } from '@/engine/touchpadExpression';
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
 * How long before a loop seam a ramped curve is held at its outgoing value.
 *
 * `rampVolume` is `linearRampToValueAtTime`, which interpolates from whatever
 * event precedes it — so a bare ramp to the curve's opening value at the seam
 * would glide the whole tail of the repeat up to it instead of stepping there.
 * Stating the outgoing level a millisecond short turns that glide into a step,
 * short enough to be a step to the ear and long enough not to click.
 */
const SEAM_STEP_SECONDS = 0.001;

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
  /**
   * Clock reading at song position 0 for the repetition this cursor is walking.
   *
   * A look-ahead window may reach past a seam, so a cursor can be a whole
   * repetition ahead of the playhead. When a slice arrives with a different base
   * the curve has come round again and opens afresh — see `advanceCurve`.
   */
  cycleBase: number;
  /**
   * Clock reading of the last value placed on the instrument's timeline, or
   * -Infinity for a cursor that has only ever pinned. Keeps the hold before a
   * seam from landing behind a breakpoint already scheduled past it.
   */
  lastEmitClock: number;
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
  /**
   * Clock reading up to which notes have already been handed to the instruments.
   *
   * On the clock rather than in song time because a look-ahead window may reach
   * past a loop seam into the next repetition, where the same song time comes
   * round again. The clock does not repeat, so a cursor on it only moves forward
   * and no note can be dispatched twice.
   */
  const scheduledUpToClockRef = useRef(0);
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
   * scheduling window instead of only at the next Play. A note it changed is still
   * only ever dispatched once, because `scheduledUpToClockRef` moves forward only.
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
   * @param slice - The repetition this pass is writing into: where its window
   *   ends, and what the clock reads at song 0 for it. A slice whose base has
   *   moved on is a new repetition, and the curve opens again *at the seam*
   *   rather than wherever the pass that noticed it happened to run.
   * @param pin - State the value now. Called on a fresh run or an edit made
   *   mid-playback — which is what makes a Play from the middle of a ramp start
   *   at the level the ramp had reached rather than at its opening. Deliberately
   *   not used at a seam: `setVolume` cancels pending events, and by then the
   *   next repetition's are already on the timeline.
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
   * @param snap - Round every value to the grid the target can actually resolve,
   *   or null for a target that is genuinely continuous.
   *
   *   Passed for a `cc:` lane, where the target is a 7-bit controller: see
   *   `toControllerStep`. It changes what "the value moved" means as well as what
   *   is sent — a sampled curve then emits each controller step once, at the
   *   moment it crosses it, instead of `maxStep`'s worth of sub-step dither — so
   *   the two travel together rather than as a value filter and a rate filter that
   *   could disagree.
   */
  const advanceCurve = useCallback(
    (
      key: string,
      points: AutomationPoint[],
      fallback: number,
      elapsedBeat: number,
      bpm: number,
      slice: CycleWindow,
      pin: (value: number) => void,
      emit: ((value: number, when: number) => void) | null,
      maxStep: number | null,
      snap: ((value: number) => number) | null = null
    ) => {
      const base = slice.songStartClockTime;
      const horizon = slice.toSong;

      /** The curve at a beat, as the target can actually hold it. */
      const readAt = (beat: number) => {
        const value = valueAtBeat(points, beat, fallback);
        return snap ? snap(value) : value;
      };

      // Snapped values are already on the target's own grid, so two of them are
      // either the same value or a genuine step apart; an epsilon there could
      // only erase a step the target *can* resolve. Unsnapped, the epsilon is
      // what stops a flat stretch of curve from being twenty commands a second.
      const moved = (value: number, last: number) =>
        snap ? value !== last : Math.abs(value - last) > VOLUME_STEP_EPSILON;

      let cursor = automationRef.current.get(key);

      if (emit && cursor && cursor.points === points && cursor.cycleBase !== base) {
        // The curve has come round again. Its opening is *scheduled at the seam*,
        // so a repeat starts where the curve starts on the beat rather than a tick
        // or so into it. Only a curve that can be placed at a time gets this; a
        // stepped backend has no seam to aim at and simply follows the playhead.
        const openBeat = songTimeToBeat(slice.fromSong, bpm);
        const value = readAt(openBeat);
        const seam = toClockTime(slice.fromSong, base);

        if (maxStep === null) {
          const hold = Math.max(seam - SEAM_STEP_SECONDS, cursor.lastEmitClock);
          if (hold < seam) emit(cursor.lastValue, hold);
        }
        emit(value, seam);

        cursor = {
          index: firstPointAtOrAfter(points, openBeat),
          nextSongTime: slice.fromSong,
          points,
          lastValue: value,
          cycleBase: base,
          lastEmitClock: seam,
        };
        automationRef.current.set(key, cursor);
      } else if (!cursor || cursor.points !== points) {
        // Pinning cancels whatever was scheduled against the old curve and states
        // the value here.
        const value = readAt(elapsedBeat);
        pin(value);
        cursor = {
          index: firstPointAtOrAfter(points, elapsedBeat),
          // From where playback actually is, so a Play from the middle of a ramp
          // samples from there rather than replaying the curve's opening.
          nextSongTime: beatToSongTime(elapsedBeat, bpm),
          points,
          lastValue: value,
          cycleBase: base,
          lastEmitClock: Number.NEGATIVE_INFINITY,
        };
        automationRef.current.set(key, cursor);
      }

      if (!emit) {
        // Stepped instead of scheduled, for a backend whose value is set through
        // something with no notion of time. Only on a real change: a flat stretch
        // of curve is not twenty commands a second.
        const value = readAt(elapsedBeat);
        if (moved(value, cursor.lastValue)) {
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

          const when = toClockTime(songTime, base);
          emit(points[cursor.index].value, when);
          // Kept for the hold placed before the next seam: after the last
          // breakpoint the level simply stays there, so this is what the curve
          // reads when the repetition ends.
          cursor.lastValue = points[cursor.index].value;
          cursor.lastEmitClock = when;
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

        const value = readAt(songTimeToBeat(songTime, bpm));
        if (!moved(value, cursor.lastValue)) continue;

        const when = toClockTime(songTime, base);
        emit(value, when);
        cursor.lastValue = value;
        cursor.lastEmitClock = when;
      }
    },
    []
  );

  /**
   * Hand each instrument the part of every curve it owns that falls inside one
   * slice of this pass's look-ahead window: its volume, and one lane per automated
   * plugin parameter.
   *
   * Called once per slice, so a window spanning a seam writes the tail of this
   * repetition and the opening of the next in the same pass — the levels keeping
   * step with the notes, which are cut the same way.
   */
  const scheduleAutomation = useCallback(
    (cfg: PlaybackConfig, pool: InstrumentPool, elapsed: number, slice: CycleWindow) => {
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
            slice,
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
            slice,
            value => instrument.setTarget!(lane.target, value),
            // Sample-accurate, unlike a plugin's volume: a change goes through
            // VST3's own queue, which carries a sample offset per point.
            (value, when) => instrument.automateTarget!(lane.target, value, when),
            PARAM_GRID_SECONDS,
            // A controller is 7-bit and a plugin parameter is not, so only the
            // former is snapped. The grid still finds the crossings; snapping
            // only decides which of them are worth sending.
            lane.target.kind === 'cc' ? toControllerStep : null
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
   * One scheduling pass: hand the instruments every note between where we left off
   * and the look-ahead horizon, then advance the playhead.
   *
   * The window is walked in slices rather than in one piece, because one reaching
   * past a loop seam covers two repetitions at once — the tail of the one playing
   * and the opening of the next, each against its own frame of reference.
   */
  const tick = useCallback(() => {
    const pool = poolRef.current;
    if (!pool) return;

    const cfg = configRef.current;
    // Re-derived here, not at Play: an edit since the last pass is already in the
    // config, and a note it changed is only ever dispatched once because
    // `scheduledUpToClockRef` moves forward only.
    const timings = timingsRef.current?.(cfg.bars) ?? [];
    const now = pool.now();
    const elapsed = now - songStartClockRef.current;
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

    /** Song time at which playback ends or wraps. */
    const endSong = loopFrom + loopDuration;
    // Widened by the deepest early nudge in the project. A note is *selected* by
    // its song time but *sounds* its instrument's nudge earlier, so on an early
    // instrument the two are not the same instant: leaving the horizon at the bare
    // look-ahead would pick the note up only once its sounding moment had already
    // passed — by the whole nudge, so a nudge deeper than the look-ahead would
    // arrive later than it does with no nudge at all, which is the opposite of what
    // it is for. Widening it here restores the full look-ahead of lead on every
    // instrument, nudged or not. Zero when nothing is nudged early.
    const horizonClock = now + LOOKAHEAD_SECONDS + preRollSeconds(cfg.tracks);

    /**
     * The look-ahead window, cut at the seam.
     *
     * Anything past the seam belongs to the next repetition and is placed against
     * a frame of reference one loop length further on. Cutting the window here —
     * rather than stopping at `endSong` and picking the rest up once the wrap has
     * been noticed — is what gives the notes at the top of a repeat the same
     * look-ahead as any other note. Without it they reached the instruments only
     * after their moment had passed, and each backend put a stale note at its own
     * idea of "immediately", which is what pulled them apart once per repetition.
     */
    const slices = cycleWindows(
      scheduledUpToClockRef.current,
      horizonClock,
      songStartClockRef.current,
      { from: loopFrom, end: endSong, repeat: cfg.loopEnabled }
    );

    // Mute and solo are read here, per note, rather than baked into `timings`,
    // so toggling either during playback is heard on the next tick. An audition set
    // is read the same way and for the same reason: opening or closing the phrase
    // editor mid-playback changes what is heard from the next tick rather than at the
    // next Play. When one is given it stands alone — see `audibleTrackIds`.
    const audible = new Set(
      cfg.audibleTrackIds ??
        cfg.tracks.filter(t => isTrackAudible(t, cfg.tracks, cfg.groups ?? [])).map(t => t.id)
    );

    // Each instrument's nudge off the beat, read here for the same reason.
    const offsets = trackOffsets(cfg.tracks);
  
    for (const slice of slices) {
      const due = notesInWindow({
        timings,
        fromSong: slice.fromSong,
        toSong: slice.toSong,
      });

      for (const note of due) {
        if (!audible.has(note.trackId)) continue;

        pool.get(note.trackId)?.schedule({
          midiNote: note.midiNote,
          velocity: note.velocity,
          // The instrument's nudge moves when it *sounds*, and nothing else: the
          // window it was selected by, the playhead and the automation cursors all
          // stay on the beat. Read per pass rather than baked into `timings`, like
          // mute and solo above, so dragging the control mid-run is heard on the
          // next tick. Room to be early was bought at Play by the pre-roll.
          when: toClockTime(note.startTime, slice.songStartClockTime) + (offsets.get(note.trackId) ?? 0),
          duration: note.duration,
        });
      }

      // Levels after notes, on the same slice: a fade is scheduled onto the gain
      // node rather than baked into the notes, so it is heard *through* a held
      // chord instead of only at the next note boundary.
      scheduleAutomation(cfg, pool, elapsed, slice);
    }

    scheduledUpToClockRef.current = Math.max(scheduledUpToClockRef.current, horizonClock);
  
    // Reaching the end either wraps the loop or ends playback. Wrapping shifts the
    // frame of reference forward by whole loop lengths rather than resetting it to
    // `now`, so the wrap lands on the beat instead of wherever the tick fired.
    if (elapsed >= endSong) {
      if (cfg.loopEnabled && loopDuration > 0) {
        // Whole repetitions at once, not one: a pass delayed past a short loop's
        // length would otherwise need a further pass per repetition to catch up,
        // each showing a playhead a repetition behind where the sound already is.
        const skipped = Math.floor((elapsed - loopFrom) / loopDuration) * loopDuration;
        songStartClockRef.current += skipped;
        // Bookkeeping only. This repetition's notes and levels went out a window
        // ago, scheduled across the seam, and the scheduling cursor is on the clock
        // rather than in song time so it needs no rewinding. The automation cursors
        // are deliberately left alone too: each is already walking the new
        // repetition, and dropping them would re-pin every level here — at a moment
        // the tick chose rather than the beat, cancelling the events just placed.
        //
        // Re-label the clicks already scheduled past the seam into the new frame.
        // Inferring the wrap from song time moving backward would not do: it fails
        // when the range starts at the top of the song and the wrap lands on the
        // same reading it started on.
        notifyLoopWrap(skipped);
        setCurrentTime(elapsed - skipped);
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
      //
      // The pre-roll pushes it the other way, by the deepest negative nudge in the
      // project, so an instrument asked to sound early has somewhere to be early
      // *to*. Everything is expressed against this one reference — notes,
      // automation, the click queue and the playhead — so they all shift together
      // and the arrangement is unmoved relative to itself. Zero unless something is
      // actually nudged early, which leaves Play as immediate as it ever was.
      songStartClockRef.current = pool.now() + preRollSeconds(configRef.current.tracks) - resumeFrom;
      scheduledUpToClockRef.current = songStartClockRef.current + resumeFrom;

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
    scheduledUpToClockRef.current = 0;
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
