import type { Bar, ChordSegment, Scale, TimeSignature } from '@/types/music';
import type { Instrument } from '@/engine/instrument';
import { generateNotesFromSegments } from '@/engine/chordOperations';

/** How long a preview lasts on a backend that cannot hold a note. Seconds. */
const FALLBACK_PREVIEW_SECONDS = 1.5;

/** Velocity for a previewed block, matching the one generated notes carry. */
const AUDITION_VELOCITY = 100;

/**
 * A bar wide enough that nothing is ever skipped for starting past its capacity.
 * An audition has no bar of its own — it is a block held in the air.
 */
const AUDITION_BAR: Bar = { id: 'audition', barIndex: 0, content: {} };

/**
 * The MIDI pitches a segment sounds, in one place.
 *
 * Routed through the same generator the timeline uses rather than resolving the
 * chord again here, so a previewed block is voiced exactly as the recorded one will
 * be — inversion, spacing and doublings included. An arpeggiated block previews as
 * a single stack: what is being auditioned is the harmony, not the figuration.
 */
export function auditionPitches(
  segment: ChordSegment,
  scale: Scale,
  projectTs: TimeSignature
): number[] {
  const flat: ChordSegment = {
    ...segment,
    startBeat: 0,
    voicing: segment.voicing ? { ...segment.voicing, break: undefined } : undefined,
  };
  return generateNotesFromSegments([flat], AUDITION_BAR, scale, projectTs).map(n => n.pitch);
}

/**
 * Sound a segment on an instrument for as long as the returned function goes
 * uncalled — what a held number key does.
 *
 * A backend with no `sustain` gets a fixed-length preview instead of a held one, and
 * its release is a no-op: better a note that outstays its key than one that never
 * stops, which is what cutting it would take (`stopAll` would silence playback too).
 */
export function auditionSegment(
  instrument: Instrument | undefined,
  segment: ChordSegment,
  scale: Scale,
  projectTs: TimeSignature
): () => void {
  if (!instrument) return () => {};

  const pitches = auditionPitches(segment, scale, projectTs);

  if (!instrument.sustain) {
    const when = instrument.now();
    for (const midiNote of pitches) {
      instrument.schedule({
        midiNote,
        velocity: AUDITION_VELOCITY,
        when,
        duration: FALLBACK_PREVIEW_SECONDS,
      });
    }
    return () => {};
  }

  const stoppers = pitches.map(midiNote =>
    instrument.sustain!({ midiNote, velocity: AUDITION_VELOCITY })
  );

  // Guarded because a release can arrive twice — a keyup and a window blur racing —
  // and smplr's stopper is not documented to be idempotent.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const stop of stoppers) stop();
  };
}
