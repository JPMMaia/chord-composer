import { useEffect, useRef, useState } from 'react';
import { projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { editorStore } from '@/store/editorStore';
import { sustainPitch } from '@/engine/audition';
import { openMidiInputs } from '@/engine/midiInput';
import { getMidiPrefs, reportVelocity, shapeVelocity } from '@/engine/midiPrefs';
import type { MidiInputStatus, MidiNoteEvent } from '@/engine/midiInput';
import { recordBeat, recordFloor } from '@/engine/recording';
import type { InstrumentPool } from '@/engine/instrumentPool';
import { generateId } from '@/utils/id';
import type { ChordSegment } from '@/types/music';

/** A MIDI key currently held down. */
interface HeldKey {
  /** Silences it. Safe to call more than once. */
  release: () => void;
  /** The block this key is writing, or null when not recording. */
  take: OpenNote | null;
}

/** The block one held key is writing. */
interface OpenNote {
  segment: ChordSegment;
  /** Where it began, in the surface's own beats. */
  startBeat: number;
  /** The instrument it is being written to, captured so a mid-take switch cannot strand it. */
  trackId: string;
  /** The sub-lane it occupies for as long as it is held. */
  lane: number;
}

interface UseMidiInputProps {
  isPlaying: boolean;
  /** Live song position in seconds, straight off the audio clock. */
  getSongTime: () => number;
  getPool: () => InstrumentPool | null;
  /** Brings the audio graph up, so a key pressed before the first Play still sounds. */
  ensureAudio: () => Promise<InstrumentPool>;
  /**
   * The absolute song beat the edited surface's own beat 0 sits on — see `recordBeat`.
   * Omitted is the arrangement's own frame, where the two coincide.
   */
  originBeat?: number;
  /**
   * Writes a block to the timeline without creating a history entry of its own.
   * The whole recording pass is one undo step — see `useRecordSession` — so no
   * individual write here should be one.
   */
  record: (trackId: string, startBeat: number, segment: ChordSegment) => void;
}

/**
 * A MIDI keyboard plays the selected instrument, and records what it plays.
 *
 * Pressing a key always sounds it — stopped or playing, armed or not — because
 * trying an instrument out is how one gets chosen. Arming decides only whether what
 * is played is also *written*, exactly as the number keys work.
 *
 * **One key, one block.** Each key writes a plain `note` segment carrying the pitch,
 * onset, length and velocity it was played with, and takes the lowest sub-lane no
 * other held key is using. A chord therefore comes out as the several simultaneous
 * blocks it actually is, each one named material that can afterwards be transposed
 * by degree, retuned by a change of key, or moved on its own — none of which was
 * true of the single opaque block that held keys used to be grouped into.
 *
 * **The sustain pedal holds what is let go.** A key released with the pedal down
 * keeps sounding, and its block keeps growing, until the pedal comes up — so a
 * recorded take plays back as it was heard, on every backend, without a CC lane.
 *
 * The position comes from `getSongTime` rather than from the playhead React renders,
 * which is up to a scheduling pass (50 ms) stale.
 */
export function useMidiInput({
  isPlaying,
  getSongTime,
  getPool,
  ensureAudio,
  originBeat = 0,
  record,
}: UseMidiInputProps): MidiInputStatus {
  const [status, setStatus] = useState<MidiInputStatus>({ support: 'ok', inputs: [] });

  /** Keys held down, by MIDI note number. Outlives renders, so a re-render cannot drop one. */
  const heldRef = useRef(new Map<number, HeldKey>());
  /** Keys already up but kept sounding by the pedal, by MIDI note number. */
  const sustainedRef = useRef(new Map<number, HeldKey>());
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
  const propsRef = useRef({ getSongTime, getPool, ensureAudio, originBeat, record });
  propsRef.current = { getSongTime, getPool, ensureAudio, originBeat, record };

  useEffect(() => {
    const held = heldRef.current;
    const sustained = sustainedRef.current;
    let pedalDown = false;

    /** Where the playhead is now, in the edited surface's own beats, snapped as asked. */
    const beatNow = (): number => {
      const project = projectStore.getState().project;
      const { recordQuantize, snapBeats } = editorStore.getState();
      return recordBeat(
        propsRef.current.getSongTime(),
        project?.bpm ?? 120,
        { recordQuantize, snapBeats },
        propsRef.current.originBeat
      );
    };

    const floorNow = (): number => {
      const { recordQuantize, snapBeats } = editorStore.getState();
      return recordFloor({ recordQuantize, snapBeats });
    };

    /**
     * The lowest sub-lane no currently-held key is using.
     *
     * Lowest rather than next-highest, so a melody played one note at a time never
     * leaves lane 0 and the instrument stays one row tall. Only *held* keys are
     * counted, along with keys the pedal is holding: once a note stops its lane is
     * free again, because a block that has stopped is no longer in anything's way.
     */
    const freeLane = (): number => {
      const taken = new Set<number>();
      for (const key of [...held.values(), ...sustained.values()]) {
        if (key.take) taken.add(key.take.lane);
      }
      let lane = 0;
      while (taken.has(lane)) lane++;
      return lane;
    };

    /**
     * Write a block where it stands.
     *
     * Never its own history entry — a recording pass is one undo step from its
     * first note to the moment the transport stops, so Ctrl+Z scraps the take
     * rather than picking it apart a note at a time.
     */
    const commit = (take: OpenNote, duration: number) => {
      const segment = { ...take.segment, duration };
      take.segment = segment;
      propsRef.current.record(take.trackId, take.startBeat, segment);
    };

    /** Silence a note and write the length it reached. */
    const finish = (key: HeldKey) => {
      key.release();
      if (!key.take) return;
      const duration = Math.max(floorNow(), beatNow() - key.take.startBeat);
      commit(key.take, duration);
    };

    /** Let go of everything the pedal is holding. */
    const finishSustained = () => {
      const open = [...sustained.values()];
      sustained.clear();
      for (const key of open) finish(key);
    };

    const handleNoteOn = (event: MidiNoteEvent) => {
      // A key already down repeating is not a second press. Some controllers do
      // send a second note-on for a held key; starting a fresh voice for it would
      // leave the first one sounding with nothing left to stop it.
      if (held.has(event.note)) return;

      // Struck again under the pedal: the old note ends where the new one begins,
      // as a piano's would, rather than being orphaned beneath it.
      const ringing = sustained.get(event.note);
      if (ringing) {
        sustained.delete(event.note);
        finish(ringing);
      }

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

      // Shaped once, here, so what is heard and what is written are the same note.
      reportVelocity(event.velocity);
      const velocity = shapeVelocity(event.velocity, getMidiPrefs());
      const release = sustainPitch(pool?.get(trackId), event.note, velocity);

      let take: OpenNote | null = null;
      const { recordArmed } = editorStore.getState();
      if (recordArmed && isPlayingRef.current) {
        const lane = freeLane();
        take = {
          segment: {
            id: generateId(),
            kind: 'note',
            pitch: event.note,
            velocity,
            lane,
            // Grown by the note-off. Committed at the floor meanwhile, so the block
            // is visible during the very gesture that is filling it rather than
            // appearing only once the key comes up.
            duration: floorNow(),
          },
          startBeat: beatNow(),
          trackId,
          lane,
        };
        commit(take, take.segment.duration);
      }

      held.set(event.note, { release, take });
    };

    const handleNoteOff = (event: MidiNoteEvent) => {
      const key = held.get(event.note);
      if (!key) return;
      held.delete(event.note);

      if (pedalDown) {
        sustained.set(event.note, key);
        return;
      }
      finish(key);
    };

    const handlePedal = (down: boolean) => {
      pedalDown = down;
      if (!down) finishSustained();
    };

    const close = openMidiInputs({
      onEvent: event => {
        if (event.type === 'sustain') handlePedal(event.down);
        else if (event.type === 'noteOn') handleNoteOn(event);
        else handleNoteOff(event);
      },
      onStatus: setStatus,
    });

    /**
     * Losing the window loses the note-offs, so everything held is let go — and the
     * pedal-up may be lost with them, so the pedal is taken to be up.
     */
    const handleBlur = () => {
      pedalDown = false;
      const open = [...held.values(), ...sustained.values()];
      held.clear();
      sustained.clear();
      for (const key of open) finish(key);
    };
    window.addEventListener('blur', handleBlur);

    return () => {
      close();
      window.removeEventListener('blur', handleBlur);
      for (const key of [...held.values(), ...sustained.values()]) key.release();
      held.clear();
      sustained.clear();
      // Unmounting is not a musical event: silence what is held, but do not write a
      // block measured against a playhead that is going away.
    };
    // Once per mount, deliberately: see `propsRef` above.
  }, []);

  // Playback ending ends the take with it. Each block keeps the length it had
  // reached rather than being re-committed: Stop rewinds the playhead, so there is
  // no longer a position to measure a release against. The pedal itself is left as
  // it is: it is still physically down, and keys let go after Stop should ring.
  useEffect(() => {
    if (isPlaying) return;
    for (const key of [...heldRef.current.values(), ...sustainedRef.current.values()]) {
      key.release();
    }
    heldRef.current.clear();
    sustainedRef.current.clear();
  }, [isPlaying]);

  return status;
}
