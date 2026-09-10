import type { ChordSegment, NoteName, Scale, ChordQuality } from '@/types/music';
import { MAX_CHORD_TONE } from '@/types/music';
import { getScalePitches } from './scales';

/** Internal representation of a chord with intervals. */
export interface ChordData {
  root: NoteName;
  intervals: number[];
  bass?: NoteName;
}

/** Diatonic chord info with quality and roman numeral. */
export interface ChordInfo {
  root: NoteName;
  quality: ChordQuality;
  romanNumeral: string;
}

/**
 * A chord's sounding stack: which chord tones it contains, and what they sound.
 *
 * The two arrays are parallel. They are separate because a stack may have gaps — a
 * fifth dyad is tones `[0,2]`, a ninth with no fifth `[0,1,3,4]` — and once a tone
 * can be absent, a tone's *index* and its *position* stop coinciding. Every stored
 * voicing is keyed by the former: `offsets[3]` means "the seventh", wherever the
 * seventh happens to sit.
 */
export interface ChordTones {
  /** Sounded tone indices, ascending, always containing 0. 0 root … 4 ninth. */
  tones: number[];
  /** Root-position semitone offsets, parallel to `tones`, strictly ascending. */
  intervals: number[];
}

/** Interval patterns for each chord quality (relative to root). */
export const CHORD_INTERVALS: Record<ChordQuality, number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  diminished: [0, 3, 6],
  augmented: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dominant7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dim7: [0, 3, 6, 9],
  halfDim7: [0, 3, 6, 10],
  minMaj7: [0, 3, 7, 11],
};

/** Diatonic chord qualities for a major scale (I through vii°). */
export const DIATONIC_CHORD_QUALITIES_MAJOR: ChordQuality[] = [
  'major', 'minor', 'minor', 'major', 'major', 'minor', 'diminished',
];

/** Diatonic chord qualities for a natural minor scale (i through VI). */
export const DIATONIC_CHORD_QUALITIES_MINOR: ChordQuality[] = [
  'minor', 'diminished', 'major', 'minor', 'minor', 'major', 'major',
];

/** Mapping from note name to semitone offset. */
const NOTE_TO_SEMITONE: Record<NoteName, number> = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5,
  'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

/** Mapping from semitone offset to note name. */
export const SEMITONE_TO_NOTE: Record<number, NoteName> = {
  0: 'C', 1: 'C#', 2: 'D', 3: 'D#', 4: 'E', 5: 'F',
  6: 'F#', 7: 'G', 8: 'G#', 9: 'A', 10: 'A#', 11: 'B',
};

/**
 * Scientific-pitch octave of a MIDI note: 60 -> 4, so middle C reads C4.
 * @param midi - MIDI note number.
 */
export function midiToOctave(midi: number): number {
  return Math.floor(midi / 12) - 1;
}

/**
 * Full key name for a MIDI note: 60 -> 'C4', 61 -> 'C#4'.
 *
 * Spelled with sharps, matching `NoteName`. The MusicXML exporter keeps its own
 * speller because it also has to choose flats for the key it is writing in.
 *
 * @param midi - MIDI note number.
 */
export function midiToNoteLabel(midi: number): string {
  const pitchClass = ((midi % 12) + 12) % 12;
  return `${SEMITONE_TO_NOTE[pitchClass]}${midiToOctave(midi)}`;
}

/**
 * Rotates a chord's intervals into an inversion: the lowest `inversion` notes
 * each move up an octave, so `[0,4,7]` at inversion 1 becomes `[4,7,12]` — the
 * third in the bass, the root on top.
 *
 * Kept separate from any particular octave so both the chord builder and the
 * timeline's note generator can voice a segment the same way.
 *
 * @param intervals - Ascending semitone offsets from the chord root.
 * @param inversion - How many notes to lift; values past the chord size keep
 *   rotating, which simply stacks the whole chord an octave higher.
 * @returns A new array; the input is left alone.
 */
export function invertIntervals(intervals: number[], inversion: number): number[] {
  const shifted = [...intervals];
  for (let i = 0; i < inversion; i++) {
    shifted.push(shifted.shift()! + 12);
  }
  return shifted;
}

/** Roman numeral labels for major scale degrees (case varies by quality). */
const ROMAN_NUMERAL_BASES_MAJOR = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** Roman numeral labels for minor scale degrees. */
const ROMAN_NUMERAL_BASES_MINOR = ['i', 'ii', 'III', 'iv', 'v', 'VI', 'VII'];

/** Map chord quality to roman numeral case: major=a, minor=lower, diminished=lower+° */
function romanForQuality(quality: ChordQuality, base: string): string {
  switch (quality) {
    case 'major':
      return base.toUpperCase();
    case 'minor':
      return base.toLowerCase();
    case 'diminished':
      return base.toLowerCase() + '°';
    case 'augmented':
      return base.toLowerCase() + '+';
    default:
      return base.toLowerCase();
  }
}

/** True for the scale types whose roman numerals use minor-key casing. */
function isMinorScale(scale: Scale): boolean {
  return (
    scale.type === 'naturalMinor' ||
    scale.type === 'harmonicMinor' ||
    scale.type === 'melodicMinor'
  );
}

/**
 * Builds a chord by stacking thirds *within the scale itself* — taking degrees
 * i, i+2, i+4 (and i+6 for a seventh), wrapping around the scale.
 *
 * Deriving chords from the scale rather than from a fixed 7-entry quality table
 * is what makes this correct for every scale type, including the 5-note
 * pentatonics and the 6-note blues scale.
 *
 * @param scalePitches - Pitch classes of the scale, in scale-degree order.
 * @param degree - Index of the scale degree to build on.
 * @param noteCount - How many thirds to stack: 3 a triad, 4 a seventh, 5 a ninth.
 *   Never ask for fewer than 3 — `approximateQuality` reads `intervals[1]`.
 * @returns Ascending semitone intervals relative to the chord root.
 */
export function buildStackedChord(
  scalePitches: number[],
  degree: number,
  noteCount: number
): number[] {
  const length = scalePitches.length;
  const root = scalePitches[degree % length];
  const pitchClasses: number[] = [];

  for (let i = 0; i < noteCount; i++) {
    const pitch = scalePitches[(degree + i * 2) % length];
    pitchClasses.push(((pitch - root) % 12 + 12) % 12);
  }

  return ascend(pitchClasses);
}

/**
 * Lift each interval into the octave that keeps the stack strictly ascending.
 *
 * A wrapped scale degree belongs above the tone beneath it, not below it. Shared
 * with `segmentChordTones`, which composes a stack out of two sources — a quality's
 * triad and a scale's extensions — and so has to re-establish an order that neither
 * source alone can guarantee. Without it a pinned diminished triad under a blues
 * scale's "seventh" produces a descending array, which every voicing function would
 * then read as an inversion nobody asked for.
 */
export function ascend(intervals: number[]): number[] {
  const stacked: number[] = [];

  for (const value of intervals) {
    let interval = value;
    while (stacked.length > 0 && interval <= stacked[stacked.length - 1]) {
      interval += 12;
    }
    stacked.push(interval);
  }

  return stacked;
}

/**
 * Matches an interval set back to a known chord quality.
 * @returns The quality, or undefined when the intervals match nothing known.
 */
export function classifyIntervals(intervals: number[]): ChordQuality | undefined {
  const qualities = Object.keys(CHORD_INTERVALS) as ChordQuality[];
  return qualities.find(quality => intervalsEqual(intervals, CHORD_INTERVALS[quality]));
}

/**
 * Falls back to a usable quality when a stacked chord matches no known pattern,
 * which happens on gapped scales like pentatonic and blues. The third decides.
 */
function approximateQuality(intervals: number[]): ChordQuality {
  return intervals[1] === 3 ? 'minor' : 'major';
}

/**
 * Builds the diatonic chords of a scale by stacking thirds on each degree.
 * @param scale - The scale to derive chords from.
 * @param noteCount - 3 for triads, 4 for sevenths.
 */
function getDiatonicStack(scale: Scale, noteCount: number): ChordInfo[] {
  const scalePitches = getScalePitches(scale.root, scale.type);
  const bases = isMinorScale(scale) ? ROMAN_NUMERAL_BASES_MINOR : ROMAN_NUMERAL_BASES_MAJOR;

  return scalePitches.map((pitch, index) => {
    const intervals = buildStackedChord(scalePitches, index, noteCount);
    const quality = classifyIntervals(intervals) ?? approximateQuality(intervals);

    // Roman numerals are cased by the *triad* at this degree, so that a seventh
    // reads as V7 rather than switching case with its extension.
    const triadIntervals =
      noteCount === 3 ? intervals : buildStackedChord(scalePitches, index, 3);
    const triadQuality =
      classifyIntervals(triadIntervals) ?? approximateQuality(triadIntervals);

    return {
      root: SEMITONE_TO_NOTE[pitch],
      quality,
      romanNumeral: romanForQuality(triadQuality, bases[index % bases.length]),
    };
  });
}

/**
 * Returns the diatonic triads for the given scale.
 * @param scale - The scale to derive chords from.
 * @returns One chord info object per scale degree (7 for heptatonic scales).
 */
export function getDiatonicChords(scale: Scale): ChordInfo[] {
  return getDiatonicStack(scale, 3);
}

/**
 * Returns the diatonic seventh chords for the given scale — Imaj7, iim7, V7 and
 * so on, including the half-diminished vii of a major key.
 * @param scale - The scale to derive chords from.
 * @returns One chord info object per scale degree.
 */
export function getDiatonicSevenths(scale: Scale): ChordInfo[] {
  return getDiatonicStack(scale, 4);
}

/* -------------------------------------------------------------------------- */
/* Resolving a segment to the tones it sounds                                  */
/* -------------------------------------------------------------------------- */

/*
 * These live here rather than in `chordOperations` because deciding which notes a
 * chord contains is theory, and because `voicing.ts` needs them: it kept a private
 * copy of the interval lookup purely to avoid importing `chordOperations`, and this
 * is the module both of them already depend on.
 */

/** The triadic half of a quality — the colour that survives a change of size. */
export type TriadColour = 'major' | 'minor' | 'diminished' | 'augmented' | 'sus2' | 'sus4';

/** The triad each quality is built on, which is what a size change preserves. */
const TRIAD_COLOUR: Record<ChordQuality, TriadColour> = {
  major: 'major',
  minor: 'minor',
  diminished: 'diminished',
  augmented: 'augmented',
  sus2: 'sus2',
  sus4: 'sus4',
  dominant7: 'major',
  maj7: 'major',
  min7: 'minor',
  dim7: 'diminished',
  halfDim7: 'diminished',
  minMaj7: 'minor',
};

/**
 * The seventh a chord takes when it sits on no scale degree at all.
 *
 * Only reached by a chord the key cannot spell — a borrowed root, or a degree a
 * gapped scale simply lacks. A major triad takes its major seventh; everything else
 * takes a minor one, diminished included, because the half-diminished is much the
 * commoner chord and `dim7` is available by naming it outright.
 */
const DEFAULT_SEVENTH: Record<TriadColour, number> = {
  major: 11,
  minor: 10,
  diminished: 10,
  augmented: 10,
  sus2: 10,
  sus4: 10,
};

/** The ninth a chord takes off-degree: the plain major ninth, whatever sits below. */
const DEFAULT_NINTH = 14;

/** The seventh's colour. Absent means the one the key spells for this degree. */
export type SeventhColour = 'major' | 'minor' | 'diminished';

/**
 * The stored quality each pair of colours composes to.
 *
 * Deliberately partial. `ChordQuality` has twelve members — six triads and six
 * sevenths — so several pairs name no quality at all: a suspended or augmented triad
 * with a seventh on it, or a diminished triad under a major seventh. Rather than
 * widen a union that `validateProject`, the MusicXML exporter and the formula library
 * all switch on, those keep the *triad* quality and let the seventh come from the key,
 * which `segmentChordTones` already does and `nameSegment` already says out loud.
 */
const QUALITY_BY_COLOUR: Partial<Record<TriadColour, Partial<Record<SeventhColour, ChordQuality>>>> =
  {
    major: { major: 'maj7', minor: 'dominant7' },
    minor: { major: 'minMaj7', minor: 'min7' },
    diminished: { minor: 'halfDim7', diminished: 'dim7' },
  };

/**
 * Compose a triad colour and a seventh colour into the quality that stores them.
 *
 * Falls back to the bare triad for a pair no quality names, which is not a loss: the
 * seventh is then spelled by the key, and a stack that reaches tone 3 still sounds one.
 */
export function composeQuality(triad: TriadColour, seventh?: SeventhColour): ChordQuality {
  if (!seventh) return triad;
  return QUALITY_BY_COLOUR[triad]?.[seventh] ?? triad;
}

/** The seventh a quality names, or undefined for a triad — which names none. */
export function seventhColourOf(quality: ChordQuality): SeventhColour | undefined {
  switch (quality) {
    case 'maj7':
    case 'minMaj7':
      return 'major';
    case 'dominant7':
    case 'min7':
    case 'halfDim7':
      return 'minor';
    case 'dim7':
      return 'diminished';
    default:
      return undefined;
  }
}

/** The triad a quality is coloured by. */
export function triadColourOf(quality: ChordQuality): TriadColour {
  return TRIAD_COLOUR[quality] ?? 'major';
}

/** Casing carries a numeral's quality; the symbols are decoration. */
function bareNumeral(numeral: string): string {
  return numeral.replace(/[°+]/g, '');
}

/**
 * Which degree of `scale` a segment sits on, or -1.
 *
 * The roman numeral is the authority — it is what the user wrote — but a segment
 * dropped without one still names a degree through its root, so fall back to that
 * before giving up and calling the chord chromatic.
 */
export function degreeOfSegment(segment: ChordSegment, scale: Scale): number {
  if (segment.romanNumeral) {
    const target = bareNumeral(segment.romanNumeral);
    const byNumeral = getDiatonicChords(scale).findIndex(
      c => bareNumeral(c.romanNumeral) === target
    );
    if (byNumeral !== -1) return byNumeral;
  }

  if (!segment.root) return -1;
  const semitone = NOTE_TO_SEMITONE[segment.root];
  if (semitone === undefined) return -1;
  return getScalePitches(scale.root, scale.type).indexOf(semitone);
}

/**
 * The diatonic chord at one degree, at a given stack size.
 *
 * Generalises `getDiatonicChords` and `getDiatonicSevenths` to a single lookup, so
 * nothing has to branch on "is this a seventh" to pick a table. The size is clamped
 * to 3 or 4: a quality names a triad or a seventh and nothing wider, and asking for
 * fewer than three would leave `approximateQuality` with no third to read.
 *
 * @returns The chord, or undefined at a degree the scale does not reach.
 */
export function diatonicChordAt(
  scale: Scale,
  degree: number,
  size: number
): ChordInfo | undefined {
  if (degree < 0) return undefined;
  const chords = getDiatonicStack(scale, Math.min(4, Math.max(3, Math.trunc(size))));
  return chords[degree];
}

/**
 * How wide a stack the stored `quality` has to name: 3 or 4.
 *
 * The invariant that keeps `ChordQuality` from having to grow: a quality always
 * describes the triad or the seventh a segment's tones are drawn from, and the ninth
 * is never stored because no quality can name one.
 */
function qualitySize(tones: number[] | undefined): number {
  if (!Array.isArray(tones) || tones.length === 0) return 3;
  const highest = tones.reduce(
    (max, t) => (Number.isFinite(t) ? Math.max(max, Math.trunc(t)) : max),
    0
  );
  return highest >= 3 ? 4 : 3;
}

/**
 * How wide a stack a segment's stored quality has to name: 3 or 4.
 *
 * What every "is this a seventh?" test becomes once a chord can be any size. A
 * segment naming no tones falls back to the width of the quality it carries, which
 * is exactly the answer the old interval-counting test gave, so nothing about a
 * pre-stack project changes.
 */
export function segmentQualitySize(segment: ChordSegment): number {
  if (Array.isArray(segment.tones) && segment.tones.length > 0) {
    return qualitySize(segment.tones);
  }
  return segment.quality ? (CHORD_INTERVALS[segment.quality]?.length ?? 3) : 3;
}

/**
 * The quality a segment resolves to: its own, else the one its key spells for the
 * degree it sits on, else plain major.
 */
export function segmentQuality(segment: ChordSegment, scale: Scale): ChordQuality {
  if (segment.quality && CHORD_INTERVALS[segment.quality]) return segment.quality;
  const degree = degreeOfSegment(segment, scale);
  return diatonicChordAt(scale, degree, qualitySize(segment.tones))?.quality ?? 'major';
}

/**
 * Read a stack off a segment, keeping only what makes sense.
 *
 * Dropped rather than repaired, the way `readVoicing` treats a voicing: a tone index
 * the app has no name for says nothing about what the author meant. An absent or
 * empty stack falls back to every tone of the quality, which is what every block
 * written before stacks existed was.
 */
function readTones(raw: number[] | undefined, fallbackSize: number): number[] {
  return readStackTones(raw) ?? Array.from({ length: fallbackSize }, (_, i) => i);
}

/**
 * Read a stack off a document, or undefined when it names none.
 *
 * Shared by the project reader and the formula-library reader, exactly as
 * `readVoicing` is: both take a stack off a file a user may have hand-edited, and
 * both want the same answer for the same garbage. One copy, so the two can never
 * drift apart about what a file means.
 *
 * Anything unrecognised is dropped rather than repaired — a tone index this app has
 * no name for says nothing about what the author meant. The root is forced in
 * because a register and an inversion are both counted from it.
 */
export function readStackTones(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const kept = new Set<number>();
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const tone = Math.trunc(value);
    if (tone < 0 || tone > MAX_CHORD_TONE) continue;
    kept.add(tone);
  }

  if (kept.size === 0) return undefined;
  kept.add(0);
  return [...kept].sort((a, b) => a - b);
}

/**
 * The chord tones a segment sounds, and the intervals they sound at.
 *
 * The one place a chord's notes are decided. Tones 0-2 come from the segment's
 * quality, so a chord sounds exactly as it did before stacks existed; the seventh
 * comes from the quality when it names one and from the key otherwise; and the
 * ninth always comes from the key, because no quality can name one.
 *
 * That split is what makes a pinned colour musically useful rather than merely
 * defined: pinning a major triad on the ii of C major gives D F# A, and the key
 * still spells its seventh and ninth, so the stack grows into D7 and D9 — the
 * secondary dominant, which is the reason anyone pins a colour on ii.
 */
export function segmentChordTones(segment: ChordSegment, scale: Scale): ChordTones {
  const quality = segmentQuality(segment, scale);
  const base = CHORD_INTERVALS[quality] ?? CHORD_INTERVALS.major;
  const tones = readTones(segment.tones, base.length);

  const degree = degreeOfSegment(segment, scale);
  const stacked =
    degree >= 0
      ? buildStackedChord(getScalePitches(scale.root, scale.type), degree, MAX_CHORD_TONE + 1)
      : undefined;
  const colour = triadColourOf(quality);

  const full = ascend([
    base[0],
    base[1],
    base[2],
    base[3] ?? stacked?.[3] ?? DEFAULT_SEVENTH[colour],
    stacked?.[4] ?? DEFAULT_NINTH,
  ]);

  return { tones, intervals: tones.map(t => full[t]) };
}

/** Just the tone indices — what the inspector labels its rows with. */
export function segmentTones(segment: ChordSegment, scale: Scale): number[] {
  return segmentChordTones(segment, scale).tones;
}

/**
 * Returns the Roman numeral for a chord within a scale.
 * @param chordRoot - The root note of the chord.
 * @param chordQuality - The quality of the chord.
 * @param scale - The scale context.
 * @returns Roman numeral string (e.g., 'I', 'ii', 'V').
 */
export function getRomanNumeral(
  chordRoot: NoteName,
  chordQuality: ChordQuality,
  scale: Scale
): string {
  const diatonicChords = getDiatonicChords(scale);
  const chordSemitone = NOTE_TO_SEMITONE[chordRoot];
  if (chordSemitone === undefined) {
    throw new Error(`Invalid chord root: ${chordRoot}`);
  }

  const index = diatonicChords.findIndex(
    c => c.root === chordRoot && c.quality === chordQuality
  );

  if (index === -1) {
    // Try to find by pitch class only
    const scalePitches = getScalePitches(scale.root, scale.type);
    const pitchIndex = scalePitches.indexOf(chordSemitone);
    if (pitchIndex === -1) {
      throw new Error(`Chord ${chordRoot} ${chordQuality} not diatonic to ${scale.root} ${scale.type}`);
    }
    const isMinor =
      scale.type === 'naturalMinor' || scale.type === 'harmonicMinor' || scale.type === 'melodicMinor';
    const romanNumerals = isMinor ? ROMAN_NUMERAL_BASES_MINOR : ROMAN_NUMERAL_BASES_MAJOR;
    return romanNumerals[pitchIndex];
  }

  return diatonicChords[index].romanNumeral;
}

/**
 * Creates a chord from a Roman numeral within a scale.
 * @param roman - Roman numeral string (e.g., 'I', 'ii', 'vii°').
 * @param scale - The scale context.
 * @returns ChordInfo with root, quality, and intervals.
 */
export function chordFromRomanNumeral(roman: string, scale: Scale): ChordInfo & { intervals: number[] } {
  const diatonicChords = getDiatonicChords(scale);
  const romanClean = roman.replace(/[°+]/g, '');

  // Find matching chord by roman numeral (strip suffixes from stored values too)
  const match = diatonicChords.find(c => c.romanNumeral.replace(/[°+]/g, '') === romanClean);
  if (!match) {
    throw new Error(`Invalid Roman numeral '${roman}' for scale ${scale.root} ${scale.type}`);
  }

  return {
    root: match.root,
    quality: match.quality,
    romanNumeral: match.romanNumeral,
    intervals: CHORD_INTERVALS[match.quality],
  };
}

/**
 * Parses a chord symbol string into a ChordData object.
 * Supports: C, Cm, Cmaj7, C7, Cmin7, Cdim, Caug, Csus2, Csus4, Cm9, C/E, etc.
 * @param symbol - Chord symbol string.
 * @returns ChordData with root, intervals, and optional bass note.
 */
export function chordFromSymbol(symbol: string): ChordData {
  // Handle inversion: C/E
  let bassNote: NoteName | undefined;
  let chordPart = symbol;
  if (symbol.includes('/')) {
    const [chordStr, bassStr] = symbol.split('/');
    chordPart = chordStr.trim();
    bassNote = bassStr.trim() as NoteName;
    if (NOTE_TO_SEMITONE[bassNote] === undefined) {
      throw new Error(`Invalid bass note in chord symbol: ${symbol}`);
    }
  }

  // Parse root note (first character, possibly followed by # or b)
  let root: NoteName | undefined;
  let rest = chordPart;

  // Try to match root + accidental
  if (chordPart.length >= 2 && chordPart[1] === '#') {
    root = chordPart.substring(0, 2) as NoteName;
    rest = chordPart.substring(2);
  } else if (chordPart.length >= 2 && chordPart[1] === 'b') {
    // Handle flat notation: Cm(b7) → C minor with flat 7 (simplified: just use root)
    root = chordPart.substring(0, 2) as NoteName;
    rest = chordPart.substring(2);
  } else {
    root = chordPart[0] as NoteName;
    rest = chordPart.substring(1);
  }

  if (root === undefined || NOTE_TO_SEMITONE[root] === undefined) {
    throw new Error(`Invalid chord symbol: ${symbol}`);
  }

  // Determine quality and extensions from the rest
  const intervals = parseChordQuality(rest);
  if (intervals.length < 3) {
    throw new Error(`Cannot determine chord quality from symbol: ${symbol}`);
  }

  return { root, intervals, bass: bassNote };
}

/**
 * Converts a chord to MIDI note numbers.
 * @param chord - ChordData with root and intervals.
 * @param octave - The octave for the root (e.g., 4 for middle C octave).
 * @param inversion - Inversion offset (0 = root position).
 * @returns Array of MIDI note numbers.
 */
export function chordToNotes(chord: ChordData, octave: number, inversion: number = 0): number[] {
  const intervals = chord.intervals;

  // Validate: need at least a triad (3 notes)
  if (intervals.length < 3) {
    throw new Error('Invalid chord intervals: need at least 3 notes for a triad');
  }

  // Check that intervals match a known chord quality
  const knownQualities = Object.values(CHORD_INTERVALS);
  const isValid = knownQualities.some(known => intervalsEqual(intervals, known));
  if (!isValid) {
    throw new Error('Invalid chord intervals: does not match any known chord quality');
  }

  const rootSemitone = NOTE_TO_SEMITONE[chord.root];
  const baseMidi = (octave + 1) * 12;

  return invertIntervals(intervals, inversion).map(
    interval => baseMidi + rootSemitone + interval
  );
}

/**
 * Parses a chord quality suffix string into interval offsets.
 */
function parseChordQuality(rest: string): number[] {
  const trimmed = rest.trim();

  // Check for extended chords first (maj9, m9, 9, 11, 13)
  if (/^[mM]?[0-9]+$/.test(trimmed)) {
    const isMinor = trimmed.startsWith('m');
    const number = parseInt(trimmed.replace('m', ''), 10);

    if (number === 7) {
      return isMinor ? CHORD_INTERVALS.min7 : CHORD_INTERVALS.dominant7;
    }
    if (number === 9) {
      // For m9: minor triad + min7 + major 9th (14)
      // For 9 (dominant 9th): dominant7 + major 9th (14)
      const base = isMinor ? CHORD_INTERVALS.min7 : CHORD_INTERVALS.dominant7;
      return [...base, 14];
    }
    if (number === 11) {
      const base = isMinor ? CHORD_INTERVALS.min7 : CHORD_INTERVALS.dominant7;
      return [...base, 14, 17];
    }
    if (number === 13) {
      const base = isMinor ? CHORD_INTERVALS.min7 : CHORD_INTERVALS.dominant7;
      return [...base, 14, 17, 21];
    }
  }

  // Check for maj7
  if (trimmed === 'maj7' || trimmed === 'M7' || trimmed === 'Δ' || trimmed === '△') {
    return CHORD_INTERVALS.maj7;
  }

  // Check for dominant 7th
  if (trimmed === '7' || trimmed === 'dom7') {
    return CHORD_INTERVALS.dominant7;
  }

  // Check for minor 7th
  if (trimmed === 'm7' || trimmed === 'min7') {
    return CHORD_INTERVALS.min7;
  }

  // Check for diminished 7th
  if (trimmed === 'dim7' || trimmed === '°7' || trimmed === 'o7') {
    return CHORD_INTERVALS.dim7;
  }

  // Check for half-diminished 7th (m7b5)
  if (
    trimmed === 'm7b5' || trimmed === 'min7b5' || trimmed === 'ø' || trimmed === 'ø7'
  ) {
    return CHORD_INTERVALS.halfDim7;
  }

  // Check for minor-major 7th
  if (trimmed === 'mMaj7' || trimmed === 'mM7' || trimmed === 'minMaj7') {
    return CHORD_INTERVALS.minMaj7;
  }

  // Check for triads
  if (trimmed === '' || trimmed === 'maj' || trimmed === 'M' || trimmed === '△') {
    return CHORD_INTERVALS.major;
  }
  if (trimmed === 'm' || trimmed === 'min' || trimmed === '-') {
    return CHORD_INTERVALS.minor;
  }
  if (trimmed === 'dim' || trimmed === '°' || trimmed === 'o') {
    return CHORD_INTERVALS.diminished;
  }
  if (trimmed === 'aug' || trimmed === '+' || trimmed === 'aug7') {
    return CHORD_INTERVALS.augmented;
  }
  if (trimmed === 'sus2') {
    return CHORD_INTERVALS.sus2;
  }
  if (trimmed === 'sus4' || trimmed === 'sus') {
    return CHORD_INTERVALS.sus4;
  }

  // Default to major triad for unrecognized suffixes
  return CHORD_INTERVALS.major;
}

/**
 * Compares two interval arrays for equality.
 */
function intervalsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
