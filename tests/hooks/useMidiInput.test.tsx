import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, fireEvent } from '@testing-library/react';
import { useMidiInput } from '@/hooks/useMidiInput';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
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

/** `pitch@start+length` for the notes inside the one block on the timeline. */
function notesOf(index = 0): string[] {
  return (blocks()[index]?.customNotes ?? []).map(
    n => `${n.pitch}@${n.startBeat}+${n.duration}`
  );
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

function mount(isPlaying = true) {
  return renderHook(
    ({ playing }: { playing: boolean }) =>
      useMidiInput({
        isPlaying: playing,
        getSongTime: () => songTime,
        getPool: () => livePool,
        ensureAudio,
        recordGated: (tId: string, startBeat: number, seg: ChordSegment) => {
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
async function mountReady(isPlaying = true) {
  const rendered = mount(isPlaying);
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
    it('writes a held chord as one block holding all its notes', async () => {
      await mountReady();
      beatsIn(4);
      noteOn(60, 90);
      noteOn(64, 80);
      noteOn(67, 70);
      beatsIn(6);
      noteOff(60);
      noteOff(64);
      noteOff(67);

      expect(blocks()).toHaveLength(1);
      expect(blocks()[0].kind).toBe('custom');
      expect(notesOf()).toEqual(['60@0+2', '64@0+2', '67@0+2']);
      expect(layout()).toEqual(['4+2']);
    });

    it('keeps the velocity each note was played at', async () => {
      await mountReady();
      noteOn(60, 90);
      noteOn(64, 41);
      noteOff(60);
      noteOff(64);

      expect(blocks()[0].customNotes?.map(n => n.velocity)).toEqual([90, 41]);
    });

    it('opens a new block for a note played after everything is released', async () => {
      await mountReady();
      beatsIn(0);
      noteOn(60);
      beatsIn(1);
      noteOff(60);

      beatsIn(2);
      noteOn(62);
      beatsIn(3);
      noteOff(62);

      expect(blocks()).toHaveLength(2);
      expect(layout()).toEqual(['0+1', '2+1']);
      expect(notesOf(0)).toEqual(['60@0+1']);
      expect(notesOf(1)).toEqual(['62@0+1']);
    });

    it('keeps overlapping notes together — the last key up ends the block', async () => {
      // C is still down when E arrives, so E joins C's block rather than opening
      // one of its own. That is what legato grouping means.
      await mountReady();
      beatsIn(0);
      noteOn(60);
      beatsIn(1);
      noteOn(64);
      beatsIn(2);
      noteOff(60);
      beatsIn(3);
      noteOff(64);

      expect(blocks()).toHaveLength(1);
      expect(notesOf()).toEqual(['60@0+2', '64@1+2']);
      expect(layout()).toEqual(['0+3']);
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

    it('lands the whole take in the history as one step', async () => {
      // Only the last write of a take goes through the plain `recordSegment` the
      // undo middleware is subscribed to; every earlier one is gated, so however
      // many notes are played the take is a single Ctrl+Z.
      await mountReady();

      const gated: number[] = [];
      const plain: number[] = [];
      const store = projectStore.getState();
      const realWithRecording = store.withRecording;
      const realRecordSegment = store.recordSegment;

      projectStore.setState({
        withRecording: fn => {
          gated.push(1);
          return realWithRecording(fn);
        },
        recordSegment: (...args) => {
          // Counted only when not inside a gated call, which is the distinction
          // the middleware itself draws.
          if (gated.length === plain.length) plain.push(1);
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

      // Two note-ons and the first note-off are gated; the last key up is not.
      expect(gated).toHaveLength(3);
      expect(blocks()).toHaveLength(1);
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
});
