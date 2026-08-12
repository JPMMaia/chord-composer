import { describe, it, expect } from 'vitest';
import {
  getDiatonicChords,
  getDiatonicSevenths,
  buildStackedChord,
  classifyIntervals,
  CHORD_INTERVALS,
  getRomanNumeral,
  chordFromRomanNumeral,
  chordFromSymbol,
  chordToNotes,
  detectChord,
  invertIntervals,
  midiToOctave,
  midiToNoteLabel,
} from '@/engine/chords';
import { getScalePitches } from '@/engine/scales';
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

  describe('buildStackedChord', () => {
    it('stacks thirds within the scale for a C major triad', () => {
      const pitches = getScalePitches('C', 'major'); // [0,2,4,5,7,9,11]
      expect(buildStackedChord(pitches, 0, 3)).toEqual([0, 4, 7]);
    });

    it('stacks thirds for the ii chord (D minor)', () => {
      const pitches = getScalePitches('C', 'major');
      expect(buildStackedChord(pitches, 1, 3)).toEqual([0, 3, 7]);
    });

    it('wraps past the octave for the vii chord (B diminished)', () => {
      const pitches = getScalePitches('C', 'major');
      expect(buildStackedChord(pitches, 6, 3)).toEqual([0, 3, 6]);
    });

    it('builds four-note stacks for sevenths', () => {
      const pitches = getScalePitches('C', 'major');
      expect(buildStackedChord(pitches, 0, 4)).toEqual([0, 4, 7, 11]); // Cmaj7
      expect(buildStackedChord(pitches, 4, 4)).toEqual([0, 4, 7, 10]); // G7
      expect(buildStackedChord(pitches, 6, 4)).toEqual([0, 3, 6, 10]); // Bm7b5
    });
  });

  describe('classifyIntervals', () => {
    it('identifies each known quality', () => {
      (Object.keys(CHORD_INTERVALS) as ChordQuality[]).forEach(quality => {
        expect(classifyIntervals(CHORD_INTERVALS[quality])).toBe(quality);
      });
    });

    it('returns undefined for an unrecognised interval set', () => {
      expect(classifyIntervals([0, 1, 2])).toBeUndefined();
    });
  });

  describe('getDiatonicSevenths', () => {
    it('returns the seven diatonic sevenths of C major', () => {
      const chords = getDiatonicSevenths({ root: 'C', type: 'major' });
      expect(chords).toHaveLength(7);
      expect(chords.map(c => c.root)).toEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B']);
      expect(chords.map(c => c.quality)).toEqual([
        'maj7', 'min7', 'min7', 'maj7', 'dominant7', 'min7', 'halfDim7',
      ]);
    });

    it('returns the seven diatonic sevenths of A natural minor', () => {
      const chords = getDiatonicSevenths({ root: 'A', type: 'naturalMinor' });
      expect(chords.map(c => c.root)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
      expect(chords.map(c => c.quality)).toEqual([
        'min7', 'halfDim7', 'maj7', 'min7', 'min7', 'maj7', 'dominant7',
      ]);
    });

    it('produces a minMaj7 tonic in harmonic minor', () => {
      const chords = getDiatonicSevenths({ root: 'A', type: 'harmonicMinor' });
      expect(chords[0].quality).toBe('minMaj7');
      expect(chords[6].quality).toBe('dim7');
    });

    it('carries roman numerals matching the triad casing', () => {
      const chords = getDiatonicSevenths({ root: 'C', type: 'major' });
      expect(chords.map(c => c.romanNumeral)).toEqual([
        'I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°',
      ]);
    });
  });

  describe('getDiatonicChords for non-heptatonic scales', () => {
    it('returns one chord per pitch for a 5-note pentatonic scale', () => {
      const chords = getDiatonicChords({ root: 'C', type: 'pentatonicMajor' });
      expect(chords).toHaveLength(5);
      chords.forEach(chord => {
        expect(chord.root).toBeDefined();
        expect(chord.romanNumeral).toBeString();
      });
    });

    it('returns one chord per pitch for the 6-note blues scale', () => {
      const chords = getDiatonicChords({ root: 'C', type: 'blues' });
      expect(chords).toHaveLength(6);
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

  describe('invertIntervals', () => {
    it("leaves a chord in root position alone", () => {
      expect(invertIntervals([0, 4, 7], 0)).toEqual([0, 4, 7]);
    });

    it("lifts the root an octave for the first inversion", () => {
      expect(invertIntervals([0, 4, 7], 1)).toEqual([4, 7, 12]);
    });

    it("lifts the root and third for the second inversion", () => {
      expect(invertIntervals([0, 4, 7], 2)).toEqual([7, 12, 16]);
    });

    it("takes a seventh chord through its third inversion", () => {
      expect(invertIntervals([0, 4, 7, 10], 3)).toEqual([10, 12, 16, 19]);
    });

    it("returns to root position after a full cycle, an octave up", () => {
      expect(invertIntervals([0, 4, 7], 3)).toEqual([12, 16, 19]);
    });

    it("does not mutate the intervals it is given", () => {
      const intervals = [0, 4, 7];
      invertIntervals(intervals, 2);
      expect(intervals).toEqual([0, 4, 7]);
    });
  });

  describe('midiToOctave', () => {
    it("puts middle C in octave 4", () => {
      expect(midiToOctave(60)).toBe(4);
    });

    it("keeps a whole octave together: B3 is still octave 3", () => {
      expect(midiToOctave(59)).toBe(3);
      expect(midiToOctave(48)).toBe(3);
    });

    it("covers the roll's range ends", () => {
      expect(midiToOctave(21)).toBe(0);
      expect(midiToOctave(108)).toBe(8);
    });
  });

  describe('midiToNoteLabel', () => {
    it("names middle C", () => {
      expect(midiToNoteLabel(60)).toBe('C4');
    });

    it("spells black keys with sharps", () => {
      expect(midiToNoteLabel(61)).toBe('C#4');
      expect(midiToNoteLabel(70)).toBe('A#4');
    });

    it("names the lowest and highest keys of an 88-key piano", () => {
      expect(midiToNoteLabel(21)).toBe('A0');
      expect(midiToNoteLabel(108)).toBe('C8');
    });
  });

  describe('detectChord', () => {
    it("names a root-position triad in the register it sounds", () => {
      expect(detectChord([60, 64, 67])).toEqual({
        root: 'C',
        quality: 'major',
        inversion: 0,
        octave: 4,
      });
    });

    it("hears a first inversion as the same chord with the third in the bass", () => {
      // E4 G4 C5 — the root is C, sounding above a bass that is not it.
      expect(detectChord([64, 67, 72])).toEqual({
        root: 'C',
        quality: 'major',
        inversion: 1,
        octave: 4,
      });
    });

    it("recovers the register from the bass, not from the lowest chord tone", () => {
      // C major with the third in the bass an octave down: E3 G3 C4.
      expect(detectChord([52, 55, 60])).toEqual({
        root: 'C',
        quality: 'major',
        inversion: 1,
        octave: 3,
      });
    });

    it("ignores octave doublings and voicing order", () => {
      expect(detectChord([67, 60, 64, 72, 79])).toEqual({
        root: 'C',
        quality: 'major',
        inversion: 0,
        octave: 4,
      });
    });

    it("names a seventh chord", () => {
      // B3 D4 F4 A4 — the half-diminished seventh on B.
      expect(detectChord([59, 62, 65, 69])).toMatchObject({
        root: 'B',
        quality: 'halfDim7',
        inversion: 0,
      });
    });

    it("resolves a symmetric dim7 to the chord its bass implies", () => {
      // Every note of a dim7 could be the root; the bass is what decides.
      expect(detectChord([60, 63, 66, 69])).toMatchObject({ root: 'C', quality: 'dim7' });
      expect(detectChord([63, 66, 69, 72])).toMatchObject({ root: 'D#', quality: 'dim7' });
    });

    it("names nothing for a cluster that spells no chord", () => {
      expect(detectChord([60, 62, 64])).toBeUndefined();
    });

    it("names nothing for fewer than three pitch classes or more than four", () => {
      expect(detectChord([60])).toBeUndefined();
      expect(detectChord([60, 67])).toBeUndefined();
      expect(detectChord([60, 72])).toBeUndefined();
      expect(detectChord([60, 62, 64, 65, 67])).toBeUndefined();
    });

    it("names nothing at all for no pitches", () => {
      expect(detectChord([])).toBeUndefined();
    });

    it("keeps the register inside the range a segment can carry", () => {
      // C0 E0 G0 sits below MIN_SEGMENT_OCTAVE, which a segment cannot express.
      expect(detectChord([12, 16, 19])?.octave).toBe(1);
    });
  });
});
