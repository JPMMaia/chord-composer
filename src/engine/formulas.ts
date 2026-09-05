import type {
  Bar,
  ChordQuality,
  ChordSegment,
  Project,
  Scale,
  ScaleType,
  SegmentKind,
  SegmentVoicing,
} from '@/types/music';
import {
  CHORD_INTERVALS,
  getDiatonicChords,
  midiToNoteLabel,
  midiToOctave,
  SEMITONE_TO_NOTE,
} from '@/engine/chords';
import {
  degreeOffsetFromTonic,
  getScalePitches,
  rootSemitone,
  segmentScale,
} from '@/engine/scales';
import { formatChordSymbol, seventhNumeral } from '@/engine/palette';
import { findSegment, getBarStartBeat } from '@/engine/timeline';
import { MAX_SEGMENT_OCTAVE, MIN_SEGMENT_OCTAVE } from '@/utils/constants';

/** MIME type carrying a dragged formula across a drag. */
export const FORMULA_DRAG_TYPE = 'application/x-melodic-formula';

/**
 * A step's own key, named relative to the formula's home scale.
 *
 * Relative rather than absolute for the same reason `degree` is: a formula is a
 * gesture, not a tune. A shape captured as C major moving to D natural minor is "the
 * home key, then the natural minor a whole step above it", and dropped on G major it
 * should be G major then A natural minor — not the D minor it happened to be written
 * in. An absolute key would pin half the formula to the register and key it came from
 * and leave the other half free, which is neither of the two things a user might want.
 */
export interface FormulaScaleRef {
  /** Semitones from the home scale's root to this one's, 0-11. */
  rootOffset: number;
  type: ScaleType;
}

/**
 * One block of a formula: a note, or a chord.
 *
 * `degree` is a scale-degree offset from wherever the formula is started, not an
 * absolute degree: that is what lets the same arch be dropped on the tonic or on
 * the fifth and stay the same shape. It may run past the end of the scale — 7 is
 * the octave above in a heptatonic scale — or go negative for the step below.
 *
 * The degree is counted in the step's *own* scale (see `scale` below), from the pitch
 * the formula is anchored on. For a step in the home key that is exactly the offset it
 * has always been, so nothing written before scales could vary reads differently now.
 */
export interface FormulaStep {
  /**
   * What this step stands for. Absent reads as 'note', which is every step of every
   * formula written before a formula could name a chord.
   */
  kind?: SegmentKind;
  degree: number;
  /**
   * Semitones this note sits off its degree: 1 for a raised degree, -1 for a
   * flattened one. Absent means the degree as the scale spells it.
   *
   * A scale can only say so much — D dorian has no C# — and without this a phrase
   * built on a leading tone could not be written down at all, let alone captured
   * off the timeline. Held as semitones rather than as a spelling so it survives
   * being dropped in a scale whose steps fall differently.
   *
   * Means the same thing for a chord, where it is the *root* that sits off the degree:
   * a ♭VI is the sixth degree flattened, and needs no second way of being written.
   */
  alter?: number;
  /**
   * The key this step is written in. Absent means the formula's home scale, which is
   * every step of every formula written before one could modulate.
   *
   * Key belongs to the block in this app, not to the bar, so a selection can span two
   * of them — and until this existed a capture flattened them all onto the first
   * block's key, which quietly changed what the phrase sounded like.
   */
  scale?: FormulaScaleRef;
  /**
   * Chord steps only: what the chord is. Absent means the quality this step's scale
   * spells for its degree, so a diatonic progression becomes the new key's own chords
   * when it is dropped there — the same "omitted when the context already says it"
   * rule `alter` follows for a note.
   *
   * A seventh is never a diatonic *triad*, so it is always written down and always
   * stays a seventh. That is the right answer for a V7 or a secondary dominant, which
   * are the reason anyone reaches for one.
   */
  quality?: ChordQuality;
  /** Chord steps only. Absent is root position. */
  inversion?: number;
  /**
   * Chord steps only: spacing, per-tone octave offsets, doublings, arpeggio or strum.
   *
   * Carried verbatim in both directions. None of it depends on the key — `offsets` is
   * indexed by chord tone rather than by sounding position — so a captured drop-2
   * seventh comes back a drop-2 seventh in any key it is dropped in.
   */
  voicing?: SegmentVoicing;
  /**
   * MIDI velocity for the block this step becomes. Absent leaves it unmarked, which is
   * how every block a formula produced before this sounded.
   */
  velocity?: number;
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
  /**
   * The mode the formula is written in. Absent means "whichever the palette is set
   * to", which is how every formula behaved before this existed.
   *
   * Only the *mode* is held, never a root: the root is what the palette chooses, and
   * that is what still lets one gesture be dropped in any key.
   *
   * A shape in bare degrees means the same thing in any mode — degree 2 is the third
   * of wherever you are — so a plain melodic run leaves this empty and goes on
   * retuning itself to the palette, which is most of the use of a formula. A formula
   * that names a *chord* or a second key cannot: 'the triad on degree 0' is C minor
   * in one mode and C major in another, and a progression captured as i-♭VI-IV would
   * come back as I-vi-IV with nothing to say it had changed. Those pin their mode, so
   * what was captured is what is dropped.
   */
  homeType?: ScaleType;
  steps: FormulaStep[];
}

/**
 * Whether a formula's mode is part of what it says.
 *
 * A chord takes its quality from the mode, and a second key is placed relative to it,
 * so both are read differently in a mode the formula did not mean. Bare degrees are
 * not: they name the same steps of whatever scale they land in.
 */
export function formulaNeedsHomeType(steps: FormulaStep[]): boolean {
  return steps.some(step => step.kind === 'chord' || step.scale !== undefined);
}

/**
 * The key a formula is realized in: the palette's root, in the formula's own mode
 * when it has one.
 *
 * The one place the two are combined, so the strip's chip and the block that lands on
 * the timeline never disagree about what a formula is about to sound like.
 */
export function formulaHomeScale(formula: MelodicFormula, palette: Scale): Scale {
  return formula.homeType ? { root: palette.root, type: formula.homeType } : palette;
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

/**
 * How far either side of the tonic a pitch is looked for, and the register the search
 * counts from.
 *
 * Ten octaves of a seven-note scale reaches well past both ends of MIDI, and starting
 * from the middle means the whole range is in reach without the clamping at either
 * end mattering.
 *
 * Everything degree-shaped in this file is counted in this one frame — capture and
 * realization alike — so that a step in a scale the formula does not otherwise share
 * still lands where the anchor says it should.
 */
const DEGREE_SEARCH_RANGE = 70;
const DEGREE_SEARCH_OCTAVE = 4;

/**
 * The scale a step is written in: its reference resolved against the home key.
 *
 * A step with no reference is in the home key, which is every step of every formula
 * written before one could modulate.
 */
export function resolveScaleRef(home: Scale, ref?: FormulaScaleRef): Scale {
  if (!ref) return home;
  return {
    root: SEMITONE_TO_NOTE[(rootSemitone(home.root) + ref.rootOffset) % 12],
    type: ref.type,
  };
}

/**
 * How a scale is named relative to a home key, or undefined when it *is* the home key.
 *
 * The inverse of {@link resolveScaleRef}. Undefined rather than a zero offset so a
 * capture in a single key writes no new field at all, and a library holding no
 * modulating formula serialises to exactly the text it did before this existed.
 */
export function scaleRefFrom(home: Scale, scale: Scale): FormulaScaleRef | undefined {
  const rootOffset = (((rootSemitone(scale.root) - rootSemitone(home.root)) % 12) + 12) % 12;
  if (rootOffset === 0 && scale.type === home.type) return undefined;
  return { rootOffset, type: scale.type };
}

/**
 * The pitch a block hangs from: a note's own, or a chord's root.
 *
 * The one place the two kinds are put on one axis. A chord segment states its root's
 * register in `octave` — that is what `octaveForDegree` gives a palette block — so the
 * root has a MIDI pitch like any note, and the degree arithmetic below needs no second
 * path for chords. Null for a block that names neither, which cannot be captured.
 */
export function segmentAnchorPitch(segment: ChordSegment): number | null {
  if (segment.kind === 'note') {
    return typeof segment.pitch === 'number' ? segment.pitch : null;
  }
  if (!segment.root) return null;
  return ((segment.octave ?? 4) + 1) * 12 + rootSemitone(segment.root);
}

/** Keeps a pitch on the piano roll rather than producing one nothing can sound. */
function clampMidi(pitch: number): number {
  return Math.min(127, Math.max(0, pitch));
}

/** The quality the scale spells for a degree — what an omitted `quality` means. */
function diatonicChordAt(scale: Scale, degree: number) {
  const chords = getDiatonicChords(scale);
  return chords[((degree % chords.length) + chords.length) % chords.length];
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
 * Turns a formula into the segments it stands for.
 *
 * Each block is stamped with the key it was realized in, exactly as a palette block
 * is (`paletteItemToSegment`), so the phrase keeps naming the same degrees wherever
 * it is dropped and the palette can move on without disturbing it. A step naming its
 * own scale is stamped with *that* one, so the block records the key it actually
 * means and a second capture reads back what the first one wrote.
 *
 * Positions are returned as offsets rather than absolute beats: only the caller knows
 * where the drop landed, and only it can resolve an offset into a bar.
 *
 * @param formula - The formula to realize.
 * @param palette - The key to realize it in. Its root is always used; its mode only
 *   when the formula names none of its own — see {@link formulaHomeScale}.
 * @param baseOctave - Register of that scale's root note.
 * @param startDegree - Scale degree the formula's own degree 0 is placed on.
 */
export function realizeFormula(
  formula: MelodicFormula,
  palette: Scale,
  baseOctave: number,
  startDegree: number
): RealizedStep[] {
  const scale = formulaHomeScale(formula, palette);
  // The pitch the whole shape hangs from. Steps are then placed by counting degrees
  // from here in their *own* scale, which is what lets one formula hold several: a
  // scale the formula does not otherwise share still has to agree about this pitch.
  //
  // For a formula written entirely in the home key this is exactly the arithmetic
  // that was here before — `pitchDegree` gives `startDegree` back — so nothing
  // written before a formula could modulate realizes differently now.
  const anchorPitch = degreePitch(scale, startDegree, baseOctave);
  let offsetBeats = 0;

  return formula.steps.map(step => {
    const stepScale = resolveScaleRef(scale, step.scale);
    const alter = step.alter ?? 0;
    const degree = pitchDegree(stepScale, anchorPitch) + step.degree;
    // Clamped after the alteration: a shape sitting at the very top of the range
    // must not be pushed off the piano roll by a sharp.
    const pitch = clampMidi(degreePitch(stepScale, degree, DEGREE_SEARCH_OCTAVE) + alter);

    const realized: RealizedStep = {
      segment:
        step.kind === 'chord'
          ? chordFromStep(step, stepScale, degree, pitch, alter)
          : noteFromStep(step, stepScale, degree, pitch, alter),
      offsetBeats,
    };
    offsetBeats += step.beats + (step.gapBeats ?? 0);
    return realized;
  });
}

/** One note step, named with its register like the palette's note blocks. */
function noteFromStep(
  step: FormulaStep,
  scale: Scale,
  degree: number,
  pitch: number,
  alter: number
): Omit<ChordSegment, 'id' | 'startBeat'> {
  return {
    kind: 'note',
    pitch,
    // Carried onto the block itself, not just used to place it: once the phrase
    // is on the timeline this is the only record that the note is a raised
    // degree rather than the plain degree above it.
    alter: alter || undefined,
    chordSymbol: midiToNoteLabel(pitch),
    // An altered note is not the plain degree, and a block that claimed to be
    // would be lying about what it sounds.
    romanNumeral: accidentalLabel(alter) + diatonicChordAt(scale, degree).romanNumeral,
    root: SEMITONE_TO_NOTE[pitch % 12],
    octave: midiToOctave(pitch),
    duration: step.beats,
    velocity: step.velocity,
    scale,
  };
}

/**
 * One chord step. `rootPitch` places the chord's root, exactly as a note step's pitch
 * places its note — see `segmentAnchorPitch`, which reads the same axis back.
 *
 * A step that names no quality takes the one its scale spells for the degree it lands
 * on, so a diatonic progression becomes the new key's own chords when it is dropped
 * there. The naming is the palette's, so a realized chord reads exactly as the block
 * it stands for would.
 */
function chordFromStep(
  step: FormulaStep,
  scale: Scale,
  degree: number,
  rootPitch: number,
  alter: number
): Omit<ChordSegment, 'id' | 'startBeat'> {
  const diatonic = diatonicChordAt(scale, degree);
  const quality = step.quality ?? diatonic.quality;
  const root = SEMITONE_TO_NOTE[rootPitch % 12];
  const isSeventh = (CHORD_INTERVALS[quality]?.length ?? 3) > 3;

  return {
    kind: 'chord',
    root,
    quality,
    inversion: step.inversion,
    // The register a chord may be voiced in is narrower than the roll's range, so a
    // shape pushed to either end is placed at the edge rather than off it.
    octave: Math.min(MAX_SEGMENT_OCTAVE, Math.max(MIN_SEGMENT_OCTAVE, midiToOctave(rootPitch))),
    voicing: step.voicing,
    velocity: step.velocity,
    chordSymbol: formatChordSymbol(root, quality),
    romanNumeral:
      accidentalLabel(alter) +
      (isSeventh ? seventhNumeral(diatonic.romanNumeral, quality) : diatonic.romanNumeral),
    duration: step.beats,
    scale,
  };
}

// ---------------------------------------------------------------------------
// Reading a formula back off the timeline
// ---------------------------------------------------------------------------

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
  /**
   * Selected blocks that named no pitch at all — a note with no pitch, a chord with
   * no root — and so could not be written down. Counted rather than silently dropped:
   * the user selected them, and should be told.
   */
  skipped: number;
}

/**
 * Read a formula back out of segments already on the timeline.
 *
 * The shape is taken relative to the first block, so a phrase captured in one register
 * drops in another unchanged — which is the same relativity `realizeFormula` reads it
 * with, and what makes capture and drop inverses of each other.
 *
 * Each block is read in *its own* key rather than the first one's. Key belongs to the
 * block in this app, not to the bar, so a selection legitimately spans two of them; a
 * capture that flattened them onto one would quietly change what the phrase sounds
 * like, and could not write a modulating gesture down at all.
 *
 * @param project - The project the segments live in.
 * @param segmentIds - Ids of the selected segments, in any order.
 * @param fallbackScale - Key to read a block in when it states none.
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

  const blocks = found.filter(entry => segmentAnchorPitch(entry.segment) !== null);
  if (blocks.length === 0) return null;

  // The home key: the one the first block was written in, and the key every other
  // step's scale is then named relative to.
  const home = segmentScale(blocks[0].segment, fallbackScale);

  /**
   * Where a block sits in a scale.
   *
   * A block that states its own alteration is believed over the pitch, which cannot
   * tell a raised degree from the one above it: the C the phrase means as a sharpened
   * B would otherwise be captured as a plain C and the shape would shift.
   */
  const locate = (segment: ChordSegment, scale: Scale): DegreeAlteration => {
    const alter = segment.alter ?? 0;
    const pitch = segmentAnchorPitch(segment) as number;
    return alter === 0
      ? pitchDegreeAlteration(scale, pitch)
      : { degree: pitchDegree(scale, pitch - alter), alter };
  };

  // The pitch the whole shape is counted from, with the first block's alteration
  // taken off so it lands on a note the scale contains — the exact pitch
  // `realizeFormula` anchors on. Each step then measures its own degree from here in
  // its own scale, since two keys share no degrees, only the keyboard.
  const base = locate(blocks[0].segment, home);
  const anchorPitch = (segmentAnchorPitch(blocks[0].segment) as number) - base.alter;

  const steps: FormulaStep[] = blocks.map((entry, i) => {
    const segment = entry.segment;
    const stepScale = segmentScale(segment, fallbackScale);
    const at = locate(segment, stepScale);
    const beats = segment.duration;
    const next = blocks[i + 1];
    // Silence between this block's end and the next one's start. Rounded away from
    // the floating-point dust that beat arithmetic leaves, and never negative:
    // overlapping blocks (they can sit in different lanes) mean no rest at all.
    const gap = next ? Math.round((next.beat - (entry.beat + beats)) * 1000) / 1000 : 0;
    // A segment with no `kind` is a chord — that is what absent has always meant.
    const isChord = segment.kind !== 'note';

    return {
      kind: isChord ? 'chord' : undefined,
      // Only the degree is taken relative to the anchor. An alteration is an
      // absolute offset from whatever degree it lands on, so a phrase whose first
      // note is itself raised stays raised wherever it is dropped.
      degree: at.degree - pitchDegree(stepScale, anchorPitch),
      alter: at.alter || undefined,
      scale: scaleRefFrom(home, stepScale),
      // Written down only when the scale does not already say it, so a diatonic
      // progression becomes the new key's own chords when it is dropped there.
      quality:
        isChord && segment.quality && segment.quality !== diatonicChordAt(stepScale, at.degree).quality
          ? segment.quality
          : undefined,
      inversion: isChord ? segment.inversion || undefined : undefined,
      voicing: isChord ? segment.voicing : undefined,
      velocity: segment.velocity,
      beats,
      gapBeats: gap > 0 ? gap : undefined,
    };
  });

  return {
    formula: {
      id,
      name,
      // Written down only when the shape would be read wrong without it, so a plain
      // melodic run goes on being droppable into any mode the palette offers.
      homeType: formulaNeedsHomeType(steps) ? home.type : undefined,
      steps,
    },
    skipped: found.length - blocks.length,
  };
}
