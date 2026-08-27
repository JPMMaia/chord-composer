import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, fireEvent } from '@testing-library/react';
import { useRecordShortcuts } from '@/hooks/useRecordShortcuts';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { editableBars, editedChords, openTestPhrase } from '../helpers/phrases';
import { PHRASE_TRACK_KEY } from '@/engine/phrases';
import { barChords } from '@/engine/timeline';
import type { InstrumentPool } from '@/engine/instrumentPool';
import type { ChordSegment } from '@/types/music';

const state = () => projectStore.getState();
const trackId = (): string => state().project!.tracks[0].id;

/** Every block on the recorded track, in project order, as `symbol@absoluteBeat+length`. */
function takes(): string[] {
  const project = state().project!;
  const result: string[] = [];
  let barStart = 0;
  for (const bar of project.bars) {
    for (const c of barChords(bar, trackId())) {
      result.push(`${c.chordSymbol}@${barStart + (c.startBeat ?? 0)}+${c.duration}`);
    }
    barStart += (bar.timeSignature ?? project.timeSignature).beatsPerMeasure;
  }
  return result;
}

/** Notes handed to the instrument for preview, and the pitches released again. */
const started: number[] = [];
const stopped: number[] = [];

/** A pool exposing one instrument that can hold a note. */
const pool = {
  get: () => ({
    name: 'Mock',
    now: () => 0,
    load: async () => {},
    isLoaded: true,
    schedule: vi.fn(),
    sustain: ({ midiNote }: { midiNote: number }) => {
      started.push(midiNote);
      return () => stopped.push(midiNote);
    },
    stopAll: vi.fn(),
    setVolume: vi.fn(),
    dispose: vi.fn(),
  }),
} as unknown as InstrumentPool;

/** Song position in seconds, driven by the test. 120 BPM, so a beat is half a second. */
let songTime = 0;
const beatsIn = (beats: number) => {
  songTime = beats / 2;
};

function mount(isPlaying = true, originBeat = 0) {
  return renderHook(
    ({ playing }: { playing: boolean }) =>
      useRecordShortcuts({
        isPlaying: playing,
        getSongTime: () => songTime,
        getPool: () => pool,
        originBeat,
        record: (tId: string, pressBeat: number, seg: import('@/types/music').ChordSegment) => {
          // Gated commit: writes the segment but silences the undo middleware.
          // In the real App this is withRecording(() => recordSegment(...)).
          projectStore.getState().withRecording(() =>
            projectStore.getState().recordSegment(tId, pressBeat, seg)
          );
        },
      }),
    { initialProps: { playing: isPlaying } }
  );
}

/** A number-key press, identified by its physical key as the hook reads it. */
const press = (digit: number, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(window, { key: String(digit), code: `Digit${digit}`, ...init });
const release = (digit: number) =>
  fireEvent.keyUp(window, { key: String(digit), code: `Digit${digit}` });

describe('useRecordShortcuts', () => {
  beforeEach(() => {
    state().resetProject();
    state().createProject();
    // Four bars, so a take has room to run.
    for (let i = 0; i < 3; i++) state().addBar();

    selectionStore.getState().clearSelection();
    selectionStore.getState().selectTrack(trackId());
    // A take lands in the open phrase; recording is refused when there is none.
    openTestPhrase(trackId(), 4);

    editorStore.setState({
      paletteScale: { root: 'C', type: 'major' },
      paletteMode: 'chords',
      paletteOctave: 4,
      recordArmed: true,
      recordQuantize: true,
      snapBeats: 1,
    });

    songTime = 0;
    started.length = 0;
    stopped.length = 0;
  });

  it('writes the degree the key names at the playhead', () => {
    mount();
    beatsIn(4);
    press(2);
    beatsIn(6);
    release(2);

    expect(takes()).toEqual(['Dm@4+2']);
  });

  it('commits on key-down so the block is visible while it is being played', () => {
    mount();
    beatsIn(2);
    press(1);

    expect(takes()).toEqual(['C@2+0.125']);
  });

  it('sounds the block while held and releases it on key-up', () => {
    mount();
    press(1);
    expect(started).toEqual([60, 64, 67]);
    expect(stopped).toEqual([]);

    release(1);
    expect(stopped).toEqual([60, 64, 67]);
  });

  it('quantizes a sloppy press and release to the snap grid', () => {
    mount();
    beatsIn(1.4);
    press(5);
    beatsIn(3.4);
    release(5);

    expect(takes()).toEqual(['G@1+2']);
  });

  it('keeps the timing that was played when quantize is off', () => {
    editorStore.getState().setRecordQuantize(false);
    mount();
    beatsIn(1.3);
    press(5);
    beatsIn(2.3);
    release(5);

    // Rounded only to the 0.25-beat floor the engine works in.
    expect(takes()).toEqual(['G@1.25+1']);
  });

  it('gives a tap at least one grid step, rather than the rounding floor', () => {
    mount();
    beatsIn(2);
    press(1);
    beatsIn(2.1);
    release(1);

    expect(takes()).toEqual(['C@2+1']);
  });

  it('ignores auto-repeat rather than starting a take per repeat', () => {
    mount();
    beatsIn(1);
    press(3);
    press(3, { repeat: true });
    press(3, { repeat: true });
    beatsIn(3);
    release(3);

    expect(takes()).toEqual(['Em@1+2']);
  });

  it('follows the palette into another mode and register', () => {
    editorStore.getState().setPaletteMode('sevenths');
    editorStore.getState().setPaletteOctave(5);
    mount();
    press(2);
    release(2);

    expect(takes()).toEqual(['Dm7@0+1']);
    expect(started[0]).toBe(74);
  });

  it('auditions but writes nothing while disarmed', () => {
    editorStore.getState().setRecordArmed(false);
    mount();
    press(4);
    release(4);

    expect(takes()).toEqual([]);
    expect(started).toEqual([65, 69, 72]);
  });

  it('auditions but writes nothing while stopped', () => {
    mount(false);
    press(4);
    release(4);

    expect(takes()).toEqual([]);
    expect(started.length).toBeGreaterThan(0);
  });

  it('closes an open take when the window loses focus', () => {
    mount();
    beatsIn(0);
    press(1);
    beatsIn(2);
    fireEvent.blur(window);

    expect(takes()).toEqual(['C@0+2']);
    expect(stopped).toEqual([60, 64, 67]);
    // The lost keyup must not reopen or re-close anything.
    release(1);
    expect(takes()).toEqual(['C@0+2']);
  });

  it('silences an open take when playback ends', () => {
    const { rerender } = mount(true);
    press(1);
    rerender({ playing: false });

    expect(stopped).toEqual([60, 64, 67]);
  });

  it('wraps the degree past the end of the scale into the octave above', () => {
    editorStore.setState({ paletteMode: 'notes' });
    mount();
    press(8);
    release(8);

    // 8 is 1 an octave up: C4 is 60, so this is C5.
    expect(started).toEqual([72]);
    expect(takes()).toEqual(['C5@0+1']);
  });

  it('wraps at whatever width the scale actually has', () => {
    editorStore.getState().setPaletteScale({ root: 'C', type: 'pentatonicMajor' });
    editorStore.setState({ paletteMode: 'notes' });
    mount();
    // Five degrees, so 6 is the tonic an octave up rather than nothing at all.
    press(6);
    release(6);

    expect(started).toEqual([72]);
  });

  it('leaves the key alone while a text field has it', () => {
    mount();
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: '2', code: 'Digit2' });
    expect(takes()).toEqual([]);
    input.remove();
  });

  it('leaves modified number keys to the browser', () => {
    mount();
    press(2, { ctrlKey: true });
    expect(takes()).toEqual([]);
  });

  it('toggles the record arm with r', () => {
    mount();
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR' });
    expect(editorStore.getState().recordArmed).toBe(false);
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR' });
    expect(editorStore.getState().recordArmed).toBe(true);
  });

  it('overwrites what a take lands on instead of pushing it aside', () => {
    const existing: ChordSegment = {
      id: 'old',
      kind: 'chord',
      duration: 1,
      root: 'A',
      quality: 'minor',
      chordSymbol: 'Am',
    };
    state().insertSegment(state().project!.bars[0].id, 0, existing, trackId());

    mount();
    beatsIn(0);
    press(1);
    beatsIn(1);
    release(1);

    expect(takes()).toEqual(['C@0+1']);
  });

  // A phrase placed at the top of the song hides the difference between the two frames
  // the recorder stands between: the clock counts song beats, and a take is written into
  // the phrase's own bars. Move the placement and they come apart — which is the bug
  // `originBeat` closes.
  describe('a placement later in the song', () => {
    /** The clip opens at bar 2, so its own beat 0 is eight song beats in at 4/4. */
    const ORIGIN = 8;

    beforeEach(() => {
      state().resetProject();
      state().createProject();
      // Eight bars, so a four-bar placement at bar 2 has room.
      for (let i = 0; i < 7; i++) state().addBar();

      selectionStore.getState().clearSelection();
      selectionStore.getState().selectTrack(trackId());

      const clipId = state().addPhraseClip(trackId(), 2, 4);
      if (!clipId) throw new Error('could not place the phrase');
      state().openClip(clipId);

      // Re-armed after the clip is open, not before: leaving the phrase view — which
      // `resetProject` does — disarms recording.
      editorStore.setState({ recordArmed: true });

      songTime = 0;
    });

    /** The open phrase's bar, as `symbol@beatInBar+length`. */
    const phraseBar = (index: number) =>
      editedChords(index).map(c => `${c.chordSymbol}@${c.startBeat}+${c.duration}`);

    it('writes the take where the playhead is in the phrase, not where the phrase is in the song', () => {
      mount(true, ORIGIN);
      // One bar into the placement: song beat 12, phrase beat 4.
      beatsIn(ORIGIN + 4);
      press(2);
      beatsIn(ORIGIN + 6);
      release(2);

      expect(phraseBar(1)).toEqual(['Dm@0+2']);
      expect(phraseBar(3)).toEqual([]);
    });

    it('measures the take at the top of the placement against the phrase, not the song', () => {
      mount(true, ORIGIN);
      beatsIn(ORIGIN);
      press(1);
      beatsIn(ORIGIN + 1);
      release(1);

      expect(phraseBar(0)).toEqual(['C@0+1']);
    });
  });
});
