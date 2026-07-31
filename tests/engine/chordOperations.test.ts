import { describe, it, expect } from "vitest";
import {
  splitBarIntoChords,
  reorderChords,
  generateNotesFromSegments,
  mergeAdjacentChords,
  getChordDuration,
  retuneSegmentsToScale,
} from "@/engine/chordOperations";
import { Bar, Scale, ChordSegment, Note, TimeSignature } from "@/types/music";
import { generateId } from "@/utils/id";

const TS_4_4: TimeSignature = { beatsPerMeasure: 4, beatUnit: 4 };
const TS_3_4: TimeSignature = { beatsPerMeasure: 3, beatUnit: 4 };

/** A bar carrying exactly the given segments. */
const barWith = (chords: ChordSegment[], timeSignature?: TimeSignature): Bar => ({
  id: generateId(),
  barIndex: 0,
  timeSignature,
  scale: { root: "C", type: "major" },
  chords,
  notes: [],
});

// Bar length now comes from the bar's time signature rather than from however
// many placeholder chords happen to be sitting in it.
const makeBar = (barIndex: number, beatsPerMeasure: number): Bar => ({
  id: generateId(),
  barIndex,
  timeSignature: { beatsPerMeasure, beatUnit: 4 },
  scale: { root: "C", type: "major" },
  chords: [],
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

  describe("generateNotesFromSegments", () => {
    it("generates a triad for a chord spanning the bar", () => {
      const bar = barWith([makeChord("I", 4)]);
      const result = generateNotesFromSegments(bar, TS_4_4, 4);
      // C major triad in octave 4: C4, E4, G4 = MIDI 60, 64, 67
      expect(result.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([60, 64, 67]);
    });

    it("lays consecutive chords out at the right start beats", () => {
      const bar = barWith([makeChord("I", 2), makeChord("V", 2)]);
      const result = generateNotesFromSegments(bar, TS_4_4, 4);
      expect(result.filter((n) => n.startBeat === 0)).toHaveLength(3);
      expect(result.filter((n) => n.startBeat === 2)).toHaveLength(3);
    });

    it("gives notes the duration of their chord", () => {
      const bar = barWith([makeChord("I", 2)]);
      generateNotesFromSegments(bar, TS_4_4, 4).forEach((note) => {
        expect(note.duration).toBe(2);
      });
    });

    it("returns an empty array for a bar with no segments", () => {
      expect(generateNotesFromSegments(barWith([]), TS_4_4, 4)).toEqual([]);
    });

    it("does not throw when segments overrun the bar", () => {
      const bar = barWith([makeChord("I", 3), makeChord("V", 3)]);
      expect(() => generateNotesFromSegments(bar, TS_4_4, 4)).not.toThrow();
    });

    it("generates the correct notes for a ii chord (Dm)", () => {
      const bar = barWith([makeChord("ii", 4)]);
      const result = generateNotesFromSegments(bar, TS_4_4, 4);
      // Dm triad: D4, F4, A4 = MIDI 62, 65, 69
      expect(result.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([62, 65, 69]);
    });

    it("generates four notes for a seventh chord", () => {
      const bar = barWith([
        { id: generateId(), kind: "chord", root: "G", quality: "dominant7", duration: 4 },
      ]);
      const result = generateNotesFromSegments(bar, TS_4_4, 4);
      // G7: G4 B4 D5 F5 = 67, 71, 74, 77
      expect(result.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([67, 71, 74, 77]);
    });

    it("generates exactly one note for a note-kind segment", () => {
      const bar = barWith([
        { id: generateId(), kind: "note", pitch: 64, duration: 2 },
      ]);
      const result = generateNotesFromSegments(bar, TS_4_4, 4);
      expect(result).toHaveLength(1);
      expect(result[0].pitch).toBe(64);
      expect(result[0].duration).toBe(2);
      expect(result[0].startBeat).toBe(0);
    });

    it("mixes note and chord segments in one bar", () => {
      const bar = barWith([
        { id: generateId(), kind: "note", pitch: 60, duration: 1 },
        makeChord("V", 1),
      ]);
      const result = generateNotesFromSegments(bar, TS_4_4, 4);
      expect(result.filter((n) => n.startBeat === 0)).toHaveLength(1);
      expect(result.filter((n) => n.startBeat === 1)).toHaveLength(3);
    });

    it("honours the bar's own time signature", () => {
      const bar = barWith([makeChord("I", 1), makeChord("V", 1), makeChord("I", 1)], TS_3_4);
      expect(() => generateNotesFromSegments(bar, TS_4_4, 4)).not.toThrow();
      expect(generateNotesFromSegments(bar, TS_4_4, 4)).toHaveLength(9);
    });

    it("assigns unique IDs to generated notes", () => {
      const bar = barWith([makeChord("I", 4)]);
      const ids = generateNotesFromSegments(bar, TS_4_4, 4).map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("sets velocity to default (100) for all notes", () => {
      const bar = barWith([makeChord("I", 4)]);
      generateNotesFromSegments(bar, TS_4_4, 4).forEach((note) => {
        expect(note.velocity).toBe(100);
      });
    });

    it("places notes at the segment's own start beat", () => {
      const bar = barWith([{ ...makeChord("I", 1), startBeat: 3 }]);
      generateNotesFromSegments(bar, TS_4_4, 4).forEach((note) => {
        expect(note.startBeat).toBe(3);
      });
    });

    it("leaves a gap between segments as silence", () => {
      // I on beat 0, V on beat 2: nothing at all sounds on beat 1.
      const bar = barWith([
        { ...makeChord("I", 1), startBeat: 0 },
        { ...makeChord("V", 1), startBeat: 2 },
      ]);
      const result = generateNotesFromSegments(bar, TS_4_4, 4);
      expect(result.map((n) => n.startBeat).sort()).toEqual([0, 0, 0, 2, 2, 2]);
      expect(result.some((n) => n.startBeat > 0 && n.startBeat < 2)).toBe(false);
    });

    it("skips a segment that starts past the bar line", () => {
      // Refitting owns moving this into the next bar; rendering it here would
      // double it up.
      const bar = barWith([{ ...makeChord("I", 1), startBeat: 4 }]);
      expect(generateNotesFromSegments(bar, TS_4_4, 4)).toEqual([]);
    });

    it("packs positionless segments, as projects saved before free placement meant", () => {
      const bar = barWith([makeChord("I", 2), makeChord("V", 2)]);
      const result = generateNotesFromSegments(bar, TS_4_4, 4);
      expect(result.filter((n) => n.startBeat === 0)).toHaveLength(3);
      expect(result.filter((n) => n.startBeat === 2)).toHaveLength(3);
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

  describe("retuneSegmentsToScale", () => {
    const C_MAJOR: Scale = { root: "C", type: "major" };
    const D_MAJOR: Scale = { root: "D", type: "major" };
    const A_MINOR: Scale = { root: "A", type: "naturalMinor" };

    /** A segment as the palette and splitBarIntoChords actually produce them. */
    const diatonic = (
      overrides: Partial<ChordSegment> = {}
    ): ChordSegment => ({
      id: generateId(),
      kind: "chord",
      duration: 1,
      romanNumeral: "I",
      root: "C",
      quality: "major",
      chordSymbol: "C",
      ...overrides,
    });

    it("moves a tonic triad to the new key", () => {
      const [segment] = retuneSegmentsToScale([diatonic()], C_MAJOR, D_MAJOR);
      expect(segment.root).toBe("D");
      expect(segment.quality).toBe("major");
      expect(segment.chordSymbol).toBe("D");
    });

    it("follows the new scale's quality for the degree", () => {
      const ii = diatonic({ romanNumeral: "ii", root: "D", quality: "minor", chordSymbol: "Dm" });
      const [segment] = retuneSegmentsToScale([ii], C_MAJOR, A_MINOR);
      // Degree 2 of A natural minor is B diminished, not a minor triad.
      expect(segment.root).toBe("B");
      expect(segment.quality).toBe("diminished");
      expect(segment.romanNumeral).toBe("ii°");
    });

    it("retunes a seventh chord as a seventh", () => {
      const maj7 = diatonic({ quality: "maj7", chordSymbol: "Cmaj7" });
      const [segment] = retuneSegmentsToScale([maj7], C_MAJOR, D_MAJOR);
      expect(segment.root).toBe("D");
      expect(segment.quality).toBe("maj7");
      expect(segment.chordSymbol).toBe("Dmaj7");
    });

    it("retunes a note segment to the same degree of the new scale", () => {
      const note: ChordSegment = {
        id: generateId(),
        kind: "note",
        pitch: 60,
        duration: 1,
        root: "C",
        romanNumeral: "I",
      };
      const [segment] = retuneSegmentsToScale([note], C_MAJOR, D_MAJOR);
      expect(segment.pitch).toBe(62);
      expect(segment.root).toBe("D");
    });

    it("keeps a note segment near its original register", () => {
      const note: ChordSegment = {
        id: generateId(),
        kind: "note",
        pitch: 71, // B, degree 7 of C major
        duration: 1,
      };
      const [segment] = retuneSegmentsToScale([note], C_MAJOR, D_MAJOR);
      // Degree 7 of D major is C#: a whole tone up, not ten semitones down.
      expect(segment.pitch).toBe(73);
    });

    it("leaves a chromatic segment with no roman numeral untouched", () => {
      const chromatic = diatonic({ romanNumeral: undefined, root: "Ab", chordSymbol: "Ab" });
      const [segment] = retuneSegmentsToScale([chromatic], C_MAJOR, D_MAJOR);
      expect(segment.root).toBe("Ab");
      expect(segment.chordSymbol).toBe("Ab");
    });

    it("leaves a degree that the new scale does not have", () => {
      const vi = diatonic({ romanNumeral: "vi", root: "A", quality: "minor", chordSymbol: "Am" });
      const [segment] = retuneSegmentsToScale([vi], C_MAJOR, {
        root: "C",
        type: "pentatonicMajor",
      });
      expect(segment.root).toBe("A");
      expect(segment.chordSymbol).toBe("Am");
    });

    it("returns the same segments when the scale is unchanged", () => {
      const segments = [diatonic(), diatonic({ romanNumeral: "V", root: "G", chordSymbol: "G" })];
      const result = retuneSegmentsToScale(segments, C_MAJOR, C_MAJOR);
      expect(result.map(s => s.chordSymbol)).toEqual(["C", "G"]);
    });

    it("preserves segment ids and durations", () => {
      const segment = diatonic({ id: "keep-me", duration: 2.5 });
      const [result] = retuneSegmentsToScale([segment], C_MAJOR, D_MAJOR);
      expect(result.id).toBe("keep-me");
      expect(result.duration).toBe(2.5);
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
