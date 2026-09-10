import type {
  ChordQuality,
  ChordSegment,
  NoteName,
  Scale,
  SegmentKind,
} from '@/types/music';
import {
  CHORD_INTERVALS,
  diatonicChordAt,
  degreeOfSegment,
  getDiatonicChords,
  getDiatonicSevenths,
  segmentChordTones,
  segmentQuality,
  triadColourOf,
} from '@/engine/chords';
import { getScalePitches, octaveForDegree } from '@/engine/scales';
import { generateId } from '@/utils/id';

/**
 * How many tones the palette's blocks stack: 1 a note, 2 a dyad, 3 a triad, 4 a
 * seventh, 5 a ninth.
 *
 * One dimension where there used to be three named families. A degree is a degree
 * whatever thickness it is played at, so the strip lists the degrees once and this
 * says how much of each one to take.
 */
export const PALETTE_SIZES = [1, 2, 3, 4, 5] as const;

/** What each size is called, in the strip's dropdown. */
export const SIZE_LABELS: Record<number, string> = {
  1: 'Note',
  2: 'Dyad',
  3: 'Triad',
  4: 'Seventh',
  5: 'Ninth',
};

/** The size the palette starts on — a triad, the commonest block. */
export const DEFAULT_PALETTE_SIZE = 3;

/** A draggable block in the scale palette. */
export interface PaletteItem {
  /** Stable within a (scale, size) pair — safe as a React key and drag payload id. */
  id: string;
  kind: SegmentKind;
  /** What the block reads, e.g. 'C4', 'Dm', 'Cmaj7'. Notes carry their octave. */
  label: string;
  /** Roman numeral shown in parentheses, e.g. 'I', 'ii', 'V7', 'viiø7'. */
  degreeLabel: string;
  root?: NoteName;
  /** The chord tones this block sounds, as `ChordSegment.tones` spells them. */
  tones: number[];
  /**
   * Register the block was built in. The requested octave belongs to the scale's
   * root note, so any degree whose ascending run wraps past B comes back one
   * octave higher — for a note that is the octave its `pitch` landed in, for a
   * chord the register its root is voiced in.
   */
  octave: number;
  quality?: ChordQuality;
  romanNumeral?: string;
}

/**
 * Velocity every block dropped from the palette starts at.
 *
 * Softer than the 100 an unmarked segment reads as, so a sketch laid out from the
 * palette leaves room to accent above it as well as ease below it.
 */
export const PALETTE_VELOCITY = 50;

/** Default octave for note blocks: 4, so the tonic sits at middle C. */
const DEFAULT_OCTAVE = 4;

/** Chord-symbol suffix per quality. */
export const QUALITY_SUFFIX: Record<ChordQuality, string> = {
  major: '',
  minor: 'm',
  diminished: '°',
  augmented: 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  dominant7: '7',
  maj7: 'maj7',
  min7: 'm7',
  dim7: 'dim7',
  halfDim7: 'ø7',
  minMaj7: 'mMaj7',
};

/** Roman-numeral suffix per seventh quality, appended to the triad's numeral. */
const NUMERAL_SEVENTH_SUFFIX: Partial<Record<ChordQuality, string>> = {
  maj7: 'maj7',
  min7: '7',
  dominant7: '7',
  halfDim7: 'ø7',
  dim7: '°7',
  minMaj7: 'maj7',
};

/**
 * Formats a chord symbol from a root and quality, e.g. ('D','minor') -> 'Dm'.
 * Every symbol produced here round-trips through `chordFromSymbol`.
 */
export function formatChordSymbol(root: NoteName, quality: ChordQuality): string {
  return `${root}${QUALITY_SUFFIX[quality] ?? ''}`;
}

/**
 * Builds the roman numeral for a seventh chord from its triad numeral, so that a
 * dominant on the fifth degree reads 'V7' and the half-diminished leading-tone
 * chord reads 'viiø7' rather than 'vii°ø7'.
 *
 * Exported so a chord realized from a formula is named exactly as the palette block
 * it stands for would be.
 */
export function seventhNumeral(triadNumeral: string, quality: ChordQuality): string {
  const base = triadNumeral.replace(/[°+]/g, '');
  return `${base}${NUMERAL_SEVENTH_SUFFIX[quality] ?? '7'}`;
}

/**
 * Chord-symbol suffix for a ninth, by the seventh quality beneath it.
 *
 * Only the six four-note qualities appear: a ninth is a seventh with one more third
 * on top, so the seventh's colour is what names it. A triadic quality carried this
 * far is one the user pinned, and is named by `extendedSymbol` instead.
 */
const NINTH_SUFFIX: Partial<Record<ChordQuality, string>> = {
  maj7: 'maj9',
  min7: 'm9',
  dominant7: '9',
  halfDim7: 'ø9',
  dim7: '°9',
  minMaj7: 'mMaj9',
};

/** Roman-numeral suffix per ninth quality, appended to the triad's numeral. */
const NUMERAL_NINTH_SUFFIX: Partial<Record<ChordQuality, string>> = {
  maj7: 'maj9',
  min7: '9',
  dominant7: '9',
  halfDim7: 'ø9',
  dim7: '°9',
  minMaj7: 'maj9',
};

/** How an omitted chord tone is named, by the tone it is. */
const OMISSION_NAMES: Record<number, string> = { 1: 'no3', 2: 'no5', 3: 'no7' };

/**
 * Case a numeral by the triad its chord is built on.
 *
 * The same rule `getDiatonicStack` follows — a seventh reads `V7` rather than
 * switching case with its extension — applied to a chord whose colour may have been
 * pinned rather than spelled by the key. A suspended chord has no third to be cased
 * by, so it reads as the major it stands in for.
 */
function caseNumeral(base: string, quality: ChordQuality): string {
  switch (triadColourOf(quality)) {
    case 'minor':
      return base.toLowerCase();
    case 'diminished':
      return base.toLowerCase() + '°';
    case 'augmented':
      return base.toLowerCase() + '+';
    default:
      return base.toUpperCase();
  }
}

/**
 * A chord whose quality cannot name the extension it has grown.
 *
 * Only a pinned triad reaches this: an unpinned stack takes a four-note quality from
 * its key, which names its own seventh. `Gsus4(7)` states the extension beside the
 * triad rather than inventing a quality for a combination `ChordQuality` has no
 * member for — which is what keeps that union, and everything switching on it, closed.
 */
function extendedSymbol(root: NoteName, quality: ChordQuality, seventh: number | undefined): string {
  const triad = formatChordSymbol(root, quality);
  if (seventh === undefined) return `${triad}(9)`;
  const label = seventh === 11 ? 'maj7' : seventh === 9 ? '°7' : '7';
  return `${triad}(${label})`;
}

/**
 * How a segment names itself: its chord symbol and its roman numeral.
 *
 * The one place either string is decided, so a block cannot come to disagree with
 * itself about what it is. Six separate writers used to build these by hand, and a
 * stack gave them five more shapes each to get right.
 *
 * Named by the highest tone the stack reaches, with every tone missing below it
 * spelled out: `C` a single tone or a triad, `C5` the power dyad, `C(no5)` a third
 * dyad, `Cmaj7`, `Cmaj9`, `Cmaj9(no5)`.
 *
 * The size reaching the *numeral* is load-bearing beyond mere labelling:
 * `mergeAdjacentChords` fuses neighbouring blocks that share one, so `I` and `Imaj9`
 * differing is the only thing stopping a triad and a ninth on the same degree
 * collapsing into a single block.
 */
export function nameSegment(
  segment: ChordSegment,
  scale: Scale
): { chordSymbol: string; romanNumeral: string } {
  const { tones, intervals } = segmentChordTones(segment, scale);
  const quality = segmentQuality(segment, scale);
  const triad = diatonicChordAt(scale, degreeOfSegment(segment, scale), 3);

  const root = segment.root ?? triad?.root ?? 'C';
  const base = (triad?.romanNumeral ?? segment.romanNumeral ?? 'I')
    .replace(/[°+]/g, '')
    .toUpperCase();
  const numeral = caseNumeral(base, quality);

  const highest = tones[tones.length - 1] ?? 0;

  // The one dyad with a name of its own, and the one everybody reads the same way.
  if (tones.length === 2 && highest === 2) {
    return { chordSymbol: `${root}5`, romanNumeral: `${numeral}5` };
  }

  // A single tone is just its note; there is no harmony to qualify.
  if (highest === 0) {
    return { chordSymbol: root, romanNumeral: numeral };
  }

  const seventhInterval = tones.includes(3) ? intervals[tones.indexOf(3)] : undefined;
  const namesItsOwnSeventh = (CHORD_INTERVALS[quality]?.length ?? 3) >= 4;

  let chordSymbol: string;
  let romanNumeral: string;

  if (highest >= 4) {
    const suffix = NINTH_SUFFIX[quality];
    chordSymbol = suffix ? `${root}${suffix}` : extendedSymbol(root, quality, undefined);
    romanNumeral = `${base ? numeral.replace(/[°+]/g, '') : numeral}${
      NUMERAL_NINTH_SUFFIX[quality] ?? '9'
    }`;
  } else if (highest === 3) {
    chordSymbol = namesItsOwnSeventh
      ? formatChordSymbol(root, quality)
      : extendedSymbol(root, quality, seventhInterval);
    romanNumeral = seventhNumeral(numeral, quality);
  } else {
    chordSymbol = formatChordSymbol(root, quality);
    romanNumeral = numeral;
  }

  // Everything the stack skips on its way up, in tone order.
  //
  // Measured against the *level* the chord reaches rather than its highest tone, so a
  // third dyad reads `C(no5)`: it is a triad with its fifth missing, not a chord that
  // simply stops at the third. A seventh and a ninth both stop at their own top tone,
  // which is present by definition and so never reported missing.
  const levelTop = highest >= 4 ? 4 : highest >= 3 ? 3 : 2;
  const missing = [1, 2, 3]
    .filter(tone => tone <= levelTop && !tones.includes(tone))
    .map(tone => OMISSION_NAMES[tone]);

  if (missing.length > 0) {
    const suffix = `(${missing.join(',')})`;
    chordSymbol += suffix;
    romanNumeral += suffix;
  }

  return { chordSymbol, romanNumeral };
}

/**
 * Returns the palette blocks for a scale in the requested mode.
 *
 * All three modes are indexed by scale degree and share the same roman numerals,
 * so changing the size swaps the material without moving the harmonic goalposts.
 *
 * @param scale - The scale to derive material from.
 * @param size - How many tones each block stacks, 1 to 5.
 * @param octave - Register of the scale's *root note*. Degrees above it rise from
 *   there, crossing into the next octave when the run wraps past B, so no block ever
 *   sounds below the tonic. Defaults to 4.
 */
export function getPaletteItems(
  scale: Scale,
  size: number = DEFAULT_PALETTE_SIZE,
  octave: number = DEFAULT_OCTAVE
): PaletteItem[] {
  const clamped = Math.min(PALETTE_SIZES.length, Math.max(1, Math.trunc(size)));
  const tones = Array.from({ length: clamped }, (_, i) => i);

  // A quality names a triad or a seventh and nothing wider, so that is what the
  // table is asked for; the ninth on top of it is spelled by the key.
  const chords = clamped >= 4 ? getDiatonicSevenths(scale) : getDiatonicChords(scale);
  // The diatonic stack is built by mapping over these, so degree `index` is the
  // same degree in both lists.
  const pitches = getScalePitches(scale.root, scale.type);

  return chords.map((chord, index) => {
    const block: ChordSegment = {
      id: '',
      kind: 'chord',
      duration: 0,
      root: chord.root,
      quality: chord.quality,
      romanNumeral: chord.romanNumeral,
      tones,
    };
    // Named by the one namer, so a block reads on the strip exactly as it will read
    // once it is on the timeline.
    const { chordSymbol, romanNumeral } = nameSegment(block, scale);

    return {
      id: `stack${clamped}-${index}`,
      kind: 'chord' as const,
      label: chordSymbol,
      degreeLabel: romanNumeral,
      root: chord.root,
      quality: chord.quality,
      tones,
      // A chord symbol stays a bare symbol — the octave is shown beside it rather
      // than spliced into the name, which would break `chordFromSymbol`. The
      // argument is the tonic's register; a wrapped degree voices one above it.
      octave: octaveForDegree(scale, pitches[index], octave),
      romanNumeral,
    };
  });
}

/**
 * Converts a palette block into a timeline segment ready to be inserted.
 *
 * The block is stamped with the key it was built from, so it keeps naming the same
 * degree wherever it is dropped — and the palette can move to another key without
 * disturbing anything already on the timeline.
 *
 * @param item - The dragged palette item.
 * @param duration - Length of the new segment in beats.
 * @param scale - The palette's key, which the new segment is written in.
 */
export function paletteItemToSegment(
  item: PaletteItem,
  duration: number,
  scale: Scale
): ChordSegment {
  return {
    id: generateId(),
    kind: 'chord',
    tones: item.tones,
    chordSymbol: item.label,
    romanNumeral: item.romanNumeral,
    root: item.root,
    quality: item.quality,
    octave: item.octave,
    duration,
    velocity: PALETTE_VELOCITY,
    scale,
  };
}
