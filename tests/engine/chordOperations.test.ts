import { describe, it, expect } from "vitest";
import {
  splitBarIntoChords,
  reorderChords,
  autoFillNotesFromChords,
  mergeAdjacentChords,
  getChordDuration,
} from "@/engine/chordOperations";
import { Bar, Scale, ChordSegment, Note } from "@/types/music";
import { generateId } from "@/utils/id";

const makeBar = (barIndex: number, beatsPerMeasure: number): Bar => ({
  id: generateId(),
  barIndex,
  scale: { root: "C", type: "major" },
  // Pre-populate with placeholder chords to set bar length
  chords: Array.from({ length: beatsPerMeasure }, () => ({
    id: generateId(),
    romanNumeral: "I",
    duration: 1,
  })),
  notes: [],
});

const makeChord = (
  roman: string,
  duration: number,
  chordSymbol?: string
): ChordSegment => ({
  id: generateId(),
  romanNumeral: roman,
  chordSymbol,
  duration,
});

describe("chordOperations", () => {
  describe("splitBarIntoChords", () => {
    it("splits a 4/4 bar into 4 quarter-note chords", () => {
      const bar = makeBar(0, 4);
      const result = splitBarIntoChords(bar, 4);
      expect(result).toHaveLength(4);
      result.forEach((chord) => {
        expect(chord.duration).toBe(1);
      });
    });

    it("splits a 4/4 bar into 2 half-note chords", () => {
      const bar = makeBar(0, 4);
      const result = splitBarIntoChords(bar, 2);
      expect(result).toHaveLength(2);
      result.forEach((chord) => {
        expect(chord.duration).toBe(2);
      });
    });

    it("splits a 3/4 bar into 3 quarter-note chords", () => {
      const bar = makeBar(0, 3);
      const result = splitBarIntoChords(bar, 3);
      expect(result).toHaveLength(3);
      result.forEach((chord) => {
        expect(chord.duration).toBe(1);
      });
    });

    it("preserves total duration equals bar length", () => {
      const bar = makeBar(0, 4);
      const result = splitBarIntoChords(bar, 3);
      const totalDuration = result.reduce((sum, c) => sum + c.duration, 0);
      expect(totalDuration).toBe(4);
    });

    it("throws if chordCount is less than 1", () => {
      const bar = makeBar(0, 4);
      expect(() => splitBarIntoChords(bar, 0)).toThrow();
      expect(() => splitBarIntoChords(bar, -1)).toThrow();
    });

    it("throws if chordCount exceeds bar beats", () => {
      const bar = makeBar(0, 4);
      expect(() => splitBarIntoChords(bar, 5)).toThrow();
    });

    it("assigns diatonic chord symbols based on bar scale", () => {
      const bar = makeBar(0, 4);
      const result = splitBarIntoChords(bar, 4);
      // Should assign I, ii, iii, IV for C major
      expect(result[0].romanNumeral).toBe("I");
      expect(result[1].romanNumeral).toBe("ii");
      expect(result[2].romanNumeral).toBe("iii");
      expect(result[3].romanNumeral).toBe("IV");
    });

    it("assigns correct romans for minor scale", () => {
      const bar: Bar = {
        ...makeBar(0, 4),
        scale: { root: "A", type: "naturalMinor" },
      };
      const result = splitBarIntoChords(bar, 4);
      expect(result[0].romanNumeral).toBe("i");
      expect(result[1].romanNumeral).toBe("ii°");
      expect(result[2].romanNumeral).toBe("III");
      expect(result[3].romanNumeral).toBe("iv");
    });

    it("generates unique IDs for each chord", () => {
      const bar = makeBar(0, 4);
      const result = splitBarIntoChords(bar, 4);
      const ids = result.map((c) => c.id);
      expect(new Set(ids).size).toBe(4);
    });
  });

  describe("reorderChords", () => {
    it("reorders chords from index 0 to index 2", () => {
      const chords = [
        makeChord("I", 1),
        makeChord("ii", 1),
        makeChord("iii", 1),
        makeChord("IV", 1),
      ];
      const result = reorderChords(chords, 0, 2);
      expect(result[0].romanNumeral).toBe("ii");
      expect(result[1].romanNumeral).toBe("iii");
      expect(result[2].romanNumeral).toBe("I");
      expect(result[3].romanNumeral).toBe("IV");
    });

    it("reorders chords from index 2 to index 0", () => {
      const chords = [
        makeChord("I", 1),
        makeChord("ii", 1),
        makeChord("iii", 1),
        makeChord("IV", 1),
      ];
      const result = reorderChords(chords, 2, 0);
      expect(result[0].romanNumeral).toBe("iii");
      expect(result[1].romanNumeral).toBe("I");
      expect(result[2].romanNumeral).toBe("ii");
      expect(result[3].romanNumeral).toBe("IV");
    });

    it("returns same array when fromIndex === toIndex", () => {
      const chords = [makeChord("I", 1), makeChord("ii", 1)];
      const result = reorderChords(chords, 0, 0);
      expect(result).toEqual(chords);
    });

    it("throws for out-of-bounds fromIndex", () => {
      const chords = [makeChord("I", 1), makeChord("ii", 1)];
      expect(() => reorderChords(chords, 5, 0)).toThrow();
      expect(() => reorderChords(chords, -1, 0)).toThrow();
    });

    it("throws for out-of-bounds toIndex", () => {
      const chords = [makeChord("I", 1), makeChord("ii", 1)];
      expect(() => reorderChords(chords, 0, 5)).toThrow();
    });

    it("preserves all chords after reordering", () => {
      const chords = [
        makeChord("I", 1),
        makeChord("ii", 1),
        makeChord("iii", 1),
      ];
      const result = reorderChords(chords, 0, 2);
      expect(result).toHaveLength(3);
      const romans = result.map((c) => c.romanNumeral).sort();
      expect(romans).toEqual(["I", "ii", "iii"]);
    });
  });

  describe("autoFillNotesFromChords", () => {
    it("fills notes for a single chord spanning the bar", () => {
      const bar = makeBar(0, 4);
      const chords = [makeChord("I", 4)];
      const result = autoFillNotesFromChords(bar, chords, 4);
      expect(result.length).toBeGreaterThan(0);
      // C major triad in octave 4: C4, E4, G4 = MIDI 60, 64, 67
      expect(result.some((n) => n.pitch === 60)).toBe(true);
      expect(result.some((n) => n.pitch === 64)).toBe(true);
      expect(result.some((n) => n.pitch === 67)).toBe(true);
    });

    it("fills notes for multiple chords with correct timing", () => {
      const bar = makeBar(0, 4);
      const chords = [makeChord("I", 2), makeChord("V", 2)];
      const result = autoFillNotesFromChords(bar, chords, 4);
      // First chord (I = C major) should start at beat 0
      // Second chord (V = G major) should start at beat 2
      const firstChordNotes = result.filter((n) => n.startBeat < 2);
      const secondChordNotes = result.filter((n) => n.startBeat >= 2);
      expect(firstChordNotes.length).toBeGreaterThan(0);
      expect(secondChordNotes.length).toBeGreaterThan(0);
    });

    it("notes have correct duration matching chord duration", () => {
      const bar = makeBar(0, 4);
      const chords = [makeChord("I", 2)];
      const result = autoFillNotesFromChords(bar, chords, 4);
      result.forEach((note) => {
        expect(note.duration).toBe(2);
      });
    });

    it("throws for empty chords array", () => {
      const bar = makeBar(0, 4);
      expect(() => autoFillNotesFromChords(bar, [], 4)).toThrow();
    });

    it("throws if total chord duration exceeds bar length", () => {
      const bar = makeBar(0, 4);
      const chords = [makeChord("I", 3), makeChord("V", 3)];
      expect(() => autoFillNotesFromChords(bar, chords, 4)).toThrow();
    });

    it("fills correct notes for ii chord (Dm)", () => {
      const bar = makeBar(0, 4);
      const chords = [makeChord("ii", 4)];
      const result = autoFillNotesFromChords(bar, chords, 4);
      // Dm triad: D4, F4, A4 = MIDI 62, 65, 69
      expect(result.some((n) => n.pitch === 62)).toBe(true);
      expect(result.some((n) => n.pitch === 65)).toBe(true);
      expect(result.some((n) => n.pitch === 69)).toBe(true);
    });

    it("assigns unique IDs to generated notes", () => {
      const bar = makeBar(0, 4);
      const chords = [makeChord("I", 4)];
      const result = autoFillNotesFromChords(bar, chords, 4);
      const ids = result.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("sets velocity to default (100) for all notes", () => {
      const bar = makeBar(0, 4);
      const chords = [makeChord("I", 4)];
      const result = autoFillNotesFromChords(bar, chords, 4);
      result.forEach((note) => {
        expect(note.velocity).toBe(100);
      });
    });
  });

  describe("mergeAdjacentChords", () => {
    it("merges two adjacent chords with same roman numeral", () => {
      const chords = [
        makeChord("I", 2),
        makeChord("I", 2),
      ];
      const result = mergeAdjacentChords(chords);
      expect(result).toHaveLength(1);
      expect(result[0].duration).toBe(4);
    });

    it("merges three adjacent chords with same roman numeral", () => {
      const chords = [
        makeChord("I", 1),
        makeChord("I", 1),
        makeChord("I", 2),
      ];
      const result = mergeAdjacentChords(chords);
      expect(result).toHaveLength(1);
      expect(result[0].duration).toBe(4);
    });

    it("does not merge chords with different romans", () => {
      const chords = [
        makeChord("I", 2),
        makeChord("V", 2),
      ];
      const result = mergeAdjacentChords(chords);
      expect(result).toHaveLength(2);
    });

    it("does not merge non-adjacent same chords", () => {
      const chords = [
        makeChord("I", 2),
        makeChord("V", 2),
        makeChord("I", 2),
      ];
      const result = mergeAdjacentChords(chords);
      expect(result).toHaveLength(3);
    });

    it("returns empty array for empty input", () => {
      const result = mergeAdjacentChords([]);
      expect(result).toEqual([]);
    });

    it("returns single chord for single input", () => {
      const chords = [makeChord("I", 4)];
      const result = mergeAdjacentChords(chords);
      expect(result).toHaveLength(1);
      expect(result[0].duration).toBe(4);
    });

    it("preserves chordSymbol when merging", () => {
      const chords = [
        makeChord("I", 2, "Cmaj7"),
        makeChord("I", 2, "Cmaj7"),
      ];
      const result = mergeAdjacentChords(chords);
      expect(result[0].chordSymbol).toBe("Cmaj7");
    });
  });

  describe("getChordDuration", () => {
    it("returns chord duration for quarter note (1)", () => {
      const chord = makeChord("I", 1);
      expect(getChordDuration(chord, 4)).toBe(1);
    });

    it("returns chord duration for half note (2)", () => {
      const chord = makeChord("I", 2);
      expect(getChordDuration(chord, 4)).toBe(2);
    });

    it("returns chord duration for whole note (4)", () => {
      const chord = makeChord("I", 4);
      expect(getChordDuration(chord, 4)).toBe(4);
    });

    it("returns chord duration in 3/4 time", () => {
      const chord = makeChord("I", 1);
      expect(getChordDuration(chord, 3)).toBe(1);
    });

    it("handles dotted note durations", () => {
      const chord = makeChord("I", 1.5);
      expect(getChordDuration(chord, 4)).toBe(1.5);
    });
  });
});
