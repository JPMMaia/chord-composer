import { useCallback, useEffect, useRef, useState } from 'react';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { songTimeToBeat } from '@/engine/scheduler';
import { getTotalBeats } from '@/engine/timeline';
import { phraseBarsForDisplay, phraseById } from '@/engine/phrases';
import { applyMovement, thin, toControllerValue } from '@/engine/touchpadExpression';
import type { InstrumentPool } from '@/engine/instrumentPool';
import type { AutomationPoint, AutomationTarget } from '@/types/music';

/**
 * The touchpad performs the selected instrument's assigned controller.
 *
 * A webview has no touchpad API — a laptop touchpad reaches it as a mouse reporting
 * relative motion — so the strip is built out of Pointer Lock: while the gesture is
 * held the cursor is taken away, and every `movementY` moves a value instead of moving
 * a pointer. That is what makes the whole window the control surface rather than some
 * widget the finger has to stay inside, and what stops the cursor sailing onto another
 * monitor halfway through a glissando.
 *
 * Like the MIDI keyboard, holding the gesture always *sounds*: stopped or playing,
 * armed or not, because trying a control out is how it gets set up. Arming decides only
 * whether what is played is also written — into an ordinary automation lane on the open
 * phrase, named by the same target the finger is driving.
 */

/** How long a run of unchanged samples may go unrecorded, in beats. */
const MIN_BEAT_GAP = 0.25;

/** How often buffered samples are written to the store, in milliseconds. */
const FLUSH_MS = 100;

/** How often the displayed value is refreshed while performing, in milliseconds. */
const DISPLAY_MS = 50;

/**
 * Where the value starts on the very first gesture of a session.
 *
 * Mid-throw rather than at either end: the finger can go both ways from here, and
 * nothing else is known — the plugin's own control is wherever its preset left it, and
 * there is no way to ask it.
 */
const INITIAL_VALUE = 0.5;

/** The key held to perform. `Space` is play/stop, `r` arms, `1`-`9` are the palette. */
const PERFORM_KEY = 'g';

export interface TouchpadExpression {
  /** Whether the gesture is being held right now — the cursor is locked and hidden. */
  performing: boolean;
  /** What the finger is currently saying, 0-127, for display while the cursor is gone. */
  controllerValue: number;
  /**
   * The target the touchpad would drive, or null when the selected instrument has none
   * assigned. What the Perform button disables itself on.
   */
  target: AutomationTarget | null;
  /**
   * Enter the gesture, for a pointer user who cannot hold a key and move at once.
   *
   * `untilPointerUp` is what a button held down passes. It has to be said here rather
   * than handled by the button, because once the lock is taken every mouse event
   * targets the locked element instead of the button — so the button's own
   * `pointerup` never arrives, and a gesture begun on it would stick until Escape.
   */
  begin: (untilPointerUp?: boolean) => void;
  /** Leave it. Idempotent — the browser can also end a lock on its own. */
  end: () => void;
}

interface UseTouchpadExpressionProps {
  isPlaying: boolean;
  /** Live song position in seconds, straight off the audio clock. */
  getSongTime: () => number;
  getPool: () => InstrumentPool | null;
  /** Brings the audio graph up, so a gesture before the first Play still reaches the plugin. */
  ensureAudio: () => Promise<InstrumentPool>;
  /**
   * The absolute song beat the edited surface's own beat 0 sits on — see `recordBeat`.
   * Omitted is the arrangement's own frame, where the two coincide.
   */
  originBeat?: number;
}

/** What a lane the touchpad opens calls itself, worded as the CC strip words one. */
function targetName(target: AutomationTarget): string {
  return target.kind === 'cc' ? `CC ${target.controller}` : `Param ${target.paramId}`;
}

export function useTouchpadExpression({
  isPlaying,
  getSongTime,
  getPool,
  ensureAudio,
  originBeat = 0,
}: UseTouchpadExpressionProps): TouchpadExpression {
  const [performing, setPerforming] = useState(false);
  const [controllerValue, setControllerValue] = useState(toControllerValue(INITIAL_VALUE));

  /**
   * The value the finger is on, held across gestures.
   *
   * A ref rather than state: it is written on every pointer event, and re-rendering the
   * app at pointer rate to redraw one number would make the very control that number is
   * measuring stutter. `controllerValue` is the throttled, displayable copy.
   */
  const valueRef = useRef(INITIAL_VALUE);

  /** Samples taken since the last flush, and the last one actually written. */
  const bufferRef = useRef<AutomationPoint[]>([]);
  const lastKeptRef = useRef<AutomationPoint | null>(null);

  /** The take in progress, captured so a mid-gesture selection change cannot strand it. */
  const takeRef = useRef<{ target: AutomationTarget; phraseId: string } | null>(null);

  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const propsRef = useRef({ getSongTime, getPool, ensureAudio, originBeat });
  propsRef.current = { getSongTime, getPool, ensureAudio, originBeat };

  /**
   * The selected instrument's touchpad assignment.
   *
   * Subscribed to both stores rather than read once: assigning a controller has to light
   * the Perform button up, and so does selecting an instrument that already has one.
   */
  const selectedTrackId = selectionStore(s => s.selectedTrackId);
  const target = projectStore(
    s =>
      (selectedTrackId
        ? s.project?.tracks.find(t => t.id === selectedTrackId)?.touchpadTarget
        : undefined) ?? null
  );

  useEffect(() => {
    /** Write what has been buffered, if anything survives the thinning. */
    const flush = () => {
      const take = takeRef.current;
      const samples = bufferRef.current;
      bufferRef.current = [];
      if (!take || samples.length === 0) return;

      const kept = thin(samples, lastKeptRef.current, MIN_BEAT_GAP);
      if (kept.length === 0) return;
      lastKeptRef.current = kept[kept.length - 1];

      // Never its own history entry: an armed pass is one undo step from its first
      // sample to the moment the transport stops, exactly as a recorded take is, so
      // Ctrl+Z scraps the gesture rather than picking it apart a breakpoint at a time.
      projectStore.getState().withRecording(() => {
        projectStore
          .getState()
          .recordLanePoints(take.phraseId, take.target, targetName(take.target), kept);
      });
    };

    /**
     * Whether this sample should be written, opening a take if one is not already open.
     *
     * Opened on the first sample rather than at the start of the gesture, so a finger
     * that never moves writes nothing at all — and so a lane the touchpad creates begins
     * where the sound did rather than where the key went down.
     */
    const openTake = (assigned: AutomationTarget): boolean => {
      if (takeRef.current) return true;

      const { recordArmed } = editorStore.getState();
      if (!recordArmed || !isPlayingRef.current) return false;

      const phraseId = projectStore.getState().editingPhraseId;
      if (!phraseId) return false;

      takeRef.current = { target: assigned, phraseId };
      lastKeptRef.current = null;
      return true;
    };

    /** The gesture's beat, in the open phrase's own beats, or null when off its end. */
    const beatNow = (): number | null => {
      const project = projectStore.getState().project;
      const take = takeRef.current;
      if (!project || !take) return null;

      const phrase = phraseById(project.phrases, take.phraseId);
      if (!phrase) return null;

      // Straight off the audio clock rather than off the playhead React renders, which is
      // up to a scheduling pass (50 ms) stale — a tenth of a beat at 120 BPM, and plainly
      // audible in the result. Unsnapped, unlike a recorded note: a curve quantised to
      // the grid is not the gesture that was played.
      // The clock speaks in song beats; the phrase is written in its own. `originBeat`
      // is where the placement being heard begins, so the subtraction is what makes the
      // two the same reading — the one the playhead is drawn at.
      const beat =
        songTimeToBeat(propsRef.current.getSongTime(), project.bpm) - propsRef.current.originBeat;

      // Bounded by the phrase, exactly as `recordSegment` is: a gesture held past the
      // last bar must not lengthen the phrase, because bars are added deliberately.
      const bars = phraseBarsForDisplay(phrase, project);
      return beat < getTotalBeats(bars, project.timeSignature) ? beat : null;
    };

    const sample = (movementY: number) => {
      const trackId = selectionStore.getState().selectedTrackId;
      const project = projectStore.getState().project;
      const assigned = trackId
        ? project?.tracks.find(t => t.id === trackId)?.touchpadTarget
        : undefined;
      if (!trackId || !assigned) return;

      const value = applyMovement(valueRef.current, movementY);
      valueRef.current = value;

      // The pool may not exist yet — nothing has pressed Play. Bring the graph up for the
      // samples that follow; this one has nothing to reach.
      const pool = propsRef.current.getPool();
      if (!pool) {
        void propsRef.current.ensureAudio().catch(() => {
          // An audio graph that will not start is reported by Play. Failing here would be
          // a rejection nobody is waiting on.
        });
        return;
      }

      // `setTarget` is optional on `Instrument` and implemented only by `Vst3Instrument`,
      // so a sampler track is skipped without a platform check.
      pool.get(trackId)?.setTarget?.(assigned, value);

      if (!openTake(assigned)) return;
      const beat = beatNow();
      if (beat === null) return;
      bufferRef.current.push({ beat, value });
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (!document.pointerLockElement) return;
      sample(e.movementY);
    };

    const flushTimer = setInterval(flush, FLUSH_MS);

    /**
     * The lock is the single source of truth for "a gesture is in progress".
     *
     * The browser ends one on its own — Escape, a window losing focus, a tab going to the
     * background — so tracking it with a flag of our own would leave the button lit over
     * a cursor that had already come back.
     */
    const handleLockChange = () => {
      const locked = document.pointerLockElement !== null;
      setPerforming(locked);
      if (locked) return;

      flush();
      takeRef.current = null;
      lastKeptRef.current = null;
    };

    document.addEventListener('pointerlockchange', handleLockChange);
    document.addEventListener('pointermove', handlePointerMove);

    return () => {
      clearInterval(flushTimer);
      document.removeEventListener('pointerlockchange', handleLockChange);
      document.removeEventListener('pointermove', handlePointerMove);
      // Unmounting is not a musical event: let the lock go, but write nothing measured
      // against a playhead that is going away.
      bufferRef.current = [];
      if (document.pointerLockElement) document.exitPointerLock();
    };
    // Once per mount, deliberately: see `propsRef` above.
  }, []);

  /** Show the value at a rate a person can read, rather than at pointer rate. */
  useEffect(() => {
    if (!performing) return;

    const timer = setInterval(
      () => setControllerValue(toControllerValue(valueRef.current)),
      DISPLAY_MS
    );
    return () => {
      clearInterval(timer);
      // Where the finger left it, so the button does not keep showing the second-to-last
      // value once the gesture is over.
      setControllerValue(toControllerValue(valueRef.current));
    };
  }, [performing]);

  const begin = useCallback((untilPointerUp: boolean = false) => {
    if (document.pointerLockElement) return;

    if (untilPointerUp) {
      // One-shot, and on the window: the press that started this is about to be
      // swallowed by the lock, so the release has to be caught wherever it lands.
      window.addEventListener(
        'pointerup',
        () => {
          if (document.pointerLockElement) document.exitPointerLock();
        },
        { once: true }
      );
    }

    const element = document.body;
    // `unadjustedMovement` takes the OS pointer acceleration out, so the same finger
    // travel always means the same change — a controller has to be repeatable, and an
    // accelerated one is not. Not supported everywhere, and the older signature returns
    // undefined rather than a promise, so both are handled rather than assumed.
    const request = element.requestPointerLock as (options?: {
      unadjustedMovement?: boolean;
    }) => Promise<void> | undefined;

    let requested: Promise<void> | undefined;
    try {
      requested = request.call(element, { unadjustedMovement: true });
    } catch {
      requested = Promise.reject(new Error('pointer lock refused'));
    }

    void Promise.resolve(requested).catch(() => {
      // The option was refused, not the lock. Ask again plainly rather than leaving the
      // gesture unavailable: acceleration makes a worse control, not a broken one.
      try {
        element.requestPointerLock();
      } catch {
        // Nothing to do. `pointerlockchange` never fires, so the button stays unlit and
        // the touchpad simply does not perform here.
      }
    });
  }, []);

  const end = useCallback(() => {
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);

  // Holding a key to perform, so the other hand stays on the touchpad. Ignored while
  // typing, like every other single-key shortcut in the app.
  useEffect(() => {
    const typing = (e: KeyboardEvent): boolean => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el?.isContentEditable === true
      );
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== PERFORM_KEY) return;
      // `e.repeat` because holding the key is the gesture: the auto-repeat that follows
      // is the OS talking, not a second press.
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || typing(e)) return;
      if (!target) return;

      e.preventDefault();
      begin();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== PERFORM_KEY) return;
      end();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [begin, end, target]);

  // Stopping ends the gesture with it: Stop rewinds the playhead, so there is no longer
  // a position to measure the rest of one against.
  useEffect(() => {
    if (isPlaying) return;
    if (document.pointerLockElement) document.exitPointerLock();
  }, [isPlaying]);

  return { performing, controllerValue, target, begin, end };
}
