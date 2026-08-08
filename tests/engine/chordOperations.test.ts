import { describe, it, expect } from "vitest";
import {
  splitBarIntoChords,
  reorderChords,
  generateNotesFromSegments,
  mergeAdjacentChords,
  getChordDuration,
  retuneSegmentsToScale,
  stepSegmentInScale,
  shiftSegmentOctave,
  cycleSegmentInversion,
  convertSegmentKind,
  currentKind,
} from "@/engine/chordOperations";
import { Bar, Scale, ChordSegment, Note, TimeSignature } from "@/types/music";
import { generateId } from "@/utils/id";
import { barChords } from "@/engine/timeline";
import { soloContent, TEST_TRACK_ID } from "../helpers/tracks";

const TS_4_4: TimeSignature = { beatsPerMeasure: 4, beatUnit: 4 };
const TS_3_4: TimeSignature = { beatsPerMeasure: 3, beatUnit: 4 };

/** The key most of these cases work in — passed in now that bars have none. */
const C_MAJOR: Scale = { root: "C", type: "major" };

/** A bar carrying exactly the given segments. */
const barWith = (chords: ChordSegment[], timeSignature?: TimeSignature): Bar => ({
  id: generateId(),
  barIndex: 0,
  timeSignature,
  content: soloContent(chords),
});

// Bar length now comes from the bar's time signature rather than from however
// many placeholder chords happen to be sitting in it.
const makeBar = (barIndex: number, beatsPerMeasure: number): Bar => ({
  id: generateId(),
  barIndex,
  timeSignature: { beatsPerMeasure, beatUnit: 4 },
  content: soloContent(),
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
      const result = splitBarIntoChords(bar, C_MAJOR, 4);
      expect(result).toHaveLength(4);
      result.forEach((chord) => {
        expect(chord.duration).toBe(1);
      });
    });

    it("splits a 4/4 bar into 2 half-note chords", () => {
      const bar = makeBar(0, 4);
      const result = splitBarIntoChords(bar, C_MAJOR, 2);
      expect(result).toHaveLength(2);
      result.forEach((chord) => {
        expect(chord.duration).toBe(2);
      });
    });

    it("splits a 3/4 bar into 3 quarter-note chords", () => {
      const bar = makeBar(0, 3);
      const result = splitBarIntoChords(bar, C_MAJOR, 3);
      expect(result).toHaveLength(3);
      result.forEach((chord) => {
        expect(chord.duration).toBe(1);
      });
    });

    it("preserves total duration equals bar length", () => {
      const bar = makeBar(0, 4);
      const result = splitBarIntoChords(bar, C_MAJOR, 3);
      const totalDuration = result.reduce((sum, c) => sum + c.duration, 0);
      expect(totalDuration).toBe(4);
    });

    it("voices each degree from the scale's root note", () => {
      const bar = makeBar(0, 4);
      const result = splitBarIntoChords(bar, { root: "D", type: "major" }, 7);
      // The seventh degree of D major is a C#, above the D tonic, so it belongs in
      // octave 5 rather than dropping a semitone below its own key.
      expect(result.map((c) => c.root)).toEqual([
        "D", "E", "F#", "G", "A", "B", "C#",
      ]);
      expect(result.map((c) => c.octave)).toEqual([4, 4, 4, 4, 4, 4, 5]);
    });

    it("throws if chordCount is less than 1", () => {
      const bar = makeBar(0, 4);
      expect(() => splitBarIntoChords(bar, C_MAJOR, 0)).toThrow();
      expect(() => splitBarIntoChords(bar, C_MAJOR, -1)).toThrow();
    });

    it("throws when the chords would be finer than a segment can be", () => {
      // The limit is the grid, not the beat count: thirty-two thirty-seconds fit
      // a 4/4 bar.
      const bar = makeBar(0, 4);
      expect(splitBarIntoChords(bar, C_MAJOR, 32)).toHaveLength(32);
      expect(() => splitBarIntoChords(bar, C_MAJOR, 33)).toThrow();
    });

    it("splits a 6/8 bar into six eighths", () => {
      const bar = barWith([], { beatsPerMeasure: 6, beatUnit: 8 });
      const result = splitBarIntoChords(bar, C_MAJOR, 6);

      expect(result).toHaveLength(6);
      // Six eighths, not six quarters — the bar is three beats long, like 3/4.
      expect(result.every(c => c.duration === 0.5)).toBe(true);
      expect(result.reduce((sum, c) => sum + c.duration, 0)).toBe(3);
    });

    it("assigns diatonic chord symbols based on bar scale", () => {
      const bar = makeBar(0, 4);
      const result = splitBarIntoChords(bar, C_MAJOR, 4);
      // Should assign I, ii, iii, IV for C major
      expect(result[0].romanNumeral).toBe("I");
      expect(result[1].romanNumeral).toBe("ii");
      expect(result[2].romanNumeral).toBe("iii");
      expect(result[3].romanNumeral).toBe("IV");
    });

    it("assigns correct romans for minor scale", () => {
      const bar = makeBar(0, 4);
      const result = splitBarIntoChords(bar, { root: "A", type: "naturalMinor" }, 4);
      expect(result[0].romanNumeral).toBe("i");
      expect(result[1].romanNumeral).toBe("ii°");
      expect(result[2].romanNumeral).toBe("III");
      expect(result[3].romanNumeral).toBe("iv");
    });

    it("generates unique IDs for each chord", () => {
      const bar = makeBar(0, 4);
      const result = splitBarIntoChords(bar, C_MAJOR, 4);
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
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      // C major triad in octave 4: C4, E4, G4 = MIDI 60, 64, 67
      expect(result.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([60, 64, 67]);
    });

    it("lays consecutive chords out at the right start beats", () => {
      const bar = barWith([makeChord("I", 2), makeChord("V", 2)]);
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      expect(result.filter((n) => n.startBeat === 0)).toHaveLength(3);
      expect(result.filter((n) => n.startBeat === 2)).toHaveLength(3);
    });

    it("gives notes the duration of their chord", () => {
      const bar = barWith([makeChord("I", 2)]);
      generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4).forEach((note) => {
        expect(note.duration).toBe(2);
      });
    });

    it("voices a chord in the octave its segment carries", () => {
      const bar = barWith([
        { id: generateId(), kind: "chord", root: "C", quality: "major", octave: 6, duration: 4 },
      ]);
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      // C major an octave above the default: C6, E6, G6.
      expect(result.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([84, 88, 91]);
    });

    it("puts two segments an octave apart when their octaves differ by one", () => {
      const bar = barWith([
        { id: generateId(), kind: "chord", startBeat: 0, root: "C", quality: "major", octave: 5, duration: 2 },
        { id: generateId(), kind: "chord", startBeat: 2, root: "C", quality: "major", octave: 6, duration: 2 },
      ]);
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      const low = result.filter((n) => n.startBeat === 0).map((n) => n.pitch).sort((a, b) => a - b);
      const high = result.filter((n) => n.startBeat === 2).map((n) => n.pitch).sort((a, b) => a - b);
      expect(high).toEqual(low.map((p) => p + 12));
    });

    it("falls back to the octave argument for a segment written without one", () => {
      const bar = barWith([makeChord("I", 4)]);
      expect(barChords(bar, TEST_TRACK_ID)[0].octave).toBeUndefined();
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      expect(result.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([60, 64, 67]);
    });

    it("returns an empty array for a bar with no segments", () => {
      expect(generateNotesFromSegments([], barWith([]), C_MAJOR, TS_4_4, 4)).toEqual([]);
    });

    it("does not throw when segments overrun the bar", () => {
      const bar = barWith([makeChord("I", 3), makeChord("V", 3)]);
      expect(() => generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4)).not.toThrow();
    });

    it("generates the correct notes for a ii chord (Dm)", () => {
      const bar = barWith([makeChord("ii", 4)]);
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      // Dm triad: D4, F4, A4 = MIDI 62, 65, 69
      expect(result.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([62, 65, 69]);
    });

    it("generates four notes for a seventh chord", () => {
      const bar = barWith([
        { id: generateId(), kind: "chord", root: "G", quality: "dominant7", duration: 4 },
      ]);
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      // G7: G4 B4 D5 F5 = 67, 71, 74, 77
      expect(result.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([67, 71, 74, 77]);
    });

    it("generates exactly one note for a note-kind segment", () => {
      const bar = barWith([
        { id: generateId(), kind: "note", pitch: 64, duration: 2 },
      ]);
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
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
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      expect(result.filter((n) => n.startBeat === 0)).toHaveLength(1);
      expect(result.filter((n) => n.startBeat === 1)).toHaveLength(3);
    });

    it("honours the bar's own time signature", () => {
      const bar = barWith([makeChord("I", 1), makeChord("V", 1), makeChord("I", 1)], TS_3_4);
      expect(() => generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4)).not.toThrow();
      expect(generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4)).toHaveLength(9);
    });

    it("assigns unique IDs to generated notes", () => {
      const bar = barWith([makeChord("I", 4)]);
      const ids = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4).map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("sets velocity to default (100) for all notes", () => {
      const bar = barWith([makeChord("I", 4)]);
      generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4).forEach((note) => {
        expect(note.velocity).toBe(100);
      });
    });

    it("places notes at the segment's own start beat", () => {
      const bar = barWith([{ ...makeChord("I", 1), startBeat: 3 }]);
      generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4).forEach((note) => {
        expect(note.startBeat).toBe(3);
      });
    });

    it("leaves a gap between segments as silence", () => {
      // I on beat 0, V on beat 2: nothing at all sounds on beat 1.
      const bar = barWith([
        { ...makeChord("I", 1), startBeat: 0 },
        { ...makeChord("V", 1), startBeat: 2 },
      ]);
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      expect(result.map((n) => n.startBeat).sort()).toEqual([0, 0, 0, 2, 2, 2]);
      expect(result.some((n) => n.startBeat > 0 && n.startBeat < 2)).toBe(false);
    });

    it("re-voices a chord carrying a spacing offset", () => {
      // C major in octave 4 is 60/64/67; dropping the third leaves 52.
      const bar = barWith([
        { ...makeChord("I", 4), voicing: { offsets: [0, -1, 0] } },
      ]);
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      expect(result.map((n) => n.pitch)).toEqual([52, 60, 67]);
    });

    it("adds a voice for a doubled chord tone", () => {
      const bar = barWith([
        { ...makeChord("I", 4), voicing: { doublings: [{ tone: 0, octaves: -1 }] } },
      ]);
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      expect(result.map((n) => n.pitch)).toEqual([48, 60, 64, 67]);
    });

    it("sequences an arpeggiated chord across its own duration", () => {
      const bar = barWith([
        { ...makeChord("I", 3), voicing: { break: { mode: "arpeggio", pattern: "up" } } },
      ]);
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      expect(result.map((n) => n.startBeat)).toEqual([0, 1, 2]);
      expect(result.map((n) => n.pitch)).toEqual([60, 64, 67]);
    });

    it("staggers a strummed chord's onsets but releases it together", () => {
      const bar = barWith([
        {
          ...makeChord("I", 4),
          voicing: { break: { mode: "strum", spreadBeats: 0.25, direction: "up" } },
        },
      ]);
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      expect(result.map((n) => n.startBeat)).toEqual([0, 0.25, 0.5]);
      result.forEach((note) => {
        expect(note.startBeat + note.duration).toBeCloseTo(4, 10);
      });
    });

    it("keeps every note of a broken chord inside its segment", () => {
      // Notes starting past the bar line are dropped further down, so a break
      // that spilled over would go silently missing rather than sound late.
      const bar = barWith([
        {
          ...makeChord("I", 1),
          startBeat: 3,
          voicing: { break: { mode: "arpeggio", pattern: "upDown" } },
        },
      ]);
      generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4).forEach((note) => {
        expect(note.startBeat).toBeGreaterThanOrEqual(3);
        expect(note.startBeat + note.duration).toBeLessThanOrEqual(4 + 1e-9);
      });
    });

    it("ignores a voicing on a note segment — one pitch has nothing to voice", () => {
      const bar = barWith([
        {
          id: generateId(),
          kind: "note",
          pitch: 60,
          duration: 4,
          startBeat: 0,
          voicing: { offsets: [-1], break: { mode: "arpeggio", pattern: "up" } },
        },
      ]);
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ pitch: 60, startBeat: 0, duration: 4 });
    });

    it("skips a segment that starts past the bar line", () => {
      // Refitting owns moving this into the next bar; rendering it here would
      // double it up.
      const bar = barWith([{ ...makeChord("I", 1), startBeat: 4 }]);
      expect(generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4)).toEqual([]);
    });

    it("packs positionless segments, as projects saved before free placement meant", () => {
      const bar = barWith([makeChord("I", 2), makeChord("V", 2)]);
      const result = generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4, 4);
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

    it("re-voices a degree that changes register in the new key", () => {
      // vii° of C major is B4; of D major it is a C#, which sits above the D tonic
      // and so has to rise to octave 5 rather than dropping below its own key.
      const vii = diatonic({
        romanNumeral: "vii°",
        root: "B",
        quality: "diminished",
        chordSymbol: "B°",
        octave: 4,
      });
      const [segment] = retuneSegmentsToScale([vii], C_MAJOR, D_MAJOR);
      expect(segment).toMatchObject({ root: "C#", octave: 5 });
    });

    it("leaves the tonic's register alone across a key change", () => {
      const [segment] = retuneSegmentsToScale([diatonic({ octave: 4 })], C_MAJOR, D_MAJOR);
      expect(segment).toMatchObject({ root: "D", octave: 4 });
    });

    it("strips the old key's wrap instead of stacking a second one", () => {
      // C is degree 3 of A minor and already wrapped up to octave 5; as the tonic
      // of C major it belongs back at 4, not at 6.
      const third = diatonic({
        romanNumeral: "III",
        root: "C",
        chordSymbol: "C",
        octave: 5,
      });
      const [segment] = retuneSegmentsToScale([third], A_MINOR, C_MAJOR);
      expect(segment).toMatchObject({ root: "E", octave: 4 });
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

  describe("stepSegmentInScale", () => {
    const C_MAJOR: Scale = { root: "C", type: "major" };
    const A_MINOR: Scale = { root: "A", type: "naturalMinor" };

    /** A note segment sitting on `pitch`, labelled as the palette would label it. */
    const note = (pitch: number, romanNumeral?: string): ChordSegment => ({
      id: generateId(),
      kind: "note",
      pitch,
      romanNumeral,
      duration: 1,
    });

    /** A chord segment as the palette builds one. */
    const chord = (
      overrides: Partial<ChordSegment> & Pick<ChordSegment, "root">
    ): ChordSegment => ({
      id: generateId(),
      kind: "chord",
      quality: "major",
      octave: 4,
      duration: 1,
      ...overrides,
    });

    it("moves a note to the next note of the scale", () => {
      // C4 -> D4: a tone, because there is no C# in C major.
      expect(stepSegmentInScale(note(60), C_MAJOR, 1).pitch).toBe(62);
    });

    it("moves a note down to the previous note of the scale", () => {
      // C4 -> B3: a semitone, and across the octave boundary.
      expect(stepSegmentInScale(note(60), C_MAJOR, -1).pitch).toBe(59);
    });

    it("carries a note across the octave line: B4 -> C5", () => {
      expect(stepSegmentInScale(note(71), C_MAJOR, 1).pitch).toBe(72);
    });

    it("relabels a stepped note with the degree it landed on", () => {
      const stepped = stepSegmentInScale(note(60, "I"), C_MAJOR, 1);
      expect(stepped.root).toBe("D");
      expect(stepped.romanNumeral).toBe("ii");
    });

    it("snaps an off-scale note onto the scale rather than sticking", () => {
      // C#4 is not in C major; stepping up lands on the next scale note, D4.
      expect(stepSegmentInScale(note(61), C_MAJOR, 1).pitch).toBe(62);
    });

    it("refuses to step a note past the ends of the roll", () => {
      const top = note(108); // C8
      expect(stepSegmentInScale(top, C_MAJOR, 1)).toEqual(top);
      const bottom = note(21); // A0
      expect(stepSegmentInScale(bottom, C_MAJOR, -1)).toEqual(bottom);
    });

    it("moves a chord to the next scale degree", () => {
      const stepped = stepSegmentInScale(
        chord({ root: "C", romanNumeral: "I", chordSymbol: "C" }),
        C_MAJOR,
        1
      );
      expect(stepped).toMatchObject({
        root: "D",
        quality: "minor",
        romanNumeral: "ii",
        chordSymbol: "Dm",
        octave: 4,
      });
    });

    it("wraps vii° up to I an octave higher", () => {
      // B -> C ascends past the octave line, so the register has to follow.
      const stepped = stepSegmentInScale(
        chord({ root: "B", quality: "diminished", romanNumeral: "vii°", chordSymbol: "B°" }),
        C_MAJOR,
        1
      );
      expect(stepped).toMatchObject({ root: "C", romanNumeral: "I", octave: 5 });
    });

    it("drops I down to vii° an octave lower", () => {
      const stepped = stepSegmentInScale(
        chord({ root: "C", romanNumeral: "I", chordSymbol: "C" }),
        C_MAJOR,
        -1
      );
      expect(stepped).toMatchObject({ root: "B", romanNumeral: "vii°", octave: 3 });
    });

    it("keeps the register when the degree wraps but the pitch does not", () => {
      // A minor's last degree is VII (G); the tonic i (A) sits a tone *above* it,
      // so wrapping the degree index must not drag the octave with it.
      const stepped = stepSegmentInScale(
        chord({ root: "G", romanNumeral: "VII", chordSymbol: "G" }),
        A_MINOR,
        1
      );
      expect(stepped).toMatchObject({ root: "A", romanNumeral: "i", octave: 4 });
    });

    it("keeps a seventh a seventh", () => {
      const stepped = stepSegmentInScale(
        chord({ root: "C", quality: "maj7", romanNumeral: "I", chordSymbol: "Cmaj7" }),
        C_MAJOR,
        1
      );
      expect(stepped).toMatchObject({ root: "D", quality: "min7", chordSymbol: "Dm7" });
    });

    it("wraps over a pentatonic scale's five degrees", () => {
      const pentatonic: Scale = { root: "C", type: "pentatonicMajor" };
      let segment = chord({ root: "C", romanNumeral: "I", chordSymbol: "C" });
      for (let i = 0; i < 5; i++) {
        segment = stepSegmentInScale(segment, pentatonic, 1);
      }
      // Five degrees is a full turn: same chord, one octave up.
      expect(segment).toMatchObject({ root: "C", romanNumeral: "I", octave: 5 });
    });

    it("finds the degree from the root when a chord carries no numeral", () => {
      const stepped = stepSegmentInScale(chord({ root: "F", chordSymbol: "F" }), C_MAJOR, 1);
      expect(stepped).toMatchObject({ root: "G", romanNumeral: "V" });
    });

    it("leaves a chromatic chord alone", () => {
      // Ab is in neither the numerals nor the pitches of C major.
      const borrowed = chord({ root: "G#", chordSymbol: "G#" });
      expect(stepSegmentInScale(borrowed, C_MAJOR, 1)).toEqual(borrowed);
    });

    it("refuses to step a chord past the top register", () => {
      const top = chord({
        root: "B",
        quality: "diminished",
        romanNumeral: "vii°",
        chordSymbol: "B°",
        octave: 7,
      });
      expect(stepSegmentInScale(top, C_MAJOR, 1)).toEqual(top);
    });
  });

  describe("shiftSegmentOctave", () => {
    const note = (pitch: number): ChordSegment => ({
      id: generateId(),
      kind: "note",
      pitch,
      duration: 1,
    });
    const chord = (octave: number): ChordSegment => ({
      id: generateId(),
      kind: "chord",
      root: "C",
      quality: "major",
      octave,
      duration: 1,
    });

    it("moves a note a full octave", () => {
      expect(shiftSegmentOctave(note(60), 1).pitch).toBe(72);
      expect(shiftSegmentOctave(note(60), -1).pitch).toBe(48);
    });

    it("moves a chord's register by one", () => {
      expect(shiftSegmentOctave(chord(4), 1).octave).toBe(5);
      expect(shiftSegmentOctave(chord(4), -1).octave).toBe(3);
    });

    it("treats a chord with no register as octave 4", () => {
      const legacy: ChordSegment = { id: generateId(), root: "C", duration: 1 };
      expect(shiftSegmentOctave(legacy, 1).octave).toBe(5);
    });

    it("refuses to push a note off the roll", () => {
      const high = note(100); // +12 would be 112, past C8
      expect(shiftSegmentOctave(high, 1)).toEqual(high);
      const low = note(30);
      expect(shiftSegmentOctave(low, -1)).toEqual(low);
    });

    it("refuses to push a chord past its register bounds", () => {
      const top = chord(7);
      expect(shiftSegmentOctave(top, 1)).toEqual(top);
      const bottom = chord(1);
      expect(shiftSegmentOctave(bottom, -1)).toEqual(bottom);
    });
  });

  describe("cycleSegmentInversion", () => {
    const triad: ChordSegment = {
      id: "t",
      kind: "chord",
      root: "C",
      quality: "major",
      octave: 4,
      duration: 1,
    };

    it("cycles a triad root -> 1st -> 2nd -> root", () => {
      const first = cycleSegmentInversion(triad);
      expect(first.inversion).toBe(1);
      const second = cycleSegmentInversion(first);
      expect(second.inversion).toBe(2);
      expect(cycleSegmentInversion(second).inversion).toBe(0);
    });

    it("gives a seventh chord a third inversion before wrapping", () => {
      const seventh = { ...triad, quality: "maj7" as const };
      const inversions = [1, 2, 3, 0];
      let segment = seventh as ChordSegment;
      for (const expected of inversions) {
        segment = cycleSegmentInversion(segment);
        expect(segment.inversion).toBe(expected);
      }
    });

    it("leaves a note segment alone — a single pitch has no voicing", () => {
      const single: ChordSegment = { id: "n", kind: "note", pitch: 60, duration: 1 };
      expect(cycleSegmentInversion(single)).toEqual(single);
    });

    it("leaves a chord with no resolvable quality alone", () => {
      const vague: ChordSegment = { id: "v", kind: "chord", duration: 1 };
      expect(cycleSegmentInversion(vague)).toEqual(vague);
    });
  });

  describe("generateNotesFromSegments — inversions", () => {
    it("voices an inverted chord with the root on top", () => {
      const bar = barWith([
        {
          id: generateId(),
          kind: "chord",
          root: "C",
          quality: "major",
          octave: 4,
          inversion: 1,
          startBeat: 0,
          duration: 1,
        },
      ]);
      // E4 G4 C5 rather than C4 E4 G4.
      expect(generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4).map((n) => n.pitch)).toEqual([64, 67, 72]);
    });

    it("keeps root position when a segment carries no inversion", () => {
      const bar = barWith([
        {
          id: generateId(),
          kind: "chord",
          root: "C",
          quality: "major",
          octave: 4,
          startBeat: 0,
          duration: 1,
        },
      ]);
      expect(generateNotesFromSegments(barChords(bar, TEST_TRACK_ID), bar, C_MAJOR, TS_4_4).map((n) => n.pitch)).toEqual([60, 64, 67]);
    });
  });

  describe("currentKind", () => {
    it("returns 'note' for a note segment", () => {
      const segment: ChordSegment = {
        id: generateId(),
        kind: "note",
        pitch: 60,
        duration: 1,
      };
      expect(currentKind(segment)).toBe("note");
    });

    it("returns 'triad' for a major chord", () => {
      const segment: ChordSegment = {
        id: generateId(),
        kind: "chord",
        root: "C",
        quality: "major",
        octave: 4,
        duration: 1,
      };
      expect(currentKind(segment)).toBe("triad");
    });

    it("returns 'triad' for a minor chord", () => {
      const segment: ChordSegment = {
        id: generateId(),
        kind: "chord",
        root: "D",
        quality: "minor",
        octave: 4,
        duration: 1,
      };
      expect(currentKind(segment)).toBe("triad");
    });

    it("returns 'seventh' for a dominant7 chord", () => {
      const segment: ChordSegment = {
        id: generateId(),
        kind: "chord",
        root: "G",
        quality: "dominant7",
        octave: 4,
        duration: 1,
      };
      expect(currentKind(segment)).toBe("seventh");
    });

    it("returns 'seventh' for a min7 chord", () => {
      const segment: ChordSegment = {
        id: generateId(),
        kind: "chord",
        root: "D",
        quality: "min7",
        octave: 4,
        duration: 1,
      };
      expect(currentKind(segment)).toBe("seventh");
    });

    it("returns 'seventh' for a maj7 chord", () => {
      const segment: ChordSegment = {
        id: generateId(),
        kind: "chord",
        root: "C",
        quality: "maj7",
        octave: 4,
        duration: 1,
      };
      expect(currentKind(segment)).toBe("seventh");
    });

    it("returns 'triad' for a segment with no quality", () => {
      const segment: ChordSegment = {
        id: generateId(),
        kind: "chord",
        root: "C",
        duration: 1,
      };
      expect(currentKind(segment)).toBe("triad");
    });
  });

  describe("convertSegmentKind", () => {
    const C_MAJOR: Scale = { root: "C", type: "major" };
    const A_MINOR: Scale = { root: "A", type: "naturalMinor" };

    /** A note segment at `pitch` with optional overrides. */
    const note = (pitch: number, overrides: Partial<ChordSegment> = {}): ChordSegment => ({
      id: generateId(),
      kind: "note",
      pitch,
      duration: 2,
      startBeat: 1,
      scale: C_MAJOR,
      ...overrides,
    });

    /** A triad segment as the palette produces one. */
    const triad = (overrides: Partial<ChordSegment>): ChordSegment => ({
      id: generateId(),
      kind: "chord",
      root: "C",
      quality: "major",
      octave: 4,
      duration: 2,
      startBeat: 1,
      scale: C_MAJOR,
      romanNumeral: "I",
      chordSymbol: "C",
      ...overrides,
    });

    /** A seventh segment. */
    const seventh = (overrides: Partial<ChordSegment>): ChordSegment => ({
      id: generateId(),
      kind: "chord",
      root: "C",
      quality: "maj7",
      octave: 4,
      duration: 2,
      startBeat: 1,
      scale: C_MAJOR,
      romanNumeral: "I",
      chordSymbol: "Cmaj7",
      ...overrides,
    });

    describe("note -> triad", () => {
      it("converts C4 (degree I) to C major triad in C major", () => {
        const result = convertSegmentKind(note(60), C_MAJOR, "triad");
        expect(result.kind).toBe("chord");
        expect(result.root).toBe("C");
        expect(result.quality).toBe("major");
      });

      it("converts D4 (degree ii) to D minor triad in C major", () => {
        const result = convertSegmentKind(note(62), C_MAJOR, "triad");
        expect(result.kind).toBe("chord");
        expect(result.root).toBe("D");
        expect(result.quality).toBe("minor");
      });

      it("converts B4 (degree vii) to B diminished triad in C major", () => {
        const result = convertSegmentKind(note(71), C_MAJOR, "triad");
        expect(result.kind).toBe("chord");
        expect(result.root).toBe("B");
        expect(result.quality).toBe("diminished");
      });

      it("preserves duration from the note segment", () => {
        const result = convertSegmentKind(note(60, { duration: 3 }), C_MAJOR, "triad");
        expect(result.duration).toBe(3);
      });

      it("preserves startBeat from the note segment", () => {
        const result = convertSegmentKind(note(60, { startBeat: 2.5 }), C_MAJOR, "triad");
        expect(result.startBeat).toBe(2.5);
      });

      it("discards pitch from the note segment", () => {
        const result = convertSegmentKind(note(60), C_MAJOR, "triad");
        expect(result.pitch).toBeUndefined();
      });

      it("discards voicing from the note segment", () => {
        const result = convertSegmentKind(
          note(60, { voicing: { spacing: "open" } }),
          C_MAJOR,
          "triad"
        );
        expect(result.voicing).toBeUndefined();
      });

      it("sets kind to 'chord'", () => {
        const result = convertSegmentKind(note(60), C_MAJOR, "triad");
        expect(result.kind).toBe("chord");
      });
    });

    describe("note -> seventh", () => {
      it("converts C4 (degree I) to Cmaj7 in C major", () => {
        const result = convertSegmentKind(note(60), C_MAJOR, "seventh");
        expect(result.kind).toBe("chord");
        expect(result.root).toBe("C");
        expect(result.quality).toBe("maj7");
      });

      it("converts D4 (degree ii) to Dm7 in C major", () => {
        const result = convertSegmentKind(note(62), C_MAJOR, "seventh");
        expect(result.kind).toBe("chord");
        expect(result.root).toBe("D");
        expect(result.quality).toBe("min7");
      });

      it("converts G4 (degree V) to G7 in C major", () => {
        const result = convertSegmentKind(note(67), C_MAJOR, "seventh");
        expect(result.kind).toBe("chord");
        expect(result.root).toBe("G");
        expect(result.quality).toBe("dominant7");
      });
    });

    describe("triad -> note", () => {
      it("converts C major triad to C note at octave 4", () => {
        const result = convertSegmentKind(triad({ root: "C", quality: "major", octave: 4 }), C_MAJOR, "note");
        expect(result.kind).toBe("note");
        expect(result.pitch).toBe(60);
      });

      it("converts Dm triad to D note at octave 4", () => {
        const result = convertSegmentKind(
          triad({ root: "D", quality: "minor", romanNumeral: "ii", chordSymbol: "Dm", octave: 4 }),
          C_MAJOR,
          "note"
        );
        expect(result.kind).toBe("note");
        expect(result.pitch).toBe(62);
      });

      it("preserves duration and startBeat", () => {
        const result = convertSegmentKind(
          triad({ duration: 3, startBeat: 2 }),
          C_MAJOR,
          "note"
        );
        expect(result.duration).toBe(3);
        expect(result.startBeat).toBe(2);
      });

      it("discards quality, octave, inversion, voicing", () => {
        const result = convertSegmentKind(
          triad({
            quality: "minor",
            octave: 5,
            inversion: 1,
            voicing: { spacing: "open" },
          }),
          C_MAJOR,
          "note"
        );
        expect(result.quality).toBeUndefined();
        expect(result.octave).toBeUndefined();
        expect(result.inversion).toBeUndefined();
        expect(result.voicing).toBeUndefined();
      });

      it("sets kind to 'note'", () => {
        const result = convertSegmentKind(triad({}), C_MAJOR, "note");
        expect(result.kind).toBe("note");
      });
    });

    describe("seventh -> note", () => {
      it("converts Cmaj7 to C note at octave 4", () => {
        const result = convertSegmentKind(seventh({ octave: 4 }), C_MAJOR, "note");
        expect(result.kind).toBe("note");
        expect(result.pitch).toBe(60);
      });

      it("converts Dm7 to D note at octave 4", () => {
        const seg: ChordSegment = {
          id: generateId(),
          kind: "chord",
          root: "D",
          quality: "min7",
          octave: 4,
          duration: 2,
          scale: C_MAJOR,
          romanNumeral: "ii",
          chordSymbol: "Dm7",
        };
        const result = convertSegmentKind(seg, C_MAJOR, "note");
        expect(result.kind).toBe("note");
        expect(result.pitch).toBe(62);
      });
    });

    describe("triad -> seventh", () => {
      it("converts C major to Cmaj7 in C major", () => {
        const result = convertSegmentKind(triad({ root: "C", quality: "major", romanNumeral: "I", chordSymbol: "C" }), C_MAJOR, "seventh");
        expect(result.quality).toBe("maj7");
        expect(result.chordSymbol).toBe("Cmaj7");
      });

      it("converts D minor to Dm7 in C major", () => {
        const result = convertSegmentKind(
          triad({ root: "D", quality: "minor", romanNumeral: "ii", chordSymbol: "Dm" }),
          C_MAJOR,
          "seventh"
        );
        expect(result.quality).toBe("min7");
        expect(result.chordSymbol).toBe("Dm7");
      });

      it("converts G major to G7 in C major", () => {
        const result = convertSegmentKind(
          triad({ root: "G", quality: "major", romanNumeral: "V", chordSymbol: "G" }),
          C_MAJOR,
          "seventh"
        );
        expect(result.quality).toBe("dominant7");
        expect(result.chordSymbol).toBe("G7");
      });

      it("preserves inversion clamped to new size", () => {
        // Triad inversion 2 -> seventh: 2 is valid for a seventh (max 3)
        const result = convertSegmentKind(
          triad({ inversion: 2 }),
          C_MAJOR,
          "seventh"
        );
        expect(result.inversion).toBe(2);
      });

      it("preserves octave", () => {
        const result = convertSegmentKind(triad({ octave: 5 }), C_MAJOR, "seventh");
        expect(result.octave).toBe(5);
      });

      it("updates chordSymbol", () => {
        const result = convertSegmentKind(
          triad({ root: "C", quality: "major", romanNumeral: "I", chordSymbol: "C" }),
          C_MAJOR,
          "seventh"
        );
        expect(result.chordSymbol).toBe("Cmaj7");
      });
    });

    describe("seventh -> triad", () => {
      it("converts Cmaj7 to C major in C major", () => {
        const result = convertSegmentKind(seventh({ root: "C", quality: "maj7", romanNumeral: "I", chordSymbol: "Cmaj7" }), C_MAJOR, "triad");
        expect(result.quality).toBe("major");
        expect(result.chordSymbol).toBe("C");
      });

      it("converts Dm7 to D minor in C major", () => {
        const seg: ChordSegment = {
          id: generateId(),
          kind: "chord",
          root: "D",
          quality: "min7",
          octave: 4,
          duration: 2,
          scale: C_MAJOR,
          romanNumeral: "ii",
          chordSymbol: "Dm7",
        };
        const result = convertSegmentKind(seg, C_MAJOR, "triad");
        expect(result.quality).toBe("minor");
        expect(result.chordSymbol).toBe("Dm");
      });

      it("converts G7 to G major in C major", () => {
        const seg: ChordSegment = {
          id: generateId(),
          kind: "chord",
          root: "G",
          quality: "dominant7",
          octave: 4,
          duration: 2,
          scale: C_MAJOR,
          romanNumeral: "V",
          chordSymbol: "G7",
        };
        const result = convertSegmentKind(seg, C_MAJOR, "triad");
        expect(result.quality).toBe("major");
        expect(result.chordSymbol).toBe("G");
      });

      it("preserves octave", () => {
        const result = convertSegmentKind(seventh({ octave: 5 }), C_MAJOR, "triad");
        expect(result.octave).toBe(5);
      });

      it("updates chordSymbol", () => {
        const result = convertSegmentKind(seventh({ chordSymbol: "Cmaj7" }), C_MAJOR, "triad");
        expect(result.chordSymbol).toBe("C");
      });
    });

    describe("no-op when target matches", () => {
      it("returns the same segment when triad -> triad", () => {
        const segment = triad({});
        expect(convertSegmentKind(segment, C_MAJOR, "triad")).toBe(segment);
      });

      it("returns the same segment when note -> note", () => {
        const segment = note(60);
        expect(convertSegmentKind(segment, C_MAJOR, "note")).toBe(segment);
      });

      it("returns the same segment when seventh -> seventh", () => {
        const segment = seventh({});
        expect(convertSegmentKind(segment, C_MAJOR, "seventh")).toBe(segment);
      });
    });

    describe("natural minor scale", () => {
      it("converts A4 (degree i) to Am triad", () => {
        const result = convertSegmentKind(note(69, { scale: A_MINOR }), A_MINOR, "triad");
        expect(result.root).toBe("A");
        expect(result.quality).toBe("minor");
      });

      it("converts C4 (degree III) to C major triad", () => {
        const result = convertSegmentKind(note(60, { scale: A_MINOR }), A_MINOR, "triad");
        expect(result.root).toBe("C");
        expect(result.quality).toBe("major");
      });

      it("converts C4 (degree III) to Cmaj7", () => {
        const result = convertSegmentKind(note(60, { scale: A_MINOR }), A_MINOR, "seventh");
        expect(result.root).toBe("C");
        expect(result.quality).toBe("maj7");
      });
    });

    describe("seventh -> triad inversion clamping", () => {
      it("wraps inversion 3 to 0 when seventh (size 4) -> triad (size 3)", () => {
        const result = convertSegmentKind(
          seventh({ inversion: 3 }),
          C_MAJOR,
          "triad"
        );
        expect(result.inversion).toBe(0);
      });
    });
  });
});
