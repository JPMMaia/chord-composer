import { describe, it, expect } from 'vitest';
import {
  CHORD_INTERVALS,
  buildStackedChord,
  segmentChordTones,
  segmentTones,
  degreeOfSegment,
  segmentQuality,
  diatonicChordAt,
} from '@/engine/chords';
import { getScalePitches } from '@/engine/scales';
import type { ChordQuality, ChordSegment, Scale, ScaleType } from '@/types/music';

const C_MAJOR: Scale = { root: 'C', type: 'major' };
const A_MINOR: Scale = { root: 'A', type: 'naturalMinor' };

function chord(overrides: Partial<ChordSegment> = {}): ChordSegment {
  return { id: 's1', kind: 'chord', duration: 4, root: 'C', quality: 'major', ...overrides };
}

const intervalsOf = (segment: ChordSegment, scale: Scale = C_MAJOR) =>
  segmentChordTones(segment, scale).intervals;

describe('segmentChordTones — back compatibility', () => {
  // The load-bearing guarantee of the whole stack feature: a segment that names no
  // tones must resolve to precisely what it resolved to before tones existed, or
  // every project ever saved sounds different.
  it('reproduces every quality exactly when the segment names no tones', () => {
    for (const quality of Object.keys(CHORD_INTERVALS) as ChordQuality[]) {
      expect(intervalsOf(chord({ quality }))).toEqual(CHORD_INTERVALS[quality]);
    }
  });

  it('sounds every tone of the quality, in order, when none are named', () => {
    expect(segmentTones(chord({ quality: 'major' }), C_MAJOR)).toEqual([0, 1, 2]);
    expect(segmentTones(chord({ quality: 'dominant7' }), C_MAJOR)).toEqual([0, 1, 2, 3]);
  });

  it('falls back to the scale when the segment names only a numeral', () => {
    const ii = chord({ root: undefined, quality: undefined, romanNumeral: 'ii' });
    expect(segmentQuality(ii, C_MAJOR)).toBe('minor');
    expect(intervalsOf(ii)).toEqual([0, 3, 7]);
  });
});

describe('segmentChordTones — stacks', () => {
  it('sounds a single tone', () => {
    expect(intervalsOf(chord({ tones: [0] }))).toEqual([0]);
  });

  it('sounds a third dyad and a fifth dyad from the same chord', () => {
    expect(intervalsOf(chord({ tones: [0, 1] }))).toEqual([0, 4]);
    expect(intervalsOf(chord({ tones: [0, 2] }))).toEqual([0, 7]);
  });

  it('omits a tone from the middle of a stack', () => {
    // A ninth with no fifth — the tones keep their own indices.
    const gapped = chord({ tones: [0, 1, 3, 4] });
    expect(segmentTones(gapped, C_MAJOR)).toEqual([0, 1, 3, 4]);
    expect(intervalsOf(gapped)).toEqual([0, 4, 11, 14]);
  });

  it('spells the ninth the key spells, since no quality names one', () => {
    // I of C major: C E G B D.
    expect(intervalsOf(chord({ tones: [0, 1, 2, 3, 4], romanNumeral: 'I' }))).toEqual([
      0, 4, 7, 11, 14,
    ]);
    // V of C major: G B D F A — a dominant ninth.
    const v = chord({ root: 'G', quality: undefined, romanNumeral: 'V', tones: [0, 1, 2, 3, 4] });
    expect(intervalsOf(v)).toEqual([0, 4, 7, 10, 14]);
  });

  it('gives a pinned major triad on ii the secondary dominant it implies', () => {
    // Pinning Major on ii of C major makes D F# A; the key still spells its
    // seventh (C) and ninth (E), so the stack is D7 and then D9 — V7/V.
    const ii = chord({ root: 'D', quality: 'major', romanNumeral: 'ii', qualityPinned: true });
    expect(intervalsOf({ ...ii, tones: [0, 1, 2, 3] })).toEqual([0, 4, 7, 10]);
    expect(intervalsOf({ ...ii, tones: [0, 1, 2, 3, 4] })).toEqual([0, 4, 7, 10, 14]);
  });

  it('falls back to a default seventh and ninth for a chord on no degree', () => {
    // A chromatic root the scale does not contain has no degree to spell from.
    const chromatic = chord({ root: 'C#', quality: 'major', romanNumeral: undefined });
    expect(degreeOfSegment(chromatic, C_MAJOR)).toBe(-1);
    expect(intervalsOf({ ...chromatic, tones: [0, 1, 2, 3, 4] })).toEqual([0, 4, 7, 11, 14]);

    const chromaticMinor = chord({ root: 'C#', quality: 'minor', romanNumeral: undefined });
    expect(intervalsOf({ ...chromaticMinor, tones: [0, 1, 2, 3, 4] })).toEqual([0, 3, 7, 10, 14]);
  });
});

describe('segmentChordTones — sanitising a hand-edited stack', () => {
  it('sorts, dedupes and clamps the tones it is given', () => {
    expect(segmentTones(chord({ tones: [2, 0, 2] }), C_MAJOR)).toEqual([0, 2]);
    expect(segmentTones(chord({ tones: [0, 9, -3, 1] }), C_MAJOR)).toEqual([0, 1]);
    expect(segmentTones(chord({ tones: [0, 1.7] }), C_MAJOR)).toEqual([0, 1]);
  });

  it('always sounds the root, whatever the file says', () => {
    // Everything keys off the root — baseMidi, inversion, formula capture — so a
    // rootless chord is a voicing, not a stack.
    expect(segmentTones(chord({ tones: [1, 2] }), C_MAJOR)).toEqual([0, 1, 2]);
  });

  it('falls back to the quality when the stack says nothing', () => {
    expect(segmentTones(chord({ tones: [] }), C_MAJOR)).toEqual([0, 1, 2]);
  });
});

describe('the stack always ascends', () => {
  // buildStackedChord only guarantees ascent within one call. Splicing a pinned
  // triad under a scale-derived seventh re-checks nothing, and the gapped scales
  // stack to intervals that are not sevenths and ninths at all.
  const SCALE_TYPES: ScaleType[] = [
    'major',
    'naturalMinor',
    'harmonicMinor',
    'melodicMinor',
    'dorian',
    'phrygian',
    'lydian',
    'mixolydian',
    'locrian',
    'pentatonicMajor',
    'pentatonicMinor',
    'blues',
  ];

  it('holds for every quality on every degree of every scale', () => {
    for (const type of SCALE_TYPES) {
      const scale: Scale = { root: 'C', type };
      const degrees = getScalePitches('C', type).length;
      for (let degree = 0; degree < degrees; degree++) {
        for (const quality of Object.keys(CHORD_INTERVALS) as ChordQuality[]) {
          const info = diatonicChordAt(scale, degree, 3);
          const segment = chord({
            root: info?.root,
            quality,
            romanNumeral: info?.romanNumeral,
            tones: [0, 1, 2, 3, 4],
          });
          const { intervals } = segmentChordTones(segment, scale);
          for (let i = 1; i < intervals.length; i++) {
            expect(
              intervals[i],
              `${type} degree ${degree} ${quality}: ${intervals.join(',')}`
            ).toBeGreaterThan(intervals[i - 1]);
          }
        }
      }
    }
  });
});

describe('buildStackedChord at any width', () => {
  it('stacks a ninth out of a heptatonic scale', () => {
    expect(buildStackedChord(getScalePitches('C', 'major'), 0, 5)).toEqual([0, 4, 7, 11, 14]);
  });

  it('wraps through a scale shorter than the stack', () => {
    // Pentatonic major has five degrees, so a five-note stack uses each one once.
    const stacked = buildStackedChord(getScalePitches('C', 'pentatonicMajor'), 0, 5);
    expect(stacked).toHaveLength(5);
    expect(stacked[0]).toBe(0);
  });
});

describe('diatonicChordAt', () => {
  it('generalises the triad and seventh getters', () => {
    expect(diatonicChordAt(C_MAJOR, 4, 3)).toMatchObject({ root: 'G', quality: 'major' });
    expect(diatonicChordAt(C_MAJOR, 4, 4)).toMatchObject({ root: 'G', quality: 'dominant7' });
    expect(diatonicChordAt(A_MINOR, 0, 4)).toMatchObject({ root: 'A', quality: 'min7' });
  });

  it('has nothing at a degree the scale does not reach', () => {
    expect(diatonicChordAt({ root: 'C', type: 'pentatonicMajor' }, 6, 3)).toBeUndefined();
  });
});
