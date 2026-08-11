import { useEffect, useRef, useState } from 'react';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { sustainPitch } from '@/engine/audition';
import { openMidiInputs } from '@/engine/midiInput';
import type { MidiInputStatus, MidiNoteEvent } from '@/engine/midiInput';
import { recordBeat, recordFloor } from '@/engine/recording';
import type { InstrumentPool } from '@/engine/instrumentPool';
import { generateId } from '@/utils/id';
import type { ChordSegment, SegmentNote } from '@/types/music';

/** A MIDI key currently held down. */
interface HeldKey {
  /** Silences it. Safe to call more than once. */
  release: () => void;
  /** Its entry in the open take, so its note-off can give it a length. Null when not recording. */
  note: SegmentNote | null;
}

/**
 * The block being played into right now.
 *
 * One at a time: a take is closed the moment every key is up, so there is never a
 * second one waiting to start.
 */
interface OpenTake {
  segmentId: string;
  /** Where it began, in absolute beats. */
  startBeat: number;
  /** The instrument it is being written to, captured so a mid-take switch cannot strand it. */
  trackId: string;
  notes: SegmentNote[];
}

interface UseMidiInputProps {
  isPlaying: boolean;
  /** Live song position in seconds, straight off the audio clock. */
  getSongTime: () => number;
  getPool: () => InstrumentPool | null;
  /** Brings the audio graph up, so a key pressed before the first Play still sounds. */
  ensureAudio: () => Promise<InstrumentPool>;
  /**
   * Records without creating a history entry. Every commit but the last goes through
   * this, so a take is one undo step however many notes are in it.
   */
  recordGated: (trackId: string, startBeat: number, segment: ChordSegment) => void;
}

/**
 * A MIDI keyboard plays the selected instrument, and records what it plays.
 *
 * Pressing a key always sounds it — stopped or playing, armed or not — because
 * trying an instrument out is how one gets chosen. Arming decides only whether what
 * is played is also *written*, exactly as the number keys work.
 *
 * **Grouping.** While armed and playing, notes are collected into `custom` blocks by
 * legato: a block opens on the first key pressed with nothing else down, and every
 * key pressed before the last one comes up joins it. Held chords therefore come out
 * as one block, a detached melody as one block per note, and a rolled or overlapping
 * figure stays together — which is what was played. Nothing else could group them:
 * a MIDI keyboard sends no phrase marks, and the alternative, one block per key,
 * turns every chord into a stack of blocks that must be moved together forever after.
 *
 * The position comes from `getSongTime` rather than from the playhead React renders,
 * which is up to a scheduling pass (50 ms) stale.
 */
export function useMidiInput({
  isPlaying,
  getSongTime,
  getPool,
  ensureAudio,
  recordGated,
}: UseMidiInputProps): MidiInputStatus {
  const [status, setStatus] = useState<MidiInputStatus>({ support: 'ok', inputs: [] });

  /** Keys held down, by MIDI note number. Outlives renders, so a re-render cannot drop one. */
  const heldRef = useRef(new Map<number, HeldKey>());
  const takeRef = useRef<OpenTake | null>(null);
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  /**
   * The callbacks, read through a ref so the effect below can run exactly once.
   *
   * Depending on them directly would be worse than merely wasteful: the effect
   * reports what it found through `setStatus`, so a caller passing an inline
   * function would re-render, re-run the effect, and request MIDI access again —
   * forever. Ports are opened once per mount, which is also simply what they are.
   */
  const propsRef = useRef({ getSongTime, getPool, ensureAudio, recordGated });
  propsRef.current = { getSongTime, getPool, ensureAudio, recordGated };

  useEffect(() => {
    const held = heldRef.current;

    /** Where the playhead is now, in absolute beats, snapped as the user asked. */
    const beatNow = (): number => {
      const project = projectStore.getState().project;
      const { recordQuantize, snapBeats } = editorStore.getState();
      return recordBeat(propsRef.current.getSongTime(), project?.bpm ?? 120, {
        recordQuantize,
        snapBeats,
      });
    };

    const floorNow = (): number => {
      const { recordQuantize, snapBeats } = editorStore.getState();
      return recordFloor({ recordQuantize, snapBeats });
    };

    /**
     * The block as it stands, ready to be committed.
     *
     * Its length is measured to the end of the last note in it, so a block never
     * stops before something inside it does — and never runs on past the playing.
     */
    const takeSegment = (take: OpenTake): ChordSegment => {
      const floor = floorNow();
      const end = take.notes.reduce((max, n) => Math.max(max, n.startBeat + n.duration), 0);
      return {
        id: take.segmentId,
        kind: 'custom',
        duration: Math.max(floor, end),
        // Copied, because the take keeps mutating the originals as more keys land
        // and the store must not be handed a list that changes under it.
        customNotes: take.notes.map(n => ({ ...n })),
      };
    };

    /** Write the take where it stands, without disturbing the undo history. */
    const commit = (take: OpenTake) => {
      propsRef.current.recordGated(take.trackId, take.startBeat, takeSegment(take));
    };

    /**
     * Finish the take: one last write, this time through the plain store action so
     * the whole thing lands in the history as a single step.
     */
    const closeTake = (commitIt: boolean) => {
      const take = takeRef.current;
      takeRef.current = null;
      if (!take || !commitIt) return;
      projectStore.getState().recordSegment(take.trackId, take.startBeat, takeSegment(take));
    };

    const handleNoteOn = (event: MidiNoteEvent) => {
      // A key already down repeating is not a second press. Some controllers do
      // send a second note-on for a held key; starting a fresh voice for it would
      // leave the first one sounding with nothing left to stop it.
      if (held.has(event.note)) return;

      const trackId = selectionStore.getState().selectedTrackId;
      if (!trackId) return;

      // The pool may not exist yet — nothing has pressed Play. Sound what we can
      // now and bring the graph up for the keys that follow; the first note of a
      // session is lost to the sample download either way.
      const pool = propsRef.current.getPool();
      if (!pool) {
        void propsRef.current.ensureAudio().catch(() => {
          // Nothing to do: an audio graph that will not start is reported by Play,
          // and failing here would be a rejection nobody is waiting on.
        });
      }

      const release = sustainPitch(pool?.get(trackId), event.note, event.velocity);

      let note: SegmentNote | null = null;
      const { recordArmed } = editorStore.getState();
      if (recordArmed && isPlayingRef.current) {
        const now = beatNow();

        // Nothing held means nothing being played into: this key starts a block.
        if (!takeRef.current) {
          takeRef.current = { segmentId: generateId(), startBeat: now, trackId, notes: [] };
        }
        const take = takeRef.current;

        note = {
          pitch: event.note,
          // Never negative: quantization can round a note landing just after the
          // block's start back onto the grid step before it.
          startBeat: Math.max(0, now - take.startBeat),
          // Grown by the note-off. Committed at the floor meanwhile, so the block
          // is visible during the very gesture that is filling it rather than
          // appearing only once the key comes up.
          duration: floorNow(),
          velocity: event.velocity,
        };
        take.notes.push(note);
        commit(take);
      }

      held.set(event.note, { release, note });
    };

    const handleNoteOff = (event: MidiNoteEvent) => {
      const key = held.get(event.note);
      if (!key) return;
      held.delete(event.note);
      key.release();

      const take = takeRef.current;
      if (!take) return;

      if (key.note) {
        // Mutated in place: `note` is the same object sitting in `take.notes`.
        key.note.duration = Math.max(floorNow(), beatNow() - take.startBeat - key.note.startBeat);
      }

      // The last key up ends the take. Anything played from here begins a new block.
      if (held.size === 0) {
        closeTake(true);
      } else {
        commit(take);
      }
    };

    const close = openMidiInputs({
      onEvent: event => {
        if (event.type === 'noteOn') handleNoteOn(event);
        else handleNoteOff(event);
      },
      onStatus: setStatus,
    });

    /** Losing the window loses the note-offs, so everything held is let go. */
    const handleBlur = () => {
      for (const key of held.values()) key.release();
      held.clear();
      closeTake(true);
    };
    window.addEventListener('blur', handleBlur);

    return () => {
      close();
      window.removeEventListener('blur', handleBlur);
      for (const key of held.values()) key.release();
      held.clear();
      // Unmounting is not a musical event: silence what is held, but do not write a
      // block measured against a playhead that is going away.
      closeTake(false);
    };
    // Once per mount, deliberately: see `propsRef` above.
  }, []);

  // Playback ending ends the take with it. The block keeps the length it had
  // reached rather than being re-committed: Stop rewinds the playhead, so there is
  // no longer a position to measure a release against.
  useEffect(() => {
    if (isPlaying) return;
    for (const key of heldRef.current.values()) key.release();
    heldRef.current.clear();
    takeRef.current = null;
  }, [isPlaying]);

  return status;
}
