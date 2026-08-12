import type {
  Bar,
  ChordQuality,
  ChordSegment,
  Note,
  NoteName,
  Scale,
  SegmentNote,
  TimeSignature,
} from '@/types/music';
import { generateId } from '@/utils/id';
import type { DetectedChord } from '@/engine/chords';
import {
  CHORD_INTERVALS,
  detectChord,
  getDiatonicChords,
  getDiatonicSevenths,
  SEMITONE_TO_NOTE,
} from '@/engine/chords';
import {
  degreeRegisterShift,
  getScalePitches,
  octaveForDegree,
  segmentScale,
} from '@/engine/scales';
import { breakChord, DEFAULT_VELOCITY, voicedPitches } from '@/engine/voicing';
import { getBarBeats, MIN_SEGMENT_BEATS, withStartBeats } from '@/engine/timeline';
import { formatChordSymbol } from '@/engine/palette';
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
function segmentVelocity(segment: ChordSegment): number {
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

    // A custom block states its notes outright — there is nothing to voice, and
    // nothing to interpret. Onsets are relative to the block, so moving it moves
    // everything in it.
    if (segment.kind === 'custom') {
      for (const played of segment.customNotes ?? []) {
        notes.push({
          id: generateId(),
          pitch: played.pitch,
          startBeat: currentBeat + played.startBeat,
          duration: played.duration,
          velocity: played.velocity ?? segmentVelocity(segment),
        });
      }
      continue;
    }

    const { quality, rootSemitone } = resolveSegmentChord(
      segment,
      segmentScale(segment, fallbackScale)
    );
    // The segment's own register wins; the parameter is the fallback for
    // segments written before the palette could choose an octave.
    const baseMidi = ((segment.octave ?? octave) + 1) * 12 + rootSemitone;

    // A segment with no voicing comes back from these two as the same block
    // chord this loop used to build by hand.
    const pitches = voicedPitches(
      CHORD_INTERVALS[quality],
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

    // A recorded block names no degree — it is chromatic by construction — so a
    // change of key leaves it exactly as it was played.
    if (segment.kind === 'custom') return segment;

    if (!segment.romanNumeral) return segment;

    const degree = degreeOfNumeral(fromScale, segment.romanNumeral);
    if (degree === -1) return segment;

    // Keep a seventh a seventh: the note count is what the user chose, the scale
    // only decides which notes.
    const target = isSeventhChord(segment)
      ? getDiatonicSevenths(toScale)
      : getDiatonicChords(toScale);

    // A shorter scale (pentatonic, blues) may simply not have this degree.
    const chord = target[degree];
    if (!chord) return segment;

    return {
      ...segment,
      root: chord.root,
      quality: chord.quality,
      romanNumeral: chord.romanNumeral,
      chordSymbol: formatChordSymbol(chord.root, chord.quality),
      octave: retunedOctave(segment, fromScale, toScale, chord.root),
    };
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

  const pitchClass = ((segment.pitch % 12) + 12) % 12;
  const degree = fromPitches.indexOf(pitchClass);
  if (degree === -1 || toPitches[degree] === undefined) return segment;

  // Shift by the shorter way round the circle so the note stays in its register
  // instead of leaping an octave when the pitch class wraps.
  let delta = ((toPitches[degree] - pitchClass) % 12 + 12) % 12;
  if (delta > 6) delta -= 12;

  return {
    ...segment,
    pitch: segment.pitch + delta,
    root: SEMITONE_TO_NOTE[toPitches[degree]],
  };
}

/** True when a segment's quality has four notes, so a step must keep it a seventh. */
function isSeventhChord(segment: ChordSegment): boolean {
  return segment.quality
    ? CHORD_INTERVALS[segment.quality as ChordQualityKey].length === 4
    : false;
}

/* ------------------------------------------------------------------------ */
/* Segment kind conversion                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Target kind for conversion.
 *
 * `custom` is reported by `currentKind` but is never a target: a recorded block
 * holds pitches, not a degree, so there is nothing to convert *to* it from — and
 * converting away from one would throw away everything that was played.
 */
export type SegmentKindTarget = 'note' | 'triad' | 'seventh' | 'custom';

/**
 * Inspect a segment and return its effective kind.
 *
 * A segment with `kind: 'note'` is a note and one with `kind: 'custom'` is custom.
 * A chord segment is a triad when its quality has three intervals and a seventh
 * when it has four. A chord with no quality is treated as a triad — the default
 * chord size.
 */
export function currentKind(segment: ChordSegment): SegmentKindTarget {
  if (segment.kind === 'note') return 'note';
  if (segment.kind === 'custom') return 'custom';
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

  // A recorded block is neither a source nor a destination: it names no degree to
  // carry into a chord, and nothing it holds would survive the trip back.
  if (kind === 'custom' || target === 'custom') return segment;

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


/* ------------------------------------------------------------------------ */
/* Recorded blocks → named material                                          */
/* ------------------------------------------------------------------------ */

/**
 * What converting a recorded block would produce, or why it cannot be converted.
 *
 * A three-way answer rather than a nullable list because the UI has to explain a
 * refusal: `reason` is what the disabled button says.
 */
export type CustomConversion =
  | { kind: 'chord'; segments: ChordSegment[] }
  | { kind: 'notes'; segments: ChordSegment[] }
  | { kind: 'blocked'; reason: string };

/**
 * How far apart two onsets may be and still count as struck together.
 *
 * Recording quantises onsets by default, but a take captured with quantise off is
 * a few thousandths of a beat ragged — ten fingers never land at once — and a
 * chord played by hand must still read as a chord. A 32nd note is short enough
 * that nothing anyone would hear as two events falls inside it.
 */
const CHORD_ONSET_TOLERANCE = MIN_SEGMENT_BEATS;

/** Notes grouped by onset, each group struck together, in time order. */
function groupByOnset(notes: SegmentNote[]): SegmentNote[][] {
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
  const groups: SegmentNote[][] = [];

  for (const note of sorted) {
    const current = groups[groups.length - 1];
    // Measured against the group's *first* onset rather than the previous note's,
    // so a slow roll cannot chain one tolerance onto the next indefinitely.
    if (current && note.startBeat - current[0].startBeat <= CHORD_ONSET_TOLERANCE) {
      current.push(note);
    } else {
      groups.push([note]);
    }
  }

  return groups;
}

/**
 * Converts a recorded block into the named material it spells: one chord segment
 * when its notes were struck together and name a chord, or one note segment per
 * note when they were played one at a time.
 *
 * Deliberately lossy, and deliberately narrow. A chord comes back voiced in close
 * position in the register it sounded, not with the exact spacing ten fingers
 * produced — that is what makes it a *named* chord, transposable and invertible,
 * rather than the recording it started as. Anything that is neither one chord nor
 * one line — a cluster that names nothing, a chord with a melody over it — is
 * refused rather than mangled: two segments cannot share a beat in one lane, so
 * splitting such a block would ripple its notes apart and rewrite the timing that
 * was played.
 *
 * @param segment - The recorded block to read.
 * @param scale - The key to number the result's degrees in.
 */
export function convertCustomSegment(segment: ChordSegment, scale: Scale): CustomConversion {
  if (segment.kind !== 'custom') {
    return { kind: 'blocked', reason: 'Only a recorded block can be converted.' };
  }

  const played = segment.customNotes ?? [];
  if (played.length === 0) {
    return { kind: 'blocked', reason: 'This block holds no notes.' };
  }

  const groups = groupByOnset(played);
  const start = segment.startBeat ?? 0;

  // Struck together: one chord, if these pitches name one.
  if (groups.length === 1 && new Set(groups[0].map(n => n.pitch)).size > 1) {
    const detected = detectChord(groups[0].map(n => n.pitch));
    if (!detected) {
      return {
        kind: 'blocked',
        reason: "These notes don't spell a chord that can be named.",
      };
    }
    return { kind: 'chord', segments: [chordFromPlayed(segment, groups[0], detected, scale)] };
  }

  // One note at a time: a line, one segment per note.
  if (groups.every(group => new Set(group.map(n => n.pitch)).size === 1)) {
    return {
      kind: 'notes',
      segments: groups.map((group, index) => {
        const note = group[0];
        // Trimmed to the next onset so a legato take cannot hand two segments the
        // same beat — the one thing a lane cannot hold.
        const next = groups[index + 1]?.[0].startBeat;
        const duration =
          next === undefined
            ? note.duration
            : Math.max(MIN_SEGMENT_BEATS, Math.min(note.duration, next - note.startBeat));

        return noteFromPlayed(segment, note, start + note.startBeat, duration, scale, index === 0);
      }),
    };
  }

  return {
    kind: 'blocked',
    reason:
      "A block that mixes chords with single notes can't be converted — record one chord, " +
      'or one note at a time.',
  };
}

/** The named chord a struck group spells, in the register it sounded. */
function chordFromPlayed(
  segment: ChordSegment,
  group: SegmentNote[],
  detected: DetectedChord,
  scale: Scale
): ChordSegment {
  const velocities = group.map(n => n.velocity ?? segment.velocity ?? DEFAULT_VELOCITY);
  const diatonic = getDiatonicChords(scale)
    .concat(getDiatonicSevenths(scale))
    .find(c => c.root === detected.root && c.quality === detected.quality);

  return {
    ...segment,
    // The id survives so a selection, and anything else holding onto it, follows
    // the block through the conversion.
    id: segment.id,
    kind: 'chord',
    root: detected.root,
    quality: detected.quality,
    inversion: detected.inversion,
    octave: detected.octave,
    chordSymbol: formatChordSymbol(detected.root, detected.quality),
    // A chord the key does not contain names no degree, and labelling it with one
    // would be a lie — `retuneSegmentsToScale` reads the absence as chromatic.
    romanNumeral: diatonic?.romanNumeral,
    scale,
    velocity: Math.round(velocities.reduce((a, b) => a + b, 0) / velocities.length),
    customNotes: undefined,
    pitch: undefined,
    voicing: undefined,
  };
}

/** One played note as a note segment, named by the degree it lands on. */
function noteFromPlayed(
  segment: ChordSegment,
  note: SegmentNote,
  startBeat: number,
  duration: number,
  scale: Scale,
  keepId: boolean
): ChordSegment {
  const pitchClass = ((note.pitch % 12) + 12) % 12;
  const degree = getScalePitches(scale.root, scale.type).indexOf(pitchClass);

  return {
    ...segment,
    id: keepId ? segment.id : generateId(),
    kind: 'note',
    pitch: note.pitch,
    startBeat,
    duration,
    velocity: note.velocity ?? segment.velocity ?? DEFAULT_VELOCITY,
    root: SEMITONE_TO_NOTE[pitchClass],
    romanNumeral: degree === -1 ? undefined : getDiatonicChords(scale)[degree]?.romanNumeral,
    scale,
    customNotes: undefined,
    quality: undefined,
    octave: undefined,
    chordSymbol: undefined,
    inversion: undefined,
    voicing: undefined,
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
 * The next pitch in the given direction that lies on the scale.
 *
 * Walks semitone by semitone rather than by degree: that is what makes B4 step to
 * C5 across the octave line, and what snaps an off-scale pitch back on. Gives up
 * after an octave, which can only happen for an empty scale.
 *
 * @param pitchClasses - The scale's pitch classes, as `getScalePitches` returns them.
 */
function stepPitchInScale(pitch: number, pitchClasses: number[], direction: -1 | 1): number {
  let midi = pitch;
  for (let i = 0; i < 12; i++) {
    midi += direction;
    if (pitchClasses.includes(((midi % 12) + 12) % 12)) return midi;
  }
  return pitch;
}

export function stepSegmentInScale(
  segment: ChordSegment,
  scale: Scale,
  direction: -1 | 1
): ChordSegment {
  const pitches = getScalePitches(scale.root, scale.type);

  // A custom block moves as one gesture: the step its *lowest* note takes is
  // applied to every note, so the voicing that was played keeps its shape. Stepping
  // each note onto its own nearest scale tone would squash and spread the chord
  // differently on every press, which is not what the arrow keys mean.
  if (segment.kind === 'custom') {
    const played = segment.customNotes ?? [];
    if (played.length === 0) return segment;

    const lowest = Math.min(...played.map(n => n.pitch));
    const shift = stepPitchInScale(lowest, pitches, direction) - lowest;
    if (shift === 0) return segment;

    const shifted = played.map(n => ({ ...n, pitch: n.pitch + shift }));
    // All or nothing: a block that dropped one voice at the edge of the roll would
    // come back a different chord from the one that went in.
    if (shifted.some(n => n.pitch < PIANO_ROLL_MIN_MIDI || n.pitch > PIANO_ROLL_MAX_MIDI)) {
      return segment;
    }
    return { ...segment, customNotes: shifted };
  }

  if (segment.kind === 'note') {
    if (segment.pitch === undefined) return segment;

    // Walk semitone by semitone rather than by degree: that is what makes B4 step
    // to C5 across the octave line, and what snaps an off-scale pitch back on.
    const midi = stepPitchInScale(segment.pitch, pitches, direction);
    if (midi < PIANO_ROLL_MIN_MIDI || midi > PIANO_ROLL_MAX_MIDI) return segment;

    const degree = pitches.indexOf(((midi % 12) + 12) % 12);
    return {
      ...segment,
      pitch: midi,
      root: SEMITONE_TO_NOTE[((midi % 12) + 12) % 12],
      // The numeral names the degree the note now sits on; leaving the old one
      // would label a D as the tonic.
      romanNumeral: getDiatonicChords(scale)[degree]?.romanNumeral,
    };
  }

  const degree = degreeOfChord(segment, scale);
  if (degree === -1) return segment;

  const target = isSeventhChord(segment) ? getDiatonicSevenths(scale) : getDiatonicChords(scale);
  const next = target[(degree + direction + target.length) % target.length];
  if (!next) return segment;

  const octave = (segment.octave ?? 4) + registerShift(segment.root, next.root, direction);
  if (octave < MIN_SEGMENT_OCTAVE || octave > MAX_SEGMENT_OCTAVE) return segment;

  return {
    ...segment,
    root: next.root,
    quality: next.quality,
    romanNumeral: next.romanNumeral,
    chordSymbol: formatChordSymbol(next.root, next.quality),
    octave,
  };
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
  if (segment.kind === 'custom') {
    const played = segment.customNotes ?? [];
    if (played.length === 0) return segment;

    const shifted = played.map(n => ({ ...n, pitch: n.pitch + direction * 12 }));
    // Refused as a whole for the same reason as the scale step: a block that lost
    // one voice at the edge of the roll would not be the block that went in.
    if (shifted.some(n => n.pitch < PIANO_ROLL_MIN_MIDI || n.pitch > PIANO_ROLL_MAX_MIDI)) {
      return segment;
    }
    return { ...segment, customNotes: shifted };
  }

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
 * on the third press and a seventh on the fourth. Note and custom segments have no
 * named harmony to rotate and come back untouched.
 */
export function cycleSegmentInversion(segment: ChordSegment): ChordSegment {
  if (segment.kind === 'note' || segment.kind === 'custom') return segment;
  if (!segment.quality) return segment;
  const size = CHORD_INTERVALS[segment.quality as ChordQualityKey].length;
  return { ...segment, inversion: ((segment.inversion ?? 0) + 1) % size };
}

/**
 * Merge adjacent chords with the same Roman numeral into a single chord.
 * Preserves the total duration and the first chord's metadata.
 *
 * A custom block never merges, in either direction. The test is equality of roman
 * numeral, and a recorded block carries none — so two takes played one after the
 * other both read `undefined` and would silently fuse into a single block holding
 * only the first one's notes.
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
    const mergeable = chords[i].kind !== 'custom' && current.kind !== 'custom';
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
