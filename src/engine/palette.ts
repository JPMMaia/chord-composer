import type {
  ChordQuality,
  ChordSegment,
  NoteName,
  Scale,
  SegmentKind,
} from '@/types/music';
import {
  getDiatonicChords,
  getDiatonicSevenths,
  midiToNoteLabel,
  midiToOctave,
  SEMITONE_TO_NOTE,
} from '@/engine/chords';
import { getScalePitches } from '@/engine/scales';
import { generateId } from '@/utils/id';

/** Which family of blocks the palette is offering. */
export type PaletteMode = 'notes' | 'chords' | 'sevenths';

/** A draggable block in the scale palette. */
export interface PaletteItem {
  /** Stable within a (scale, mode) pair — safe as a React key and drag payload id. */
  id: string;
  kind: SegmentKind;
  /** What the block reads, e.g. 'C4', 'Dm', 'Cmaj7'. Notes carry their octave. */
  label: string;
  /** Roman numeral shown in parentheses, e.g. 'I', 'ii', 'V7', 'viiø7'. */
  degreeLabel: string;
  root?: NoteName;
  /** MIDI pitch — notes mode only. */
  pitch?: number;
  /**
   * Register the block was built in. For a note this is the octave its `pitch`
   * actually landed in, which can be one above the requested octave when the
   * ascending run wraps past B.
   */
  octave: number;
  quality?: ChordQuality;
  romanNumeral?: string;
}

/** Default octave for note blocks: 4, so the tonic sits at middle C. */
const DEFAULT_OCTAVE = 4;

/** Chord-symbol suffix per quality. */
const QUALITY_SUFFIX: Record<ChordQuality, string> = {
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
 */
function seventhNumeral(triadNumeral: string, quality: ChordQuality): string {
  const base = triadNumeral.replace(/[°+]/g, '');
  return `${base}${NUMERAL_SEVENTH_SUFFIX[quality] ?? '7'}`;
}

/**
 * Returns the palette blocks for a scale in the requested mode.
 *
 * All three modes are indexed by scale degree and share the same roman numerals,
 * so switching modes swaps the material without moving the harmonic goalposts.
 *
 * @param scale - The scale to derive material from.
 * @param mode - Which family of blocks to produce.
 * @param octave - Octave for note pitches (notes mode only). Defaults to 4.
 */
export function getPaletteItems(
  scale: Scale,
  mode: PaletteMode,
  octave: number = DEFAULT_OCTAVE
): PaletteItem[] {
  if (mode === 'notes') {
    const pitches = getScalePitches(scale.root, scale.type);
    const triads = getDiatonicChords(scale);
    const baseMidi = (octave + 1) * 12;
    const rootPitch = pitches[0];

    return pitches.map((pitch, index) => {
      // Keep the run ascending: a degree whose pitch class wrapped below the
      // tonic belongs in the next octave, so C D E ... B never dips backwards.
      const offset = ((pitch - rootPitch) % 12 + 12) % 12;
      const midi = baseMidi + rootPitch + offset;
      return {
        id: `note-${index}`,
        kind: 'note' as const,
        // Named with its register, so dragging from an octave-6 palette is
        // visibly different from an octave-4 one.
        label: midiToNoteLabel(midi),
        degreeLabel: triads[index].romanNumeral,
        root: SEMITONE_TO_NOTE[pitch],
        pitch: midi,
        // Read back off the pitch, not the argument — the ascending run pushes
        // degrees past the tonic into the octave above.
        octave: midiToOctave(midi),
        romanNumeral: triads[index].romanNumeral,
      };
    });
  }

  const isSevenths = mode === 'sevenths';
  const chords = isSevenths ? getDiatonicSevenths(scale) : getDiatonicChords(scale);

  return chords.map((chord, index) => ({
    id: `${isSevenths ? 'seventh' : 'chord'}-${index}`,
    kind: 'chord' as const,
    label: formatChordSymbol(chord.root, chord.quality),
    degreeLabel: isSevenths
      ? seventhNumeral(chord.romanNumeral, chord.quality)
      : chord.romanNumeral,
    root: chord.root,
    quality: chord.quality,
    // A chord symbol stays a bare symbol — the octave is shown beside it rather
    // than spliced into the name, which would break `chordFromSymbol`.
    octave,
    romanNumeral: chord.romanNumeral,
  }));
}

/**
 * Converts a palette block into a timeline segment ready to be inserted.
 * @param item - The dragged palette item.
 * @param duration - Length of the new segment in beats.
 */
export function paletteItemToSegment(item: PaletteItem, duration: number): ChordSegment {
  return {
    id: generateId(),
    kind: item.kind,
    pitch: item.kind === 'note' ? item.pitch : undefined,
    chordSymbol: item.label,
    romanNumeral: item.romanNumeral,
    root: item.root,
    quality: item.quality,
    octave: item.octave,
    duration,
  };
}
