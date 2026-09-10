import type {
  Bar,
  ChordQuality,
  ChordSegment,
  Note,
  NoteName,
  Scale,
  TimeSignature,
} from '@/types/music';
import { generateId } from '@/utils/id';
import type { SeventhColour, TriadColour } from '@/engine/chords';
import { MAX_CHORD_TONE } from '@/types/music';
import {
  CHORD_INTERVALS,
  getDiatonicChords,
  getDiatonicSevenths,
  composeQuality,
  degreeOfSegment,
  diatonicChordAt,
  segmentChordTones,
  segmentQuality,
  segmentQualitySize,
  segmentTones,
  seventhColourOf,
  triadColourOf,
  midiToNoteLabel,
  midiToOctave,
  SEMITONE_TO_NOTE,
} from '@/engine/chords';
import {
  degreeRegisterShift,
  getScalePitches,
  octaveForDegree,
  segmentScale,
} from '@/engine/scales';
import {
  accidentalLabel,
  degreeAlterationPitch,
  pitchDegree,
  pitchDegreeAlteration,
  type DegreeAlteration,
} from '@/engine/formulas';
import { breakChord, DEFAULT_VELOCITY, voicedPitches } from '@/engine/voicing';
import { getBarBeats, laneOf, MIN_SEGMENT_BEATS, withStartBeats } from '@/engine/timeline';
import { formatChordSymbol, nameSegment } from '@/engine/palette';
import {
  DEFAULT_TIME_SIGNATURE,
  MAX_SEGMENT_OCTAVE,
  MIN_SEGMENT_OCTAVE,
  NOTE_NAMES,
  PIANO_ROLL_MAX_MIDI,
  PIANO_ROLL_MIN_MIDI,
} from '@/utils/constants';

/**
 * Split a bar into equal-duration chord segments with diatonic chords.
 * Each chord gets a Roman numeral based on the given scale, and carries it.
 *
 * The scale is passed in rather than read off the bar: key belongs to a segment
 * now, so the bar contributes only its meter.
 *
 * @param bar - The bar to split, for its meter.
 * @param scale - The key to build the chords in.
 * @param chordCount - Number of chord segments to create.
 * @param projectTs - Project time signature, used when the bar has none.
 * @param baseOctave - Register of the scale's root note; degrees above it rise from
 *   there, exactly as the palette voices them.
 * @returns Array of ChordSegment objects.
 */
export function splitBarIntoChords(
  bar: Bar,
  scale: Scale,
  chordCount: number,
  projectTs: TimeSignature = DEFAULT_TIME_SIGNATURE,
  baseOctave: number = 4
): ChordSegment[] {
  if (chordCount < 1) {
    throw new Error('chordCount must be at least 1');
  }

  const barBeats = getBarBeats(bar, projectTs);
  const beatsPerChord = barBeats / chordCount;

  // The limit is what a segment can be, not how many beats the bar has: six chords
  // fit a 6/8 bar's three beats perfectly well, one per eighth.
  if (beatsPerChord < MIN_SEGMENT_BEATS) {
    throw new Error(
      `chordCount (${chordCount}) cannot exceed bar length (${barBeats} beats at ` +
        `${MIN_SEGMENT_BEATS} per chord)`
    );
  }
  const diatonicChords = getDiatonicChords(scale);
  const chords: ChordSegment[] = [];

  for (let i = 0; i < chordCount; i++) {
    const chordInfo = diatonicChords[i % diatonicChords.length];
    chords.push({
      id: generateId(),
      kind: 'chord',
      romanNumeral: chordInfo.romanNumeral,
      chordSymbol: formatChordSymbol(chordInfo.root, chordInfo.quality),
      duration: beatsPerChord,
      root: chordInfo.root,
      quality: chordInfo.quality,
      octave: octaveForDegree(scale, NOTE_NAMES.indexOf(chordInfo.root), baseOctave),
      scale,
    });
  }

  return chords;
}

/**
 * Reorder chords by moving a chord from one index to another.
 *
 * @param chords - The array of chord segments.
 * @param fromIndex - The source index.
 * @param toIndex - The destination index.
 * @returns A new array with the chord moved.
 */
export function reorderChords(
  chords: ChordSegment[],
  fromIndex: number,
  toIndex: number
): ChordSegment[] {
  if (fromIndex < 0 || fromIndex >= chords.length) {
    throw new Error(`fromIndex ${fromIndex} is out of bounds (0-${chords.length - 1})`);
  }
  if (toIndex < 0 || toIndex >= chords.length) {
    throw new Error(`toIndex ${toIndex} is out of bounds (0-${chords.length - 1})`);
  }

  if (fromIndex === toIndex) {
    return [...chords];
  }

  const result = [...chords];
  const [moved] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, moved);

  return result;
}

/**
 * Generates the piano-roll notes for one instrument in a bar from its segments.
 *
 * This is the sync engine behind the chord panel: a track's `notes` are derived
 * state, regenerated whenever segments change, so the piano roll always mirrors the
 * timeline. A chord segment expands to its stacked intervals, voiced in whatever
 * inversion it carries; a note segment yields a single pitch. Segments sit where
 * they were placed, so the gaps between them come out as silence with no further
 * work.
 *
 * Deliberately total — it never throws — because it runs on every edit, including
 * transient states like a bar whose last segment was just deleted.
 *
 * Takes the segments rather than reading them off the bar, because a bar holds one
 * list per instrument and this runs once per instrument. The bar is still needed
 * for the meter every instrument shares — but not for the key, which each segment
 * carries, so two blocks in one bar can be voiced in different scales.
 *
 * @param chords - The segments to voice, from one instrument's content.
 * @param bar - The bar they sit in, for its meter.
 * @param fallbackScale - Key for segments carrying none of their own.
 * @param projectTs - Project time signature, used when the bar has none.
 * @param octave - Fallback octave for chord segments that carry none of their own.
 * @returns The notes for this instrument in this bar, in segment order.
 */
/**
 * The velocity a segment's notes sound at.
 *
 * An absent one is the fixed 100 every note carried before recording could capture
 * a real one, which is what keeps every project written before then sounding
 * identical. A nonsensical value is treated as absent rather than passed on to a
 * sampler that would have to guess.
 */
export function segmentVelocity(segment: ChordSegment): number {
  const velocity = segment.velocity;
  if (velocity === undefined || !Number.isFinite(velocity)) return DEFAULT_VELOCITY;
  return Math.max(1, Math.min(127, Math.round(velocity)));
}

export function generateNotesFromSegments(
  chords: ChordSegment[],
  bar: Bar,
  fallbackScale: Scale,
  projectTs: TimeSignature,
  octave: number = 4
): Note[] {
  const notes: Note[] = [];
  const barBeats = getBarBeats(bar, projectTs);

  // A segment saved before free placement carries no position; packing it is what
  // its position used to mean.
  for (const segment of withStartBeats(chords)) {
    const currentBeat = segment.startBeat!;

    // A note may run past the bar line — the bar it belongs to is the one its onset
    // falls in, and its duration is simply written out from there. What cannot
    // happen is an onset outside the bar: refitting owns re-homing those, and
    // drawing one here as well would sound it twice.
    if (currentBeat >= barBeats) continue;

    // A single note carries its own pitch and needs no harmonic interpretation.
    if (segment.kind === 'note') {
      if (segment.pitch !== undefined) {
        notes.push({
          id: generateId(),
          pitch: segment.pitch,
          startBeat: currentBeat,
          duration: segment.duration,
          velocity: segmentVelocity(segment),
        });
      }
      continue;
    }

    // Only the root: which notes sit above it is `segmentChordTones` business now,
    // and it resolves the quality itself.
    const { rootSemitone } = resolveSegmentChord(
      segment,
      segmentScale(segment, fallbackScale)
    );
    // The segment's own register wins; the parameter is the fallback for
    // segments written before the palette could choose an octave.
    const baseMidi = ((segment.octave ?? octave) + 1) * 12 + rootSemitone;

    // A segment with no voicing comes back from these two as the same block
    // chord this loop used to build by hand.
    const pitches = voicedPitches(
      segmentChordTones(segment, segmentScale(segment, fallbackScale)),
      segment.inversion ?? 0,
      baseMidi,
      segment.voicing
    );

    for (const timed of breakChord(
      pitches,
      currentBeat,
      segment.duration,
      segment.voicing?.break,
      segmentVelocity(segment)
    )) {
      notes.push({ id: generateId(), ...timed });
    }
  }

  return notes;
}

/**
 * Resolves a chord segment's quality and root pitch class, falling back to the
 * given scale when the segment only carries a Roman numeral.
 *
 * Takes a `Scale` rather than the whole `Bar` because that is all it ever needed,
 * and because its callers do not all have a bar: the store's segment transforms
 * are handed the scale of whichever bar a segment lives in, and the inspector
 * panel resolves a chord to count its tones.
 */
export function resolveSegmentChord(
  segment: ChordSegment,
  scale: Scale
): { quality: ChordQualityKey; rootSemitone: number } {
  const match = segment.romanNumeral
    ? getDiatonicChords(scale).find(
        c =>
          c.romanNumeral.replace(/[°+]/g, '') ===
          segment.romanNumeral!.replace(/[°+]/g, '')
      )
    : undefined;

  const quality = (segment.quality ?? match?.quality ?? 'major') as ChordQualityKey;
  const rootNote = segment.root ?? match?.root;

  // Look the root up chromatically rather than within the scale, so borrowed and
  // chromatic chords land on their real root instead of silently falling back to C.
  const rootSemitone = rootNote ? Math.max(0, NOTE_NAMES.indexOf(rootNote)) : 0;

  return { quality, rootSemitone };
}

/** Local alias so the interval lookup stays exhaustive over known qualities. */
type ChordQualityKey = keyof typeof CHORD_INTERVALS;


/** Normalise a roman numeral for comparison — casing carries the quality, symbols don't. */
function bareNumeral(numeral: string): string {
  return numeral.replace(/[°+]/g, '');
}

/** Find which degree of a scale a roman numeral names, or -1. */
function degreeOfNumeral(scale: Scale, numeral: string): number {
  const target = bareNumeral(numeral);
  return getDiatonicChords(scale).findIndex(c => bareNumeral(c.romanNumeral) === target);
}

/**
 * Re-derives segments against a new scale, keeping each one on the scale degree it
 * was written on.
 *
 * Segments carry an explicit root and quality so that borrowed and chromatic chords
 * survive, but that means a diatonic segment would otherwise ignore a change of key.
 * A segment is treated as diatonic exactly when it carries a roman numeral: the
 * numeral names a degree, and this moves that degree into the new scale. Segments
 * without one are chromatic by construction and pass through untouched.
 *
 * @param segments - Segments belonging to the bar whose scale changed.
 * @param fromScale - The scale the segments were written against.
 * @param toScale - The scale they should now express.
 */
export function retuneSegmentsToScale(
  segments: ChordSegment[],
  fromScale: Scale,
  toScale: Scale
): ChordSegment[] {
  return segments.map(segment => {
    if (segment.kind === 'note') {
      return retuneNote(segment, fromScale, toScale);
    }

    if (!segment.romanNumeral) return segment;

    const degree = degreeOfNumeral(fromScale, segment.romanNumeral);
    if (degree === -1) return segment;

    // Keep the stack the user built: the tones are theirs, the scale only decides
    // which notes they land on. A shorter scale (pentatonic, blues) may simply not
    // have this degree.
    const chord = diatonicChordAt(toScale, degree, segmentQualitySize(segment));
    if (!chord) return segment;

    // A quality chosen by hand is the user's and survives the move; one the old key
    // spelled belongs to the key, and follows it into the new one.
    const quality = segment.qualityPinned ? (segment.quality ?? chord.quality) : chord.quality;

    const moved = {
      ...segment,
      root: chord.root,
      quality,
      // Dropped before naming: the numeral the block arrived with names a degree of
      // the key it is leaving, and `nameSegment` would otherwise believe it over the
      // root it has just been given.
      romanNumeral: undefined,
      octave: retunedOctave(segment, fromScale, toScale, chord.root),
    };
    // Named after the move, from the one namer, so the block's symbol and numeral
    // describe the stack it actually has in the key it has actually landed in.
    return { ...moved, ...nameSegment(moved, toScale) };
  });
}

/**
 * The register a retuned chord belongs in once its root has moved to a new key.
 *
 * A segment's octave is the register of the *tonic* plus whatever the ascending run
 * added, so a change of key has to strip the old scale's wrap before applying the
 * new one. Otherwise C major's vii° (B4) would arrive in D major still at register
 * 4 — C#4, a semitone under the D4 tonic — which is the jump this whole rule exists
 * to prevent.
 */
function retunedOctave(
  segment: ChordSegment,
  fromScale: Scale,
  toScale: Scale,
  newRoot: NoteName
): number {
  const oldRoot = segment.root;
  const wasWrapped = oldRoot ? degreeRegisterShift(fromScale, NOTE_NAMES.indexOf(oldRoot)) : 0;
  const base = (segment.octave ?? 4) - wasWrapped;
  const octave = octaveForDegree(toScale, NOTE_NAMES.indexOf(newRoot), base);
  return Math.min(Math.max(octave, MIN_SEGMENT_OCTAVE), MAX_SEGMENT_OCTAVE);
}

/** Move a single-note segment onto the same scale degree of the new scale. */
function retuneNote(
  segment: ChordSegment,
  fromScale: Scale,
  toScale: Scale
): ChordSegment {
  if (segment.pitch === undefined) return segment;

  const fromPitches = getScalePitches(fromScale.root, fromScale.type);
  const toPitches = getScalePitches(toScale.root, toScale.type);

  // The degree is looked up underneath the alteration: it is the degree that belongs
  // to the old key and has to be found in the new one, while the accidental on top of
  // it is the player's and rides along unchanged.
  const alter = noteDegreeAlteration(segment, fromScale).alter;
  const plain = segment.pitch - alter;

  const pitchClass = ((plain % 12) + 12) % 12;
  const degree = fromPitches.indexOf(pitchClass);
  if (degree === -1 || toPitches[degree] === undefined) return segment;

  // Shift by the shorter way round the circle so the note stays in its register
  // instead of leaping an octave when the pitch class wraps.
  let delta = ((toPitches[degree] - pitchClass) % 12 + 12) % 12;
  if (delta > 6) delta -= 12;

  const pitch = plain + delta + alter;
  return {
    ...segment,
    pitch,
    alter: alter || undefined,
    root: SEMITONE_TO_NOTE[((pitch % 12) + 12) % 12],
    // Relabelled with what it now sounds: a block that kept saying "C4" in the new
    // key would name a note that is no longer there.
    chordSymbol: midiToNoteLabel(pitch),
    octave: midiToOctave(pitch),
  };
}

/* ------------------------------------------------------------------------ */
/* Stack transforms                                                          */
/* ------------------------------------------------------------------------ */

/*
 * What the inspector's size stepper, tone toggles and colour buttons do to a block.
 *
 * They live here rather than in `voicing.ts` because they need `nameSegment`, and a
 * block's name is a function of the whole chord — its degree, its key, its colour and
 * its stack — rather than of the voicing alone.
 */

/** The widest stack the app builds, as a size rather than a tone index. */
export const MAX_STACK_SIZE = MAX_CHORD_TONE + 1;

/**
 * Re-derive everything that follows from a segment's stack, and rename it.
 *
 * The one path every stack edit goes through, so none of them can forget a step.
 * Three things follow from a change of tones:
 *
 * - the **quality**, which has to name a triad or a seventh according to how far the
 *   stack now reaches — unless it was pinned, in which case it is the user's and stays;
 * - the **inversion**, which counts sounded tones, and which `voiceChord` would
 *   silently read as a whole-chord octave shift rather than an error if it were left
 *   pointing past the end of a shrunken stack;
 * - the **name**, which now carries the size.
 */
function restack(segment: ChordSegment, scale: Scale, tones: number[]): ChordSegment {
  const size = tones.some(t => t >= 3) ? 4 : 3;
  const derived = diatonicChordAt(scale, degreeOfSegment(segment, scale), size)?.quality;
  const quality = segment.qualityPinned ? segment.quality : (derived ?? segment.quality);

  // Wrapped rather than clamped, matching how `withInversion` treats one: an
  // inversion past the chord's size means the same thing either way.
  const inversion =
    segment.inversion === undefined
      ? undefined
      : ((segment.inversion % tones.length) + tones.length) % tones.length;

  const next: ChordSegment = { ...segment, tones, quality, inversion };
  return { ...next, ...nameSegment(next, scale) };
}

/** True for a block that names a degree, and so has a stack to change. */
function isChordSegment(segment: ChordSegment): boolean {
  return segment.kind !== 'note';
}

/**
 * Set how many tones a block stacks: 1 a note, 2 a dyad, 3 a triad, 4 a seventh,
 * 5 a ninth.
 *
 * Writes the plain stack `[0 … size-1]`, discarding any gap the block had. That is
 * what the stepper means — "give me a seventh" — and the tone toggles are there for
 * anyone who wants the gap back.
 */
export function withStackSize(
  segment: ChordSegment,
  scale: Scale,
  size: number
): ChordSegment {
  if (!isChordSegment(segment)) return segment;

  const clamped = Math.min(MAX_STACK_SIZE, Math.max(1, Math.trunc(size)));
  return restack(segment, scale, Array.from({ length: clamped }, (_, i) => i));
}

/**
 * Switch one chord tone on or off.
 *
 * The root is refused: a register, an inversion and a captured formula are all
 * counted from it, so a chord without one is a voicing — a tone pushed aside by
 * `voicing.offsets` — rather than a stack.
 */
export function withToggledTone(
  segment: ChordSegment,
  scale: Scale,
  tone: number
): ChordSegment {
  if (!isChordSegment(segment)) return segment;
  if (!Number.isInteger(tone) || tone <= 0 || tone > MAX_CHORD_TONE) return segment;

  const tones = segmentTones(segment, scale);
  const next = tones.includes(tone) ? tones.filter(t => t !== tone) : [...tones, tone].sort((a, b) => a - b);

  return restack(segment, scale, next);
}

/**
 * Pin the triad this chord is coloured by, keeping whatever seventh it already has.
 *
 * Pinned, because the user said it: a change of key or a step to another degree keeps
 * a hand-set colour instead of re-deriving it. `withDiatonicQuality` is how it is
 * handed back to the key.
 */
export function withTriadColour(
  segment: ChordSegment,
  scale: Scale,
  triad: TriadColour
): ChordSegment {
  if (!isChordSegment(segment)) return segment;

  const current = segmentQuality(segment, scale);
  const quality = composeQuality(triad, seventhColourOf(current));
  const next: ChordSegment = { ...segment, quality, qualityPinned: true };

  return { ...next, ...nameSegment(next, scale) };
}

/**
 * Pin the colour of the seventh, keeping the triad beneath it.
 *
 * `undefined` hands the seventh back to the key without unpinning the triad, which is
 * what a chord wants when its colour was chosen but its extension was not.
 */
export function withSeventhColour(
  segment: ChordSegment,
  scale: Scale,
  seventh?: SeventhColour
): ChordSegment {
  if (!isChordSegment(segment)) return segment;

  const quality = composeQuality(triadColourOf(segmentQuality(segment, scale)), seventh);
  const next: ChordSegment = { ...segment, quality, qualityPinned: true };

  return { ...next, ...nameSegment(next, scale) };
}

/**
 * Hand the colour back to the key: unpin, and take the quality the scale spells.
 *
 * The way out of a pin, and the reason a pin can be a plain flag rather than something
 * inferred by comparing a quality against its degree.
 */
export function withDiatonicQuality(segment: ChordSegment, scale: Scale): ChordSegment {
  if (!isChordSegment(segment)) return segment;

  const size = segmentQualitySize(segment);
  const quality = diatonicChordAt(scale, degreeOfSegment(segment, scale), size)?.quality;
  if (!quality) return segment;

  const next: ChordSegment = { ...segment, quality, qualityPinned: undefined };
  return { ...next, ...nameSegment(next, scale) };
}

/* ------------------------------------------------------------------------ */
/* Segment kind conversion                                                  */
/* ------------------------------------------------------------------------ */

/** Target kind for conversion. */
export type SegmentKindTarget = 'note' | 'triad' | 'seventh';

/**
 * Inspect a segment and return its effective kind.
 *
 * A segment with `kind: 'note'` is a note. A chord segment is a triad when its
 * quality has three intervals and a seventh when it has four. A chord with no
 * quality is treated as a triad — the default chord size.
 */
export function currentKind(segment: ChordSegment): SegmentKindTarget {
  if (segment.kind === 'note') return 'note';
  if (!segment.quality) return 'triad';
  const intervals = CHORD_INTERVALS[segment.quality as ChordQualityKey];
  return intervals.length === 4 ? 'seventh' : 'triad';
}

/**
 * Converts a segment to a different kind, keeping its musical degree and scale
 * context.
 *
 * The conversion is reversible: converting a note to a triad and back recovers
 * the same degree. Duration, startBeat, and scale survive every path.
 */
export function convertSegmentKind(
  segment: ChordSegment,
  scale: Scale,
  target: SegmentKindTarget
): ChordSegment {
  const kind = currentKind(segment);
  if (kind === target) return segment; // no-op

  // Chord → note
  if (target === 'note') {
    return chordToNote(segment);
  }

  // Note → triad / seventh
  if (kind === 'note') {
    return noteToChord(segment, scale, target);
  }

  // Triad ↔ seventh
  return chordToChord(segment, scale, target);
}

/** Derive the diatonic chord at the note's scale degree. */
function noteToChord(
  segment: ChordSegment,
  scale: Scale,
  target: 'triad' | 'seventh'
): ChordSegment {
  if (segment.pitch === undefined) return segment;

  const pitchClass = ((segment.pitch % 12) + 12) % 12;
  const scalePitches = getScalePitches(scale.root, scale.type);
  const degree = scalePitches.indexOf(pitchClass);

  // Chromatic note: not in the scale, no diatonic chord to convert to.
  if (degree === -1) return segment;

  const chords = target === 'seventh' ? getDiatonicSevenths(scale) : getDiatonicChords(scale);
  const chord = chords[degree];

  if (!chord) return segment;

  const octave = octaveForDegree(scale, NOTE_NAMES.indexOf(chord.root), segment.octave ?? 4);

  return {
    ...segment,
    kind: 'chord',
    pitch: undefined,
    root: chord.root,
    quality: chord.quality,
    romanNumeral: chord.romanNumeral,
    chordSymbol: formatChordSymbol(chord.root, chord.quality),
    octave,
    // Discard voicing: a fresh chord starts in close position.
    voicing: undefined,
    inversion: undefined,
  };
}

/** Collapse a chord to its root as a single note. */
function chordToNote(segment: ChordSegment): ChordSegment {
  const root = segment.root;
  if (!root) return segment;

  const rootSemitone = NOTE_NAMES.indexOf(root);
  const octave = segment.octave ?? 4;
  const pitch = (octave + 1) * 12 + rootSemitone;

  return {
    ...segment,
    kind: 'note',
    pitch,
    quality: undefined,
    octave: undefined,
    chordSymbol: undefined,
    inversion: undefined,
    voicing: undefined,
  };
}

/** Change a triad to a seventh or vice versa at the same degree. */
function chordToChord(
  segment: ChordSegment,
  scale: Scale,
  target: 'triad' | 'seventh'
): ChordSegment {
  const chords = target === 'seventh' ? getDiatonicSevenths(scale) : getDiatonicChords(scale);

  // Find the segment's degree in the scale
  const degree = degreeOfChord(segment, scale);

  if (degree === -1) {
    // No roman numeral and root not in scale: try matching root directly
    const rootSemitone = segment.root ? NOTE_NAMES.indexOf(segment.root) : -1;
    if (rootSemitone === -1) return segment;
    const idx = chords.findIndex(c => NOTE_NAMES.indexOf(c.root) === rootSemitone);
    if (idx === -1) return segment;
    return buildNewChordSegment(segment, chords[idx], target);
  }

  const chord = chords[degree];
  if (!chord) return segment;

  return buildNewChordSegment(segment, chord, target);
}

/** Build the updated segment from a ChordInfo, clamping inversion to new size. */
function buildNewChordSegment(
  segment: ChordSegment,
  chord: { root: NoteName; quality: ChordQuality; romanNumeral: string },
  target: 'triad' | 'seventh'
): ChordSegment {
  const newSize = target === 'seventh' ? 4 : 3;
  const inversion = segment.inversion
    ? ((segment.inversion % newSize) + newSize) % newSize
    : undefined;

  return {
    ...segment,
    root: chord.root,
    quality: chord.quality,
    romanNumeral: chord.romanNumeral,
    chordSymbol: formatChordSymbol(chord.root, chord.quality),
    inversion,
  };
}


/**
 * Which degree of `scale` a chord segment sits on, or -1.
 *
 * The roman numeral is the authority — it is what the user wrote — but a segment
 * dropped without one still names a degree through its root, so fall back to that
 * before giving up and calling the chord chromatic.
 */
function degreeOfChord(segment: ChordSegment, scale: Scale): number {
  if (segment.romanNumeral) {
    const byNumeral = degreeOfNumeral(scale, segment.romanNumeral);
    if (byNumeral !== -1) return byNumeral;
  }
  if (!segment.root) return -1;
  return getScalePitches(scale.root, scale.type).indexOf(NOTE_NAMES.indexOf(segment.root));
}

/**
 * Moves a segment one step along the bar's scale — the meaning of the up and down
 * arrow keys.
 *
 * A note moves to the neighbouring pitch of the scale; a chord moves to the
 * neighbouring scale degree, keeping its size (a seventh stays a seventh) and its
 * inversion. Either way the result stays inside the scale, so stepping never
 * introduces a note the bar's key does not contain.
 *
 * A step that would leave the roll's range, or a chromatic chord that sits on no
 * degree at all, returns the segment unchanged rather than clamping — holding the
 * key down stops at the edge instead of piling up against it.
 *
 * @param segment - The segment to move.
 * @param scale - The scale of the bar the segment lives in.
 * @param direction - 1 for up, -1 for down.
 */
/**
 * Where a note sits in a scale: the degree it names, and how far off that degree.
 *
 * A note that states its own alteration is believed, because the pitch cannot say:
 * the raised seventh of D dorian and its tonic are both MIDI 60, and only the stamp
 * tells them apart. Subtracting the alteration lands on a note the scale contains, so
 * the degree underneath comes back exactly.
 *
 * A note carrying no alteration — one drawn by hand, recorded, or imported — is read
 * off its pitch, offset and all. That keeps a chromatic line a line when it is
 * transposed, rather than collapsing it onto the scale one arrow press at a time.
 */
function noteDegreeAlteration(segment: ChordSegment, scale: Scale): DegreeAlteration {
  const pitch = segment.pitch as number;
  const alter = segment.alter ?? 0;
  return alter === 0
    ? pitchDegreeAlteration(scale, pitch)
    : { degree: pitchDegree(scale, pitch - alter), alter };
}

/**
 * A note moved onto a degree, with every label that follows from it.
 *
 * The one place a note segment's pitch is written, so its name, its register and its
 * numeral cannot drift away from what it sounds. The timeline derives a note's label
 * from the live pitch and so never showed the drift, but the stored `chordSymbol` the
 * stepper left behind is what the inspector reads and what the file keeps.
 *
 * The numeral is found by degree rather than by pitch class: an altered note belongs
 * to no pitch class of the scale, and looking it up that way would leave it unnamed.
 */
function withNotePitch(
  segment: ChordSegment,
  scale: Scale,
  at: DegreeAlteration
): ChordSegment {
  const pitch = degreeAlterationPitch(scale, at);
  const length = getScalePitches(scale.root, scale.type).length;
  const index = ((at.degree % length) + length) % length;

  return {
    ...segment,
    pitch,
    alter: at.alter || undefined,
    chordSymbol: midiToNoteLabel(pitch),
    root: SEMITONE_TO_NOTE[((pitch % 12) + 12) % 12],
    octave: midiToOctave(pitch),
    romanNumeral:
      accidentalLabel(at.alter) + (getDiatonicChords(scale)[index]?.romanNumeral ?? ''),
  };
}

export function stepSegmentInScale(
  segment: ChordSegment,
  scale: Scale,
  direction: -1 | 1
): ChordSegment {
  if (segment.kind === 'note') {
    if (segment.pitch === undefined) return segment;

    // One degree along, carrying the alteration with it: a raised seventh steps to a
    // raised tonic, not to the plain note next door.
    const at = noteDegreeAlteration(segment, scale);
    const moved = { degree: at.degree + direction, alter: at.alter };
    const midi = degreeAlterationPitch(scale, moved);
    if (midi < PIANO_ROLL_MIN_MIDI || midi > PIANO_ROLL_MAX_MIDI) return segment;

    return withNotePitch(segment, scale, moved);
  }

  const degree = degreeOfChord(segment, scale);
  if (degree === -1) return segment;

  const size = segmentQualitySize(segment);
  const length = getScalePitches(scale.root, scale.type).length;
  const next = diatonicChordAt(scale, (degree + direction + length) % length, size);
  if (!next) return segment;

  const octave = (segment.octave ?? 4) + registerShift(segment.root, next.root, direction);
  if (octave < MIN_SEGMENT_OCTAVE || octave > MAX_SEGMENT_OCTAVE) return segment;

  // The pin travels with the block, exactly as it does through a change of key: a
  // borrowed colour is still borrowed one degree along.
  const quality = segment.qualityPinned ? (segment.quality ?? next.quality) : next.quality;

  // The old numeral names the degree it is stepping off, so it goes before naming —
  // the new root is what says where the block now is.
  const stepped = { ...segment, root: next.root, quality, romanNumeral: undefined, octave };
  return { ...stepped, ...nameSegment(stepped, scale) };
}

/**
 * Whether a step from one chord root to the next crosses the octave line, as -1,
 * 0 or 1.
 *
 * Wrapping the *degree index* is not enough to decide this. In C major, vii° (B)
 * to I (C) has to rise a register; but in A minor, VII (G) to i (A) must not —
 * A already sits a tone above G. What both cases share is that the root ascends
 * monotonically, so the register moves exactly when the pitch class crosses C.
 */
function registerShift(
  from: NoteName | undefined,
  to: NoteName,
  direction: -1 | 1
): number {
  if (!from) return 0;
  const fromSemitone = NOTE_NAMES.indexOf(from);
  const toSemitone = NOTE_NAMES.indexOf(to);
  if (direction === 1) return toSemitone <= fromSemitone ? 1 : 0;
  return toSemitone >= fromSemitone ? -1 : 0;
}

/**
 * Raises or flattens a block, keeping the degree it names.
 *
 * The sound moves, the degree does not: sharpening the seventh gives the leading tone
 * of the same scale, which is what an accidental means. On a note it is the pitch that
 * moves; on a chord it is the *root*, so flattening the sixth degree gives ♭VI — the
 * borrowed chord, still named as the sixth degree of the key it was borrowed into.
 *
 * A chord had no accidental until stacks arrived, because the palette offered a
 * separate Notes mode for writing one. That mode is gone — a degree-named block is a
 * chord at every size now — so this is the only way left to write a block the key does
 * not contain, short of recording one.
 *
 * @param segment - The segment to alter.
 * @param scale - The key the segment is written in.
 * @param alter - Semitones off the degree; 0 puts the block back on it.
 */
export function alterSegment(
  segment: ChordSegment,
  scale: Scale,
  alter: number
): ChordSegment {
  if (segment.kind === 'note') {
    if (segment.pitch === undefined) return segment;

    const at = { degree: noteDegreeAlteration(segment, scale).degree, alter };
    const pitch = degreeAlterationPitch(scale, at);
    if (pitch < PIANO_ROLL_MIN_MIDI || pitch > PIANO_ROLL_MAX_MIDI) return segment;

    return withNotePitch(segment, scale, at);
  }

  if (!segment.root) return segment;

  // The degree is looked for underneath whatever accidental the chord already
  // carries, exactly as a note's is: the degree belongs to the key, the accidental
  // on top of it is the writer's and is simply replaced.
  const rootSemitone = NOTE_NAMES.indexOf(segment.root);
  if (rootSemitone < 0) return segment;
  const plain = (((rootSemitone - (segment.alter ?? 0)) % 12) + 12) % 12;

  const degree = getScalePitches(scale.root, scale.type).indexOf(plain);
  // A chord already off the scale names no degree to bend, so there is nothing here
  // that would not be an invention.
  if (degree === -1) return segment;

  const root = SEMITONE_TO_NOTE[(((plain + alter) % 12) + 12) % 12];
  // Named against the *degree* rather than the altered root, which sits on no degree
  // at all — so the numeral has a base to wear its accidental on.
  const based: ChordSegment = {
    ...segment,
    root,
    alter: alter || undefined,
    romanNumeral: diatonicChordAt(scale, degree, segmentQualitySize(segment))?.romanNumeral,
  };
  const named = nameSegment(based, scale);

  return {
    ...based,
    chordSymbol: named.chordSymbol,
    romanNumeral: accidentalLabel(alter) + named.romanNumeral,
  };
}

/**
 * Moves a segment a whole octave — the meaning of the + and - keys.
 *
 * A note carries an absolute pitch, so it moves by 12 semitones and is bounded by
 * the roll; a chord carries a register, so it moves by one and is bounded by the
 * registers the palette offers. A shift past either bound is refused.
 *
 * @param segment - The segment to move.
 * @param direction - 1 for up, -1 for down.
 */
export function shiftSegmentOctave(segment: ChordSegment, direction: -1 | 1): ChordSegment {
  if (segment.kind === 'note') {
    if (segment.pitch === undefined) return segment;
    const pitch = segment.pitch + direction * 12;
    if (pitch < PIANO_ROLL_MIN_MIDI || pitch > PIANO_ROLL_MAX_MIDI) return segment;
    return { ...segment, pitch };
  }

  const octave = (segment.octave ?? 4) + direction;
  if (octave < MIN_SEGMENT_OCTAVE || octave > MAX_SEGMENT_OCTAVE) return segment;
  return { ...segment, octave };
}

/**
 * Advances a chord to its next inversion, wrapping back to root position — the
 * meaning of the `i` key.
 *
 * The cycle is as long as the chord has notes, so a triad returns to root position
 * on the third press and a seventh on the fourth. A note segment has no named
 * harmony to rotate and comes back untouched.
 */
export function cycleSegmentInversion(segment: ChordSegment): ChordSegment {
  if (segment.kind === 'note') return segment;
  if (!segment.quality) return segment;
  const size = CHORD_INTERVALS[segment.quality as ChordQualityKey].length;
  return { ...segment, inversion: ((segment.inversion ?? 0) + 1) % size };
}

/**
 * Merge adjacent chords with the same Roman numeral into a single chord.
 * Preserves the total duration and the first chord's metadata.
 *
 * Blocks in different sub-lanes never merge. They are stacked, not consecutive —
 * fusing them would turn a chord that sounds at one instant into a block twice as
 * long, and silence the other voice entirely.
 *
 * @param chords - The array of chord segments.
 * @returns A new array with merged adjacent chords.
 */
export function mergeAdjacentChords(chords: ChordSegment[]): ChordSegment[] {
  if (chords.length === 0) {
    return [];
  }

  const result: ChordSegment[] = [];
  let current = { ...chords[0] };

  for (let i = 1; i < chords.length; i++) {
    const mergeable = laneOf(chords[i]) === laneOf(current);
    if (mergeable && chords[i].romanNumeral === current.romanNumeral) {
      // Merge: extend duration
      current.duration += chords[i].duration;
      // Preserve chordSymbol if set
      if (chords[i].chordSymbol) {
        current.chordSymbol = chords[i].chordSymbol;
      }
    } else {
      result.push(current);
      current = { ...chords[i] };
    }
  }

  result.push(current);
  return result;
}

/**
 * Get the duration of a chord segment.
 *
 * @param chord - The chord segment.
 * @param beatsPerMeasure - The beats per measure (for context).
 * @returns The chord's duration in beats.
 */
export function getChordDuration(chord: ChordSegment): number {
  return chord.duration;
}
