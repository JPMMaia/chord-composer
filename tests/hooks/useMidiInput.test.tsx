import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, fireEvent } from '@testing-library/react';
import { useMidiInput } from '@/hooks/useMidiInput';
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

/** Every block on the recorded track, in project order. */
function blocks(): ChordSegment[] {
  const project = state().project!;
  return project.bars.flatMap(bar => barChords(bar, trackId()));
}

/** Where each block sits, as `absoluteBeat+length`. */
function layout(): string[] {
  const project = state().project!;
  const result: string[] = [];
  let barStart = 0;
  for (const bar of project.bars) {
    for (const c of barChords(bar, trackId())) {
      result.push(`${barStart + (c.startBeat ?? 0)}+${c.duration}`);
    }
    barStart += (bar.timeSignature ?? project.timeSignature).beatsPerMeasure;
  }
  return result;
}

/** The same, naming the pitch and the sub-lane: `pitch@beat+length/lane`. */
function played(): string[] {
  const project = state().project!;
  const result: string[] = [];
  let barStart = 0;
  for (const bar of project.bars) {
    for (const c of barChords(bar, trackId())) {
      result.push(
        `${c.pitch}@${barStart + (c.startBeat ?? 0)}+${c.duration}/${c.lane ?? 0}`
      );
    }
    barStart += (bar.timeSignature ?? project.timeSignature).beatsPerMeasure;
  }
  return result;
}

/** Pitches handed to the instrument, and the ones released again. */
const started: Array<{ pitch: number; velocity: number }> = [];
const stopped: number[] = [];

const pool = {
  get: () => ({
    name: 'Mock',
    now: () => 0,
    load: async () => {},
    isLoaded: true,
    schedule: vi.fn(),
    sustain: ({ midiNote, velocity }: { midiNote: number; velocity: number }) => {
      started.push({ pitch: midiNote, velocity });
      return () => stopped.push(midiNote);
    },
    stopAll: vi.fn(),
    setVolume: vi.fn(),
    dispose: vi.fn(),
  }),
} as unknown as InstrumentPool;

/** The one port the fake Web MIDI implementation exposes. */
let port: { onmidimessage: ((e: { data: Uint8Array }) => void) | null };

function installFakeMidi() {
  port = { onmidimessage: null };
  const access = {
    inputs: new Map([['port-0', port]]),
    onstatechange: null as (() => void) | null,
  };
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    value: vi.fn().mockResolvedValue(access),
    configurable: true,
    writable: true,
  });
}

/** Push a note-on/note-off through the fake port, as a keyboard would. */
const noteOn = (pitch: number, velocity = 100) =>
  act(() => {
    port.onmidimessage?.({ data: new Uint8Array([0x90, pitch, velocity]) });
  });
const noteOff = (pitch: number) =>
  act(() => {
    port.onmidimessage?.({ data: new Uint8Array([0x80, pitch, 0]) });
  });

/** Song position in seconds, driven by the test. 120 BPM, so a beat is half a second. */
let songTime = 0;
const beatsIn = (beats: number) => {
  songTime = beats / 2;
};

const ensureAudio = vi.fn(async () => pool);
let livePool: InstrumentPool | null = pool;

function mount(isPlaying = true, originBeat = 0) {
  return renderHook(
    ({ playing }: { playing: boolean }) =>
      useMidiInput({
        isPlaying: playing,
        getSongTime: () => songTime,
        getPool: () => livePool,
        ensureAudio,
        originBeat,
        record: (tId: string, startBeat: number, seg: ChordSegment) => {
          // In the real App this is withRecording(() => recordSegment(...)):
          // it writes, but does not create a history entry.
          projectStore
            .getState()
            .withRecording(() => projectStore.getState().recordSegment(tId, startBeat, seg));
        },
      }),
    { initialProps: { playing: isPlaying } }
  );
}

/** Mount and wait for the fake access promise to settle. */
async function mountReady(isPlaying = true, originBeat = 0) {
  const rendered = mount(isPlaying, originBeat);
  await act(async () => {
    await Promise.resolve();
  });
  return rendered;
}

describe('useMidiInput', () => {
  beforeEach(() => {
    installFakeMidi();
    state().resetProject();
    state().createProject();
    // Four bars, so a take has room to run.
    for (let i = 0; i < 3; i++) state().addBar();

    selectionStore.getState().clearSelection();
    selectionStore.getState().selectTrack(trackId());
    // A take lands in the open phrase; recording is refused when there is none.
    openTestPhrase(trackId(), 4);

    editorStore.setState({ recordArmed: true, recordQuantize: true, snapBeats: 1 });

    songTime = 0;
    livePool = pool;
    started.length = 0;
    stopped.length = 0;
    ensureAudio.mockClear();
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'requestMIDIAccess');
  });

  describe('sounding the selected instrument', () => {
    it('sounds a key on the selected instrument, with the velocity it was played at', async () => {
      await mountReady();
      noteOn(60, 37);

      expect(started).toEqual([{ pitch: 60, velocity: 37 }]);
      expect(stopped).toEqual([]);
    });

    it('releases the note when the key comes up', async () => {
      await mountReady();
      noteOn(60);
      noteOff(60);

      expect(stopped).toEqual([60]);
    });

    it('sounds while stopped and unarmed — trying an instrument is not recording', async () => {
      editorStore.setState({ recordArmed: false });
      await mountReady(false);
      noteOn(60);

      expect(started).toHaveLength(1);
      expect(blocks()).toHaveLength(0);
    });

    it('ignores a repeated note-on for a key already down', async () => {
      // Some controllers send one. Starting a second voice would leave the first
      // sounding with nothing left to stop it.
      await mountReady();
      noteOn(60);
      noteOn(60);

      expect(started).toHaveLength(1);
    });

    it('brings the audio graph up when a key is pressed before the first Play', async () => {
      livePool = null;
      await mountReady(false);
      noteOn(60);

      expect(ensureAudio).toHaveBeenCalled();
    });

    it('reports the inputs it found', async () => {
      const { result } = await mountReady();
      expect(result.current).toEqual({ support: 'ok', inputs: ['MIDI input'] });
    });
  });

  describe('recording takes', () => {
    it('writes a held chord as one note block per key, stacked in lanes', async () => {
      await mountReady();
      beatsIn(4);
      noteOn(60, 90);
      noteOn(64, 80);
      noteOn(67, 70);
      beatsIn(6);
      noteOff(60);
      noteOff(64);
      noteOff(67);

      expect(blocks()).toHaveLength(3);
      expect(blocks().every(b => b.kind === 'note')).toBe(true);
      // Three named notes on one beat, each with its own row — the chord as it
      // was actually played, rather than one opaque block naming nothing.
      expect(played()).toEqual(['60@4+2/0', '64@4+2/1', '67@4+2/2']);
    });

    it('grows the instrument to hold the whole chord', async () => {
      await mountReady();
      noteOn(60);
      noteOn(64);
      noteOn(67);
      noteOn(71);
      noteOn(74);

      expect(state().project!.tracks[0].laneCount).toBe(5);
    });

    it('keeps the velocity each key was played at', async () => {
      await mountReady();
      noteOn(60, 90);
      noteOn(64, 41);
      noteOff(60);
      noteOff(64);

      expect(blocks().map(b => b.velocity)).toEqual([90, 41]);
    });

    it('reuses the lowest lane once the key holding it is up', async () => {
      // A melody played one note at a time never leaves lane 0, so an instrument
      // stays one row tall until something genuinely overlaps.
      await mountReady();
      beatsIn(0);
      noteOn(60);
      beatsIn(1);
      noteOff(60);

      beatsIn(2);
      noteOn(62);
      beatsIn(3);
      noteOff(62);

      expect(played()).toEqual(['60@0+1/0', '62@2+1/0']);
      expect(state().project!.tracks[0].laneCount).toBeUndefined();
    });

    it('stacks an overlapping note rather than rippling it along', async () => {
      // C is still down when E arrives, so E takes the next free lane and keeps
      // the beat it was played on.
      await mountReady();
      beatsIn(0);
      noteOn(60);
      beatsIn(1);
      noteOn(64);
      beatsIn(2);
      noteOff(60);
      beatsIn(3);
      noteOff(64);

      expect(played()).toEqual(['60@0+2/0', '64@1+2/1']);
    });

    it('commits on the first note-on, so the block is visible while it is played', async () => {
      await mountReady();
      beatsIn(2);
      noteOn(60);

      expect(blocks()).toHaveLength(1);
      expect(layout()).toEqual(['2+1']);
    });

    it('quantizes a sloppy take to the snap grid', async () => {
      await mountReady();
      beatsIn(1.4);
      noteOn(60);
      beatsIn(2.6);
      noteOff(60);

      expect(layout()).toEqual(['1+2']);
    });

    it('keeps the played timing when quantization is off', async () => {
      editorStore.setState({ recordQuantize: false, snapBeats: 1 });
      await mountReady();
      beatsIn(1.5);
      noteOn(60);
      beatsIn(2.25);
      noteOff(60);

      expect(layout()).toEqual(['1.5+0.75']);
    });

    it('writes nothing while unarmed', async () => {
      editorStore.setState({ recordArmed: false });
      await mountReady();
      noteOn(60);
      noteOff(60);

      expect(blocks()).toHaveLength(0);
    });

    it('writes nothing while stopped, even armed', async () => {
      await mountReady(false);
      noteOn(60);
      noteOff(60);

      expect(blocks()).toHaveLength(0);
    });

    it('never writes a history entry of its own', async () => {
      // Not one write in a gesture is a history entry: the recording pass around
      // the whole take is the undo step, so Ctrl+Z scraps the take rather than
      // picking it apart a note at a time.
      await mountReady();

      let depth = 0;
      const gated: number[] = [];
      const ungated: number[] = [];
      const store = projectStore.getState();
      const realWithRecording = store.withRecording;
      const realRecordSegment = store.recordSegment;

      projectStore.setState({
        withRecording: fn => {
          depth++;
          try {
            return realWithRecording(fn);
          } finally {
            depth--;
          }
        },
        recordSegment: (...args) => {
          (depth > 0 ? gated : ungated).push(1);
          return realRecordSegment(...args);
        },
      });

      try {
        noteOn(60);
        noteOn(64);
        noteOff(60);
        noteOff(64);
      } finally {
        projectStore.setState({
          withRecording: realWithRecording,
          recordSegment: realRecordSegment,
        });
      }

      expect(gated).toHaveLength(4);
      expect(ungated).toHaveLength(0);
      expect(blocks()).toHaveLength(2);
    });

    it('releases everything and abandons the take when playback stops', async () => {
      const { rerender } = await mountReady(true);
      beatsIn(1);
      noteOn(60);
      expect(blocks()).toHaveLength(1);

      act(() => rerender({ playing: false }));
      expect(stopped).toEqual([60]);

      // The block keeps the length it had reached; Stop has rewound the playhead,
      // so there is nothing left to measure a release against.
      expect(layout()).toEqual(['1+1']);

      // And the abandoned take is not resumed by a later note.
      beatsIn(0);
      noteOn(62);
      expect(blocks()).toHaveLength(1);
    });

    it('closes the take when the window loses focus', async () => {
      await mountReady();
      beatsIn(0);
      noteOn(60);
      beatsIn(2);
      act(() => {
        fireEvent.blur(window);
      });

      expect(stopped).toEqual([60]);
      // A new note starts a new block rather than joining the abandoned one.
      beatsIn(3);
      noteOn(64);
      expect(blocks()).toHaveLength(2);
    });

    it('silences a held note on unmount without writing a length', async () => {
      const { unmount } = await mountReady();
      beatsIn(1);
      noteOn(60);
      const before = layout();

      act(() => unmount());

      expect(stopped).toEqual([60]);
      expect(layout()).toEqual(before);
    });
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

    /** The open phrase's bar, as `pitch@beatInBar+length`. */
    const phraseBar = (index: number) =>
      editedChords(index).map(c => `${c.pitch}@${c.startBeat}+${c.duration}`);

    it('writes the note where the playhead is in the phrase, not where the phrase is in the song', async () => {
      await mountReady(true, ORIGIN);
      // One bar into the placement: song beat 12, phrase beat 4.
      beatsIn(ORIGIN + 4);
      noteOn(60);
      beatsIn(ORIGIN + 6);
      noteOff(60);

      expect(phraseBar(1)).toEqual(['60@0+2']);
      expect(phraseBar(3)).toEqual([]);
    });

    it('measures a note at the top of the placement against the phrase, not the song', async () => {
      await mountReady(true, ORIGIN);
      beatsIn(ORIGIN);
      noteOn(64);
      beatsIn(ORIGIN + 1);
      noteOff(64);

      expect(phraseBar(0)).toEqual(['64@0+1']);
    });
  });
});
