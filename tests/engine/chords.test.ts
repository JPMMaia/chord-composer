import { describe, it, expect } from 'vitest';
import {
  getDiatonicChords,
  getRomanNumeral,
  chordFromRomanNumeral,
  chordFromSymbol,
  chordToNotes,
} from '@/engine/chords';
import { Scale, NoteName, ChordQuality } from '@/types/music';

describe('chords', () => {
  describe('getDiatonicChords', () => {
    it("returns 7 chords for C major [C, Dm, Em, F, G, Am, Bdim]", () => {
      const scale: Scale = { root: 'C', type: 'major' };
      const chords = getDiatonicChords(scale);
      expect(chords).toHaveLength(7);
      expect(chords[0].root).toBe('C');
      expect(chords[0].quality).toBe('major');
      expect(chords[1].root).toBe('D');
      expect(chords[1].quality).toBe('minor');
      expect(chords[2].root).toBe('E');
      expect(chords[2].quality).toBe('minor');
      expect(chords[3].root).toBe('F');
      expect(chords[3].quality).toBe('major');
      expect(chords[4].root).toBe('G');
      expect(chords[4].quality).toBe('major');
      expect(chords[5].root).toBe('A');
      expect(chords[5].quality).toBe('minor');
      expect(chords[6].root).toBe('B');
      expect(chords[6].quality).toBe('diminished');
    });

    it("returns 7 chords for A minor [Am, Bdim, C, Dm, Em, F, G]", () => {
      const scale: Scale = { root: 'A', type: 'naturalMinor' };
      const chords = getDiatonicChords(scale);
      expect(chords).toHaveLength(7);
      expect(chords[0].root).toBe('A');
      expect(chords[0].quality).toBe('minor');
      expect(chords[1].root).toBe('B');
      expect(chords[1].quality).toBe('diminished');
      expect(chords[2].root).toBe('C');
      expect(chords[2].quality).toBe('major');
      expect(chords[3].root).toBe('D');
      expect(chords[3].quality).toBe('minor');
      expect(chords[4].root).toBe('E');
      expect(chords[4].quality).toBe('minor');
      expect(chords[5].root).toBe('F');
      expect(chords[5].quality).toBe('major');
      expect(chords[6].root).toBe('G');
      expect(chords[6].quality).toBe('major');
    });

    it("returns correct qualities for major scale", () => {
      const scale: Scale = { root: 'G', type: 'major' };
      const chords = getDiatonicChords(scale);
      const expectedQualities: ChordQuality[] = ['major', 'minor', 'minor', 'major', 'major', 'minor', 'diminished'];
      chords.forEach((chord, i) => {
        expect(chord.quality).toBe(expectedQualities[i]);
      });
    });

    it("returns correct qualities for minor scale", () => {
      const scale: Scale = { root: 'D', type: 'naturalMinor' };
      const chords = getDiatonicChords(scale);
      const expectedQualities: ChordQuality[] = ['minor', 'diminished', 'major', 'minor', 'minor', 'major', 'major'];
      chords.forEach((chord, i) => {
        expect(chord.quality).toBe(expectedQualities[i]);
      });
    });
  });

  describe('getRomanNumeral', () => {
    it("returns 'I' for C major in C major", () => {
      expect(getRomanNumeral('C', 'major', { root: 'C', type: 'major' })).toBe('I');
    });

    it("returns 'ii' for D minor in C major", () => {
      expect(getRomanNumeral('D', 'minor', { root: 'C', type: 'major' })).toBe('ii');
    });

    it("returns 'V' for G major in C major", () => {
      expect(getRomanNumeral('G', 'major', { root: 'C', type: 'major' })).toBe('V');
    });

    it("returns 'vi' for A minor in C major", () => {
      expect(getRomanNumeral('A', 'minor', { root: 'C', type: 'major' })).toBe('vi');
    });

    it("returns 'i' for A minor in A minor", () => {
      expect(getRomanNumeral('A', 'minor', { root: 'A', type: 'naturalMinor' })).toBe('i');
    });

    it("returns 'III' for C major in A minor", () => {
      expect(getRomanNumeral('C', 'major', { root: 'A', type: 'naturalMinor' })).toBe('III');
    });
  });

  describe('chordFromRomanNumeral', () => {
    it("returns {root: 'C', quality: 'major'} for 'I' in C major", () => {
      const result = chordFromRomanNumeral('I', { root: 'C', type: 'major' });
      expect(result.root).toBe('C');
      expect(result.quality).toBe('major');
    });

    it("returns {root: 'D', quality: 'minor'} for 'ii' in C major", () => {
      const result = chordFromRomanNumeral('ii', { root: 'C', type: 'major' });
      expect(result.root).toBe('D');
      expect(result.quality).toBe('minor');
    });

    it("returns {root: 'B', quality: 'diminished'} for 'vii°' in C major", () => {
      const result = chordFromRomanNumeral('vii°', { root: 'C', type: 'major' });
      expect(result.root).toBe('B');
      expect(result.quality).toBe('diminished');
    });

    it("throws for invalid roman numeral", () => {
      expect(() => chordFromRomanNumeral('X', { root: 'C', type: 'major' })).toThrow('Invalid');
    });
  });

  describe('chordFromSymbol', () => {
    it("parses 'Cmaj7' into {root: 'C', intervals: [0,4,7,11]}", () => {
      const result = chordFromSymbol('Cmaj7');
      expect(result.root).toBe('C');
      expect(result.intervals).toEqual([0, 4, 7, 11]);
    });

    it("parses 'Dm9' into {root: 'D', intervals: [0,3,7,10,14]}", () => {
      const result = chordFromSymbol('Dm9');
      expect(result.root).toBe('D');
      expect(result.intervals).toEqual([0, 3, 7, 10, 14]);
    });

    it("parses 'G7' into {root: 'G', intervals: [0,4,7,10]}", () => {
      const result = chordFromSymbol('G7');
      expect(result.root).toBe('G');
      expect(result.intervals).toEqual([0, 4, 7, 10]);
    });

    it("parses 'Am' into {root: 'A', intervals: [0,3,7]}", () => {
      const result = chordFromSymbol('Am');
      expect(result.root).toBe('A');
      expect(result.intervals).toEqual([0, 3, 7]);
    });

    it("parses 'C/E' (inversion) into {root: 'C', bass: 'E'}", () => {
      const result = chordFromSymbol('C/E');
      expect(result.root).toBe('C');
      expect(result.bass).toBe('E');
    });

    it("throws for invalid chord symbol", () => {
      expect(() => chordFromSymbol('Xyz')).toThrow('Invalid');
    });
  });

  describe('chordToNotes', () => {
    it("returns MIDI notes for C major triad in octave 4: [60,64,67]", () => {
      const chord = chordFromSymbol('Cmaj7');
      // chordToNotes for a triad should give base intervals, not the full 7th
      // Actually let's test with the major triad intervals [0,4,7]
      const result = chordToNotes({ root: 'C', intervals: [0, 4, 7] }, 4);
      expect(result).toEqual([60, 64, 67]);
    });

    it("returns MIDI notes for Dm in octave 4: [62,65,69]", () => {
      const result = chordToNotes({ root: 'D', intervals: [0, 3, 7] }, 4);
      expect(result).toEqual([62, 65, 69]);
    });

    it("returns inverted chord notes when inversion > 0", () => {
      // C major triad [0,4,7], inversion 1 = [4,7,0] → octave shift for the 0
      const result = chordToNotes({ root: 'C', intervals: [0, 4, 7] }, 4, 1);
      expect(result).toEqual([64, 67, 72]);
    });

    it("throws for invalid quality", () => {
      expect(() => chordToNotes({ root: 'C', intervals: [0, 3] }, 4)).toThrow('Invalid chord intervals');
    });
  });
});
