import { describe, it, expect } from 'vitest';
import { nameSegment } from '@/engine/palette';
import { mergeAdjacentChords } from '@/engine/chordOperations';
import type { ChordSegment, Scale } from '@/types/music';

const C_MAJOR: Scale = { root: 'C', type: 'major' };
const A_MINOR: Scale = { root: 'A', type: 'naturalMinor' };

function chord(overrides: Partial<ChordSegment> = {}): ChordSegment {
  return { id: 's1', kind: 'chord', duration: 4, root: 'C', romanNumeral: 'I', ...overrides };
}

const name = (overrides: Partial<ChordSegment>, scale: Scale = C_MAJOR) =>
  nameSegment(chord(overrides), scale);

describe('naming a stack', () => {
  it('names a single tone as its note', () => {
    expect(name({ quality: 'major', tones: [0] })).toEqual({
      chordSymbol: 'C',
      romanNumeral: 'I',
    });
  });

  it('names the power dyad the way everybody reads it', () => {
    expect(name({ quality: 'major', tones: [0, 2] })).toEqual({
      chordSymbol: 'C5',
      romanNumeral: 'I5',
    });
  });

  it('names a third dyad by the fifth it is missing', () => {
    expect(name({ quality: 'major', tones: [0, 1] })).toEqual({
      chordSymbol: 'C(no5)',
      romanNumeral: 'I(no5)',
    });
    expect(name({ root: 'D', romanNumeral: 'ii', quality: 'minor', tones: [0, 1] })).toEqual({
      chordSymbol: 'Dm(no5)',
      romanNumeral: 'ii(no5)',
    });
  });

  it('leaves a triad and a seventh named exactly as they were', () => {
    expect(name({ quality: 'major', tones: [0, 1, 2] })).toEqual({
      chordSymbol: 'C',
      romanNumeral: 'I',
    });
    expect(name({ quality: 'maj7', tones: [0, 1, 2, 3] })).toEqual({
      chordSymbol: 'Cmaj7',
      romanNumeral: 'Imaj7',
    });
    expect(
      name({ root: 'G', romanNumeral: 'V', quality: 'dominant7', tones: [0, 1, 2, 3] })
    ).toEqual({ chordSymbol: 'G7', romanNumeral: 'V7' });
    expect(
      name({ root: 'B', romanNumeral: 'vii°', quality: 'halfDim7', tones: [0, 1, 2, 3] })
    ).toEqual({ chordSymbol: 'Bø7', romanNumeral: 'viiø7' });
  });

  it('names a ninth by the seventh beneath it', () => {
    expect(name({ quality: 'maj7', tones: [0, 1, 2, 3, 4] })).toEqual({
      chordSymbol: 'Cmaj9',
      romanNumeral: 'Imaj9',
    });
    expect(
      name({ root: 'G', romanNumeral: 'V', quality: 'dominant7', tones: [0, 1, 2, 3, 4] })
    ).toEqual({ chordSymbol: 'G9', romanNumeral: 'V9' });
    expect(
      name({ root: 'D', romanNumeral: 'ii', quality: 'min7', tones: [0, 1, 2, 3, 4] })
    ).toEqual({ chordSymbol: 'Dm9', romanNumeral: 'ii9' });
  });

  it('spells out every tone the stack skips', () => {
    expect(
      name({ root: 'G', romanNumeral: 'V', quality: 'dominant7', tones: [0, 1, 3, 4] })
    ).toEqual({ chordSymbol: 'G9(no5)', romanNumeral: 'V9(no5)' });
    expect(
      name({ root: 'G', romanNumeral: 'V', quality: 'dominant7', tones: [0, 1, 3] })
    ).toEqual({ chordSymbol: 'G7(no5)', romanNumeral: 'V7(no5)' });
    expect(
      name({ root: 'G', romanNumeral: 'V', quality: 'dominant7', tones: [0, 2, 3, 4] })
    ).toEqual({ chordSymbol: 'G9(no3)', romanNumeral: 'V9(no3)' });
  });

  it('cases a pinned colour by the triad it was pinned to', () => {
    // Pinning Major on ii makes it read II, not ii — the numeral says what sounds.
    expect(
      name({ root: 'D', romanNumeral: 'ii', quality: 'major', qualityPinned: true, tones: [0, 1, 2] })
    ).toEqual({ chordSymbol: 'D', romanNumeral: 'II' });
  });

  it('states an extension its quality cannot name, rather than inventing one', () => {
    // A pinned sus4 has no seventh form in ChordQuality, so the seventh is stated
    // beside the triad instead of widening the union.
    const { chordSymbol } = name({
      root: 'G',
      romanNumeral: 'V',
      quality: 'sus4',
      qualityPinned: true,
      tones: [0, 1, 2, 3],
    });
    expect(chordSymbol).toBe('Gsus4(7)');
  });

  it('follows a minor key', () => {
    expect(name({ root: 'A', romanNumeral: 'i', quality: 'minor', tones: [0, 1, 2] }, A_MINOR)).toEqual(
      { chordSymbol: 'Am', romanNumeral: 'i' }
    );
    expect(name({ root: 'A', romanNumeral: 'i', quality: 'min7', tones: [0, 1, 2, 3, 4] }, A_MINOR))
      .toEqual({ chordSymbol: 'Am9', romanNumeral: 'i9' });
  });
});

describe('the size in the numeral', () => {
  // mergeAdjacentChords fuses neighbours that share a roman numeral. Naming the size
  // into it is the only thing keeping two different chords on one degree apart.
  it('keeps a triad and a ninth on the same degree from fusing', () => {
    const triad = chord({ quality: 'major', tones: [0, 1, 2], duration: 1 });
    const ninth = chord({ id: 's2', quality: 'maj7', tones: [0, 1, 2, 3, 4], duration: 1 });

    const named = [triad, ninth].map(s => ({ ...s, ...nameSegment(s, C_MAJOR) }));
    const merged = mergeAdjacentChords(named);

    expect(merged).toHaveLength(2);
    expect(merged.map(s => s.duration)).toEqual([1, 1]);
  });

  it('still fuses two blocks that really are the same chord', () => {
    const first = chord({ quality: 'major', tones: [0, 1, 2], duration: 1 });
    const second = chord({ id: 's2', quality: 'major', tones: [0, 1, 2], duration: 1 });

    const named = [first, second].map(s => ({ ...s, ...nameSegment(s, C_MAJOR) }));
    const merged = mergeAdjacentChords(named);

    expect(merged).toHaveLength(1);
    expect(merged[0].duration).toBe(2);
  });
});
