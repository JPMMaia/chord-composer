import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTouchpadExpression } from '@/hooks/useTouchpadExpression';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { openTestPhrase } from '../helpers/phrases';
import { laneFor } from '@/engine/parameterAutomation';
import { phraseById } from '@/engine/phrases';
import { FULL_THROW_PX } from '@/engine/touchpadExpression';
import type { InstrumentPool } from '@/engine/instrumentPool';
import type { AutomationPoint, AutomationTarget } from '@/types/music';

const CC11 = { kind: 'cc', controller: 11 } as const;

const state = () => projectStore.getState();
const trackId = (): string => state().project!.tracks[0].id;

/** Every target the instrument has been told to state, in order. */
const sent: Array<{ target: AutomationTarget; value: number }> = [];

const pool = {
  get: () => ({
    name: 'Mock plugin',
    now: () => 0,
    load: async () => {},
    isLoaded: true,
    schedule: vi.fn(),
    setTarget: (target: AutomationTarget, value: number) => sent.push({ target, value }),
    automateTarget: vi.fn(),
    stopAll: vi.fn(),
    setVolume: vi.fn(),
    dispose: vi.fn(),
  }),
} as unknown as InstrumentPool;

/**
 * jsdom implements neither pointer lock nor `movementY`.
 *
 * `requestPointerLock` is a no-op that never fires `pointerlockchange`, and
 * `MouseEvent`'s init dictionary drops `movementY` on the floor — the same gap as the
 * known `clientY`-on-drag-events one. So the lock is stubbed here, held in a variable
 * the test drives, and the movement is defined onto each event by hand.
 */
let locked: Element | null = null;

function installPointerLock() {
  locked = null;
  Object.defineProperty(document, 'pointerLockElement', {
    get: () => locked,
    configurable: true,
  });
  Element.prototype.requestPointerLock = function requestPointerLock(this: Element) {
    locked = this;
    document.dispatchEvent(new Event('pointerlockchange'));
    return Promise.resolve();
  } as Element['requestPointerLock'];
  document.exitPointerLock = () => {
    locked = null;
    document.dispatchEvent(new Event('pointerlockchange'));
  };
}

/** Move the finger, in pixels. Negative is up, as `movementY` counts downward. */
function move(movementY: number) {
  act(() => {
    const event = new MouseEvent('pointermove', { bubbles: true });
    Object.defineProperty(event, 'movementY', { value: movementY });
    document.dispatchEvent(event);
  });
}

/**
 * Tap the perform key, on the window as a shortcut with no focus arrives.
 *
 * `on` is for the one case that has to come from somewhere else: a key typed into a
 * field, which reaches the window by bubbling and must be ignored there.
 */
const press = (init: KeyboardEventInit = {}, on: EventTarget = window) =>
  act(() => {
    on.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true, ...init }));
  });

/** Let the key up. Nothing should come of it — the gesture latches. */
const release = () =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'g', bubbles: true }));
  });

/** Song position in seconds, driven by the test. 120 BPM, so a beat is half a second. */
let songTime = 0;
const beatsIn = (beats: number) => {
  songTime = beats / 2;
};

let livePool: InstrumentPool | null = pool;
const ensureAudio = vi.fn(async () => pool);

function mount(isPlaying = true, originBeat = 0) {
  return renderHook(
    ({ playing }: { playing: boolean }) =>
      useTouchpadExpression({
        isPlaying: playing,
        getSongTime: () => songTime,
        getPool: () => livePool,
        ensureAudio,
        originBeat,
      }),
    { initialProps: { playing: isPlaying } }
  );
}

/** The performed curve on the open phrase. */
function recorded(phraseId: string): AutomationPoint[] {
  const phrase = phraseById(state().project!.phrases, phraseId)!;
  return laneFor(phrase.parameterAutomation ?? [], 'cc:11')?.points ?? [];
}

/** Let the 100 ms flush timer come round. */
const flush = () => act(() => vi.advanceTimersByTime(150));

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  songTime = 0;
  livePool = pool;
  ensureAudio.mockClear();
  installPointerLock();

  projectStore.getState().resetProject();
  projectStore.getState().createProject();
  projectStore.getState().addBar();
  selectionStore.getState().selectTrack(trackId());
  editorStore.setState({ recordArmed: false });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'pointerLockElement');
});

describe('performing', () => {
  it('does nothing until the gesture is entered', () => {
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    mount();

    move(-40);
    expect(sent).toEqual([]);
  });

  it('drives the assigned controller while the gesture is running', () => {
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    const { result } = mount();

    act(() => result.current.begin());
    expect(result.current.performing).toBe(true);

    // Half the throw upward from the middle: the value reaches the top.
    move(-FULL_THROW_PX / 2);
    expect(sent).toEqual([{ target: CC11, value: 1 }]);
  });

  it('lowers it when the finger moves down', () => {
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    const { result } = mount();

    act(() => result.current.begin());
    move(FULL_THROW_PX / 4);
    expect(sent[0].value).toBeCloseTo(0.25);
  });

  it('accumulates across moves, because the touchpad reports deltas', () => {
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    const { result } = mount();

    act(() => result.current.begin());
    move(-FULL_THROW_PX / 4);
    move(-FULL_THROW_PX / 4);
    expect(sent.map(s => s.value)).toEqual([0.75, 1]);
  });

  it('sends nothing for an instrument with no assignment', () => {
    const { result } = mount();

    act(() => result.current.begin());
    move(-40);
    expect(sent).toEqual([]);
  });

  it('reports the value as a controller number while the cursor is gone', () => {
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    const { result } = mount();

    act(() => result.current.begin());
    move(-FULL_THROW_PX / 2);
    act(() => vi.advanceTimersByTime(60));
    expect(result.current.controllerValue).toBe(127);
  });

  it('ends when the browser drops the lock on its own', () => {
    // Escape, or the window losing focus. Tracking this with a flag of our own would
    // leave the button lit over a cursor that had already come back.
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    const { result } = mount();

    act(() => result.current.begin());
    act(() => document.exitPointerLock());

    expect(result.current.performing).toBe(false);
    move(-40);
    expect(sent).toEqual([]);
  });

  it('brings the audio graph up when nothing has pressed Play yet', () => {
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    livePool = null;
    const { result } = mount(false);

    act(() => result.current.begin());
    move(-40);

    expect(ensureAudio).toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});

describe('the perform key', () => {
  beforeEach(() => {
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
  });

  it('enters the gesture on a tap', () => {
    const { result } = mount();

    press();
    expect(result.current.performing).toBe(true);

    move(-FULL_THROW_PX / 2);
    expect(sent).toEqual([{ target: CC11, value: 1 }]);
  });

  it('stays in it once the key is let go — the point of the latch', () => {
    const { result } = mount();

    press();
    release();

    expect(result.current.performing).toBe(true);
    move(-FULL_THROW_PX / 2);
    expect(sent).toHaveLength(1);
  });

  it('leaves on the next tap, writing what was played', () => {
    const { phraseId } = openTestPhrase(trackId(), 2);
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    editorStore.setState({ recordArmed: true });
    const { result } = mount();

    press();
    beatsIn(0.5);
    move(-40);
    press();

    expect(result.current.performing).toBe(false);
    expect(recorded(phraseId).map(p => p.beat)).toEqual([0.5]);
  });

  it('ignores the auto-repeat of a key held down', () => {
    // Or the OS would toggle the lock at the repeat rate for as long as `G` is down.
    const { result } = mount();

    press();
    press({ repeat: true });
    press({ repeat: true });

    expect(result.current.performing).toBe(true);
  });

  it('leaves it alone when the key is typed into a field', () => {
    const { result } = mount();
    const field = document.createElement('input');
    document.body.appendChild(field);

    press({}, field);
    expect(result.current.performing).toBe(false);

    field.remove();
  });

  it('leaves it alone when the key is part of a shortcut', () => {
    const { result } = mount();

    press({ ctrlKey: true });
    press({ metaKey: true });
    press({ altKey: true });

    expect(result.current.performing).toBe(false);
  });

  it('does not enter for an instrument with nothing assigned', () => {
    projectStore.getState().setTrackTouchpadTarget(trackId(), null);
    const { result } = mount();

    press();
    expect(result.current.performing).toBe(false);
  });

  it('still leaves when the assignment is taken away mid-gesture', () => {
    // Leaving must not depend on the assignment, or unassigning the controller would
    // strand a locked cursor with no key left to release it.
    const { result } = mount();

    press();
    act(() => projectStore.getState().setTrackTouchpadTarget(trackId(), null));
    press();

    expect(result.current.performing).toBe(false);
  });
});

describe('recording', () => {
  it('writes nothing while unarmed, however much is played', () => {
    // Playing a control is how it gets set up; arming is what decides whether that is
    // also written down.
    const { phraseId } = openTestPhrase(trackId(), 2);
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    const { result } = mount();

    act(() => result.current.begin());
    move(-40);
    flush();

    expect(recorded(phraseId)).toEqual([]);
  });

  it('writes the gesture into the controller lane while armed and rolling', () => {
    const { phraseId } = openTestPhrase(trackId(), 2);
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    editorStore.setState({ recordArmed: true });
    const { result } = mount();

    act(() => result.current.begin());
    beatsIn(0);
    move(-FULL_THROW_PX / 4);
    beatsIn(1);
    move(-FULL_THROW_PX / 4);
    flush();

    expect(recorded(phraseId)).toEqual([
      { beat: 0, value: 0.75 },
      { beat: 1, value: 1 },
    ]);
  });

  it('writes unsnapped, because a curve on the grid is not the gesture played', () => {
    const { phraseId } = openTestPhrase(trackId(), 2);
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    editorStore.setState({ recordArmed: true, snapBeats: 1 });
    const { result } = mount();

    act(() => result.current.begin());
    beatsIn(0.37);
    move(-40);
    flush();

    expect(recorded(phraseId).map(p => p.beat)).toEqual([0.37]);
  });

  it('thins a finger held still down to one breakpoint', () => {
    const { phraseId } = openTestPhrase(trackId(), 2);
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    editorStore.setState({ recordArmed: true });
    const { result } = mount();

    act(() => result.current.begin());
    beatsIn(0);
    move(-40);
    // Zero-movement reports, as a resting finger produces.
    beatsIn(0.05);
    move(0);
    beatsIn(0.1);
    move(0);
    flush();

    expect(recorded(phraseId)).toHaveLength(1);
  });

  it('stops at the end of the phrase rather than lengthening it', () => {
    // Bars are added deliberately, not by holding a gesture past the last one.
    const { phraseId } = openTestPhrase(trackId(), 1);
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    editorStore.setState({ recordArmed: true });
    const { result } = mount();

    act(() => result.current.begin());
    beatsIn(0);
    move(-40);
    beatsIn(99);
    move(-40);
    flush();

    expect(recorded(phraseId).map(p => p.beat)).toEqual([0]);
  });

  it('writes nothing when the transport is stopped', () => {
    const { phraseId } = openTestPhrase(trackId(), 2);
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    editorStore.setState({ recordArmed: true });
    const { result } = mount(false);

    act(() => result.current.begin());
    move(-40);
    flush();

    expect(recorded(phraseId)).toEqual([]);
    // But it was still heard: playing a control does not depend on the transport.
    expect(sent).toHaveLength(1);
  });

  it('flushes what is left when the gesture ends', () => {
    const { phraseId } = openTestPhrase(trackId(), 2);
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    editorStore.setState({ recordArmed: true });
    const { result } = mount();

    act(() => result.current.begin());
    beatsIn(0.5);
    move(-40);
    // No timer tick: ending the gesture is what has to write this.
    act(() => result.current.end());

    expect(recorded(phraseId).map(p => p.beat)).toEqual([0.5]);
  });

  it('survives the pointer release that started it, however it was begun', () => {
    // The press on the button is swallowed by the lock, so its release lands on the
    // locked element. The gesture latches, so that release means nothing to it.
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    const { result } = mount();

    act(() => result.current.begin());
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    expect(result.current.performing).toBe(true);
  });

  it('ends the gesture when the transport stops', () => {
    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    const { result, rerender } = mount(true);

    act(() => result.current.begin());
    act(() => rerender({ playing: false }));

    expect(result.current.performing).toBe(false);
  });

  // A phrase placed at the top of the song hides the difference between the two frames
  // the gesture stands between: the clock counts song beats, and a curve is written into
  // the phrase's own. Move the placement and they come apart.
  it('writes the curve in the beats of the phrase, not those of the song', () => {
    const state = projectStore.getState();
    // Eight bars, so a two-bar placement at bar 2 has room.
    for (let i = 0; i < 7; i++) state.addBar();

    const clipId = projectStore.getState().addPhraseClip(trackId(), 2, 2);
    if (!clipId) throw new Error('could not place the phrase');
    projectStore.getState().openClip(clipId);
    const phraseId = projectStore.getState().editingPhraseId!;

    projectStore.getState().setTrackTouchpadTarget(trackId(), CC11);
    // Re-armed after the clip is open: leaving the phrase view disarms recording.
    editorStore.setState({ recordArmed: true });

    /** The clip opens at bar 2, so its own beat 0 is eight song beats in at 4/4. */
    const ORIGIN = 8;
    const { result } = mount(true, ORIGIN);

    act(() => result.current.begin());
    beatsIn(ORIGIN);
    move(-FULL_THROW_PX / 4);
    beatsIn(ORIGIN + 1);
    move(-FULL_THROW_PX / 4);
    flush();

    expect(recorded(phraseId)).toEqual([
      { beat: 0, value: 0.75 },
      { beat: 1, value: 1 },
    ]);
  });
});
