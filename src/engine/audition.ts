import type { Bar, ChordSegment, Scale, TimeSignature } from '@/types/music';
import type { Instrument } from '@/engine/instrument';
import { generateNotesFromSegments } from '@/engine/chordOperations';
import { DEFAULT_VELOCITY } from '@/engine/voicing';

/** How long a preview lasts on a backend that cannot hold a note. Seconds. */
const FALLBACK_PREVIEW_SECONDS = 1.5;

/**
 * Velocity for a bare pitch with no block behind it — a MIDI key whose message
 * carried none, say. A previewed block sounds at its own velocity instead.
 */
const AUDITION_VELOCITY = DEFAULT_VELOCITY;

/**
 * A bar wide enough that nothing is ever skipped for starting past its capacity.
 * An audition has no bar of its own — it is a block held in the air.
 */
const AUDITION_BAR: Bar = { id: 'audition', barIndex: 0, content: {} };

/** One pitch of an audition, at the velocity its block sounds. */
export interface AuditionNote {
  pitch: number;
  velocity: number;
}

/**
 * What a segment sounds — pitches and velocity both, in one place.
 *
 * Routed through the same generator the timeline uses rather than resolving the
 * chord again here, so a previewed block is voiced exactly as the recorded one will
 * be — inversion, spacing, doublings and velocity included. An arpeggiated block
 * previews as a single stack: what is being auditioned is the harmony, not the
 * figuration.
 */
export function auditionNotes(
  segment: ChordSegment,
  scale: Scale,
  projectTs: TimeSignature
): AuditionNote[] {
  const flat: ChordSegment = {
    ...segment,
    startBeat: 0,
    voicing: segment.voicing ? { ...segment.voicing, break: undefined } : undefined,
  };
  return generateNotesFromSegments([flat], AUDITION_BAR, scale, projectTs).map(n => ({
    pitch: n.pitch,
    velocity: n.velocity,
  }));
}

/** The MIDI pitches a segment sounds, for callers that need no velocity. */
export function auditionPitches(
  segment: ChordSegment,
  scale: Scale,
  projectTs: TimeSignature
): number[] {
  return auditionNotes(segment, scale, projectTs).map(n => n.pitch);
}

/**
 * Sound one pitch for as long as the returned function goes uncalled — what a held
 * key does, whether it is a number key, a palette block or a MIDI keyboard.
 *
 * A backend with no `sustain` gets a fixed-length preview instead of a held one, and
 * its release is a no-op: better a note that outstays its key than one that never
 * stops, which is what cutting it would take (`stopAll` would silence playback too).
 * This is the one place that fallback lives, so a VST3 track behaves the same
 * wherever a note is played by hand.
 *
 * The returned release is safe to call more than once: a key-up and a window blur
 * can race, and smplr's stopper is not documented to be idempotent.
 */
export function sustainPitch(
  instrument: Instrument | undefined,
  midiNote: number,
  velocity: number = AUDITION_VELOCITY
): () => void {
  if (!instrument) return () => {};

  if (!instrument.sustain) {
    instrument.schedule({
      midiNote,
      velocity,
      when: instrument.now(),
      duration: FALLBACK_PREVIEW_SECONDS,
    });
    return () => {};
  }

  const stop = instrument.sustain({ midiNote, velocity });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    stop();
  };
}

/**
 * Sound a segment on an instrument for as long as the returned function goes
 * uncalled — what a held number key does.
 *
 * Each pitch sounds at the block's own velocity, so a preview is as loud as the
 * thing being previewed: an edit to a quiet block is heard quietly.
 */
export function auditionSegment(
  instrument: Instrument | undefined,
  segment: ChordSegment,
  scale: Scale,
  projectTs: TimeSignature
): () => void {
  if (!instrument) return () => {};

  const releases = auditionNotes(segment, scale, projectTs).map(note =>
    sustainPitch(instrument, note.pitch, note.velocity)
  );

  return () => {
    for (const release of releases) release();
  };
}

/**
 * Sound several segments at once, as one stack — what a multi-block selection is
 * when it is previewed rather than played.
 *
 * The releases are collapsed into one so a caller holding a single closure can stop
 * the whole preview, however many blocks went into it.
 */
export function auditionSegments(
  instrument: Instrument | undefined,
  segments: ChordSegment[],
  scaleOf: (segment: ChordSegment) => Scale,
  projectTs: TimeSignature
): () => void {
  if (!instrument) return () => {};

  const releases = segments.map(segment =>
    auditionSegment(instrument, segment, scaleOf(segment), projectTs)
  );

  return () => {
    for (const release of releases) release();
  };
}
