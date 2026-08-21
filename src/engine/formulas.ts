import type { Bar, ChordSegment, Project, Scale } from '@/types/music';
import { getDiatonicChords, midiToNoteLabel, midiToOctave, SEMITONE_TO_NOTE } from '@/engine/chords';
import { degreeOffsetFromTonic, getScalePitches } from '@/engine/scales';
import { findSegment, getBarStartBeat } from '@/engine/timeline';

/** MIME type carrying a dragged formula across a drag. */
export const FORMULA_DRAG_TYPE = 'application/x-melodic-formula';

/**
 * One note of a formula.
 *
 * `degree` is a scale-degree offset from wherever the formula is started, not an
 * absolute degree: that is what lets the same arch be dropped on the tonic or on
 * the fifth and stay the same shape. It may run past the end of the scale — 7 is
 * the octave above in a heptatonic scale — or go negative for the step below.
 */
export interface FormulaStep {
  degree: number;
  /**
   * Semitones this note sits off its degree: 1 for a raised degree, -1 for a
   * flattened one. Absent means the degree as the scale spells it.
   *
   * A scale can only say so much — D dorian has no C# — and without this a phrase
   * built on a leading tone could not be written down at all, let alone captured
   * off the timeline. Held as semitones rather than as a spelling so it survives
   * being dropped in a scale whose steps fall differently.
   */
  alter?: number;
  /** Length of this note in beats. */
  beats: number;
  /**
   * Beats of silence after this note, before the next step starts. Absent means none.
   *
   * A phrase captured off the timeline usually has rests in it, and without somewhere
   * to put them the gap would have to be faked by lengthening the note before it —
   * which changes what the phrase sounds like.
   */
  gapBeats?: number;
}

/** A named melodic gesture: a shape in scale degrees plus its rhythm. */
export interface MelodicFormula {
  /** Stable across sessions — used as a React key, a test id and a drag payload id. */
  id: string;
  name: string;
  /** One line on what the shape is, shown under the name. */
  description?: string;
  steps: FormulaStep[];
}

/** A named family of formulas, e.g. the medieval neumes. */
export interface FormulaGroup {
  id: string;
  name: string;
  formulas: MelodicFormula[];
}

/** How long a formula runs, in beats — its rests included. */
export function formulaLengthBeats(formula: MelodicFormula): number {
  return formula.steps.reduce((total, step) => total + step.beats + (step.gapBeats ?? 0), 0);
}

/**
 * The MIDI pitch of a scale degree, counted from a scale voiced as an ascending
 * run starting at `baseOctave`.
 *
 * The same rule the palette's note blocks are built by (`getPaletteItems`), widened
 * to degrees outside a single octave: degree 7 of a heptatonic scale is the tonic an
 * octave up, degree -1 the note below it. Written in terms of the scale's own length
 * rather than a fixed 7, so the pentatonic and blues scales wrap after 5 and 6.
 *
 * @param scale - The scale the degree belongs to.
 * @param degree - Scale-degree index, unbounded in either direction.
 * @param baseOctave - Register of the scale's root note.
 */
export function degreePitch(scale: Scale, degree: number, baseOctave: number): number {
  const pitches = getScalePitches(scale.root, scale.type);
  const length = pitches.length;
  const octaveShift = Math.floor(degree / length);
  const index = ((degree % length) + length) % length;
  const midi =
    (baseOctave + 1) * 12 +
    pitches[0] +
    degreeOffsetFromTonic(scale, pitches[index]) +
    12 * octaveShift;
  // A shape started high enough can walk off the top of MIDI; clamping keeps the
  // block on the piano roll rather than producing a pitch nothing can sound.
  return Math.min(127, Math.max(0, midi));
}

/** Accidental signs for the alterations a step may name, indexed by semitone offset. */
const ACCIDENTAL_SIGNS: Record<number, string> = {
  [-2]: '𝄫',
  [-1]: '♭',
  0: '',
  1: '♯',
  2: '𝄪',
};

/**
 * How an alteration reads: '♯' for a raised degree, '' for an unaltered one.
 *
 * The one place the signs are written down, so the chip, the editor and the roman
 * numeral on a dropped block all name the same thing the same way. An offset no
 * accidental covers falls back to the signed number rather than going silent.
 */
export function accidentalLabel(alter: number): string {
  return ACCIDENTAL_SIGNS[alter] ?? (alter > 0 ? `+${alter}` : String(alter));
}

/** One realized note of a formula: the segment, and where it sits within the phrase. */
export interface RealizedStep {
  /** Ready to be given an id and a position — the shape `CopiedSegment` carries. */
  segment: Omit<ChordSegment, 'id' | 'startBeat'>;
  /** Beats from the start of the phrase. */
  offsetBeats: number;
}

/**
 * Turns a formula into the note segments it stands for.
 *
 * Each block is stamped with the key it was realized in, exactly as a palette block
 * is (`paletteItemToSegment`), so the phrase keeps naming the same degrees wherever
 * it is dropped and the palette can move on without disturbing it.
 *
 * Positions are returned as offsets rather than absolute beats: only the caller knows
 * where the drop landed, and only it can resolve an offset into a bar.
 *
 * @param formula - The formula to realize.
 * @param scale - The key to realize it in.
 * @param baseOctave - Register of that scale's root note.
 * @param startDegree - Scale degree the formula's own degree 0 is placed on.
 */
export function realizeFormula(
  formula: MelodicFormula,
  scale: Scale,
  baseOctave: number,
  startDegree: number
): RealizedStep[] {
  const pitches = getScalePitches(scale.root, scale.type);
  const numerals = getDiatonicChords(scale);
  let offsetBeats = 0;

  return formula.steps.map(step => {
    const degree = startDegree + step.degree;
    const alter = step.alter ?? 0;
    // Clamped again after the alteration: a shape sitting at the very top of the
    // range must not be pushed off the piano roll by a sharp.
    const pitch = Math.min(127, Math.max(0, degreePitch(scale, degree, baseOctave) + alter));
    const index = ((degree % pitches.length) + pitches.length) % pitches.length;
    const realized: RealizedStep = {
      segment: {
        kind: 'note',
        pitch,
        // Carried onto the block itself, not just used to place it: once the phrase
        // is on the timeline this is the only record that the note is a raised
        // degree rather than the plain degree above it.
        alter: alter || undefined,
        // Named with its register, like the palette's note blocks.
        chordSymbol: midiToNoteLabel(pitch),
        // An altered note is not the plain degree, and a block that claimed to be
        // would be lying about what it sounds.
        romanNumeral: accidentalLabel(alter) + numerals[index].romanNumeral,
        root: SEMITONE_TO_NOTE[pitch % 12],
        octave: midiToOctave(pitch),
        duration: step.beats,
        scale,
      },
      offsetBeats,
    };
    offsetBeats += step.beats + (step.gapBeats ?? 0);
    return realized;
  });
}

// ---------------------------------------------------------------------------
// Reading a formula back off the timeline
// ---------------------------------------------------------------------------

/**
 * How far either side of the tonic a captured pitch is looked for, and the register
 * the search counts from.
 *
 * Ten octaves of a seven-note scale reaches well past both ends of MIDI, and starting
 * from the middle means the whole range is in reach without the clamping at either
 * end mattering.
 */
const DEGREE_SEARCH_RANGE = 70;
const DEGREE_SEARCH_OCTAVE = 4;

/** A pitch located against a scale: the degree it stands on, and how far off it sits. */
export interface DegreeAlteration {
  degree: number;
  /** Semitones from that degree to the pitch — 0 for a note the scale contains. */
  alter: number;
}

/**
 * Where a MIDI pitch sits in a scale: the nearest degree, and its alteration.
 *
 * The inverse of `degreePitch`, and deliberately *defined* by it rather than by a
 * second copy of the interval arithmetic: the two have to agree exactly or a phrase
 * would not survive being captured and dropped again, and defining one in terms of
 * the other is the only way to guarantee that for free.
 *
 * A chromatic pitch — one the scale does not contain — belongs to no degree, so it is
 * reported as the nearest degree plus the semitones it lies off it. A pitch sitting
 * squarely between two degrees is spelled as the lower one raised rather than the
 * upper one flattened, which is what a leading tone means: the loop runs upward and
 * only a strictly closer candidate displaces the one it already has.
 */
export function pitchDegreeAlteration(scale: Scale, pitch: number): DegreeAlteration {
  let best = 0;
  let bestDistance = Infinity;
  let previous: number | null = null;

  for (let degree = -DEGREE_SEARCH_RANGE; degree <= DEGREE_SEARCH_RANGE; degree++) {
    const candidate = degreePitch(scale, degree, DEGREE_SEARCH_OCTAVE);
    // Past either end of MIDI `degreePitch` clamps, so dozens of degrees answer with
    // the same pitch. Taking only the first of a run keeps one degree per pitch and
    // stops a capture at the bottom of the keyboard reporting degree -70.
    if (candidate === previous) continue;
    previous = candidate;

    const distance = Math.abs(candidate - pitch);
    if (distance === 0) return { degree, alter: 0 };
    if (distance < bestDistance) {
      bestDistance = distance;
      best = degree;
    }
  }
  return { degree: best, alter: pitch - degreePitch(scale, best, DEGREE_SEARCH_OCTAVE) };
}

/**
 * The scale degree a MIDI pitch stands on, or the nearest one when it is chromatic.
 *
 * The half of {@link pitchDegreeAlteration} that most callers want on its own.
 */
export function pitchDegree(scale: Scale, pitch: number): number {
  return pitchDegreeAlteration(scale, pitch).degree;
}

/**
 * The pitch a degree and its alteration name.
 *
 * The exact inverse of {@link pitchDegreeAlteration}, and the reason both live here:
 * degrees only mean anything against the register they are counted from, and a caller
 * that had to pass that octave in could pass a different one to each half.
 */
export function degreeAlterationPitch(scale: Scale, at: DegreeAlteration): number {
  return degreePitch(scale, at.degree, DEGREE_SEARCH_OCTAVE) + at.alter;
}

/** What a capture produced, and what it had to leave behind. */
export interface CapturedFormula {
  formula: MelodicFormula;
  /** Selected blocks that named no single pitch — chords — and so were skipped. */
  skipped: number;
}

/**
 * Read a formula back out of segments already on the timeline.
 *
 * The shape is taken relative to the first note, so a phrase captured in one register
 * drops in another unchanged — which is the same relativity `realizeFormula` reads it
 * with, and what makes capture and drop inverses of each other.
 *
 * @param project - The project the segments live in.
 * @param segmentIds - Ids of the selected segments, in any order.
 * @param fallbackScale - Key to read the degrees in when the blocks state none.
 * @param name - What to call the captured formula.
 * @param id - Id for it, from the library it is going into.
 * @returns The formula and the count of blocks skipped, or null if nothing was usable.
 */
export function captureFormula(
  project: Project,
  /**
   * The bars those ids name — the open phrase's, not the compiled song's. Passed in
   * rather than read off `project` so this stays a pure function of what it is given.
   */
  bars: Bar[],
  segmentIds: string[],
  fallbackScale: Scale,
  name: string,
  id: string
): CapturedFormula | null {
  const found = segmentIds
    .map(segmentId => findSegment(bars, segmentId))
    .filter((loc): loc is NonNullable<typeof loc> => loc !== null)
    .map(loc => ({
      segment: loc.segment,
      // One absolute axis, so blocks selected across a bar line stay in order and
      // the rest between them can be measured.
      beat:
        getBarStartBeat(bars, loc.bar.barIndex, project.timeSignature) +
        (loc.segment.startBeat ?? 0),
    }))
    .sort((a, b) => a.beat - b.beat);

  // A chord names no single degree, so there is nothing to write down for it. It is
  // counted rather than silently dropped: the user selected it, and should be told.
  const notes = found.filter(
    entry => entry.segment.kind === 'note' && typeof entry.segment.pitch === 'number'
  );
  if (notes.length === 0) return null;

  // The key the phrase was written in, which is the key its own blocks were stamped
  // with when they were dropped.
  const scale = notes[0].segment.scale ?? fallbackScale;

  /**
   * Where a block sits in the scale.
   *
   * A block that states its own alteration is believed over the pitch, which cannot
   * tell a raised degree from the one above it: the C the phrase means as a sharpened
   * B would otherwise be captured as a plain C and the shape would shift.
   */
  const locate = (segment: ChordSegment): DegreeAlteration => {
    const alter = segment.alter ?? 0;
    const pitch = segment.pitch as number;
    return alter === 0
      ? pitchDegreeAlteration(scale, pitch)
      : { degree: pitchDegree(scale, pitch - alter), alter };
  };

  const base = locate(notes[0].segment);

  const steps: FormulaStep[] = notes.map((entry, i) => {
    const at = locate(entry.segment);
    const beats = entry.segment.duration;
    const next = notes[i + 1];
    // Silence between this block's end and the next one's start. Rounded away from
    // the floating-point dust that beat arithmetic leaves, and never negative:
    // overlapping blocks (they can sit in different lanes) mean no rest at all.
    const gap = next ? Math.round((next.beat - (entry.beat + beats)) * 1000) / 1000 : 0;
    return {
      // Only the degree is taken relative to the first note. An alteration is an
      // absolute offset from whatever degree it lands on, so a phrase whose first
      // note is itself raised stays raised wherever it is dropped.
      degree: at.degree - base.degree,
      alter: at.alter || undefined,
      beats,
      gapBeats: gap > 0 ? gap : undefined,
    };
  });

  return {
    formula: { id, name, steps },
    skipped: found.length - notes.length,
  };
}
