import { describe, it, expect } from 'vitest';
import {
  getScaleIntervals,
  getScalePitches,
  isNoteInScale,
  getNotesInOctave,
  getScaleName,
  degreeOffsetFromTonic,
  degreeRegisterShift,
  octaveForDegree,
} from '@/engine/scales';
import { MAX_SEGMENT_OCTAVE } from '@/utils/constants';
import { NoteName, ScaleType, Scale } from '@/types/music';

describe('scales', () => {
  describe('getScaleIntervals', () => {
    it("returns major scale intervals [0,2,4,5,7,9,11]", () => {
      expect(getScaleIntervals('major')).toEqual([0, 2, 4, 5, 7, 9, 11]);
    });

    it("returns natural minor scale intervals [0,2,3,5,7,8,10]", () => {
      expect(getScaleIntervals('naturalMinor')).toEqual([0, 2, 3, 5, 7, 8, 10]);
    });

    it("returns harmonic minor scale intervals [0,2,3,5,7,8,11]", () => {
      expect(getScaleIntervals('harmonicMinor')).toEqual([0, 2, 3, 5, 7, 8, 11]);
    });

    it("returns dorian scale intervals [0,2,3,5,7,9,10]", () => {
      expect(getScaleIntervals('dorian')).toEqual([0, 2, 3, 5, 7, 9, 10]);
    });

    it("returns pentatonic major intervals [0,2,4,7,9]", () => {
      expect(getScaleIntervals('pentatonicMajor')).toEqual([0, 2, 4, 7, 9]);
    });

    it("returns pentatonic minor intervals [0,3,5,7,10]", () => {
      expect(getScaleIntervals('pentatonicMinor')).toEqual([0, 3, 5, 7, 10]);
    });

    it("returns blues intervals [0,3,5,6,7,10]", () => {
      expect(getScaleIntervals('blues')).toEqual([0, 3, 5, 6, 7, 10]);
    });
  });

  describe('getScalePitches', () => {
    it("returns C major pitches [0,2,4,5,7,9,11] for root 'C'", () => {
      expect(getScalePitches('C', 'major')).toEqual([0, 2, 4, 5, 7, 9, 11]);
    });

    it("returns C# major pitches shifted by 1 semitone", () => {
      expect(getScalePitches('C#', 'major')).toEqual([0, 2, 4, 5, 7, 9, 11].map(p => (p + 1) % 12));
    });

    it("returns Eb major pitches correctly (flat handling)", () => {
      // Eb = 3 semitones from C
      const expected = [0, 2, 4, 5, 7, 9, 11].map(p => (p + 3) % 12);
      expect(getScalePitches('Eb' as NoteName, 'major')).toEqual(expected);
    });

    it("returns A minor pitches [9,11,0,2,4,5,7] for root 'A'", () => {
      // A minor: A=9, B=11, C=0, D=2, E=4, F=5, G=7
      expect(getScalePitches('A', 'naturalMinor')).toEqual([9, 11, 0, 2, 4, 5, 7]);
    });

    it("throws on invalid scale type", () => {
      expect(() => getScalePitches('C', 'invalid' as ScaleType)).toThrow('Invalid scale type');
    });

    it("throws on invalid root note", () => {
      expect(() => getScalePitches('X' as NoteName, 'major')).toThrow('Invalid root note');
    });
  });

  describe('isNoteInScale', () => {
    it("returns true for C in C major", () => {
      expect(isNoteInScale(0, { root: 'C', type: 'major' })).toBe(true);
    });

    it("returns false for C# in C major", () => {
      expect(isNoteInScale(1, { root: 'C', type: 'major' })).toBe(false);
    });

    it("returns true for A in C major", () => {
      expect(isNoteInScale(9, { root: 'C', type: 'major' })).toBe(true);
    });

    it("returns false for B in A minor", () => {
      // B = 11, A minor pitches: [9,11,0,2,4,5,7]
      // Actually B=11 IS in A minor. Let's use C# instead
      expect(isNoteInScale(1, { root: 'A', type: 'naturalMinor' })).toBe(false);
    });
  });

  describe('getNotesInOctave', () => {
    it("returns all C-major notes in octave 4 (MIDI 48-60)", () => {
      const notes = getNotesInOctave({ root: 'C', type: 'major' }, 4, 4);
      // C4=60, D4=62, E4=64, F4=65, G4=67, A4=69, B4=71
      // But we only want MIDI 48-60 (octave 4)
      expect(notes).toEqual([60, 62, 64, 65, 67, 69, 71]);
    });

    it("returns all C-major notes in octaves 2-5", () => {
      const notes = getNotesInOctave({ root: 'C', type: 'major' }, 2, 5);
      // Octave 2: C2=36, D2=38, E2=40, F2=41, G2=43, A2=45, B2=47
      // Octave 3: C3=48, D3=50, E3=52, F3=53, G3=55, A3=57, B3=59
      // Octave 4: C4=60, D4=62, E4=64, F4=65, G4=67, A4=69, B4=71
      // Octave 5: C5=72, D5=74, E5=76, F5=77, G5=79, A5=81, B5=83
      const expected = [
        36, 38, 40, 41, 43, 45, 47,
        48, 50, 52, 53, 55, 57, 59,
        60, 62, 64, 65, 67, 69, 71,
        72, 74, 76, 77, 79, 81, 83,
      ];
      expect(notes).toEqual(expected);
    });

    it("respects minOctave and maxOctave parameters", () => {
      const notes = getNotesInOctave({ root: 'C', type: 'major' }, 3, 3);
      // Only octave 3: C3=48 through B3=59
      expect(notes).toEqual([48, 50, 52, 53, 55, 57, 59]);
    });
  });

  describe('degreeOffsetFromTonic', () => {
    const D_MAJOR: Scale = { root: 'D', type: 'major' };

    it("measures a degree upward from the tonic", () => {
      // D major: D E F# G A B C#
      const offsets = getScalePitches('D', 'major').map(p => degreeOffsetFromTonic(D_MAJOR, p));
      expect(offsets).toEqual([0, 2, 4, 5, 7, 9, 11]);
    });

    it("reads a wrapped pitch class as high, not negative", () => {
      // C# is a semitone below D on the chromatic circle, but the seventh degree
      // of the scale — eleven semitones above the tonic.
      expect(degreeOffsetFromTonic(D_MAJOR, 1)).toBe(11);
    });
  });

  describe('degreeRegisterShift', () => {
    it("keeps every degree of C major in one register", () => {
      const scale: Scale = { root: 'C', type: 'major' };
      const shifts = getScalePitches('C', 'major').map(p => degreeRegisterShift(scale, p));
      expect(shifts).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it("lifts only the degrees that cross C", () => {
      const scale: Scale = { root: 'A', type: 'naturalMinor' };
      // A B | C D E F G — the run crosses the octave line at the third degree.
      const shifts = getScalePitches('A', 'naturalMinor').map(p => degreeRegisterShift(scale, p));
      expect(shifts).toEqual([0, 0, 1, 1, 1, 1, 1]);
    });
  });

  describe('octaveForDegree', () => {
    const D_MAJOR: Scale = { root: 'D', type: 'major' };

    it("voices D major at octave 4 as D4 ... B4 C#5", () => {
      const octaves = getScalePitches('D', 'major').map(p => octaveForDegree(D_MAJOR, p, 4));
      expect(octaves).toEqual([4, 4, 4, 4, 4, 4, 5]);
    });

    it("leaves a C-rooted scale entirely in the chosen octave", () => {
      const scale: Scale = { root: 'C', type: 'major' };
      const octaves = getScalePitches('C', 'major').map(p => octaveForDegree(scale, p, 3));
      expect(octaves).toEqual([3, 3, 3, 3, 3, 3, 3]);
    });

    it("carries A minor's upper degrees into the next octave", () => {
      const scale: Scale = { root: 'A', type: 'naturalMinor' };
      const octaves = getScalePitches('A', 'naturalMinor').map(p => octaveForDegree(scale, p, 4));
      expect(octaves).toEqual([4, 4, 5, 5, 5, 5, 5]);
    });

    it("clamps at the top register rather than leaving the roll", () => {
      // C# would want octave 8; the highest a segment may hold is 7.
      expect(octaveForDegree(D_MAJOR, 1, MAX_SEGMENT_OCTAVE)).toBe(MAX_SEGMENT_OCTAVE);
    });
  });

  describe('getScaleName', () => {
    it("returns 'C Major' for root 'C', type 'major'", () => {
      expect(getScaleName('C', 'major')).toBe('C Major');
    });

    it("returns 'Eb Minor' for root 'Eb', type 'naturalMinor'", () => {
      expect(getScaleName('Eb' as NoteName, 'naturalMinor')).toBe('Eb Minor');
    });

    it("handles 'C#' root correctly", () => {
      expect(getScaleName('C#', 'major')).toBe('C# Major');
    });
  });
});
