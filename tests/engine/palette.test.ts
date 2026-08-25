import { describe, it, expect } from "vitest";
import {
  getPaletteItems,
  paletteItemToSegment,
  formatChordSymbol,
  PALETTE_VELOCITY,
} from "@/engine/palette";
import { Scale } from "@/types/music";

const C_MAJOR: Scale = { root: "C", type: "major" };
const A_MINOR: Scale = { root: "A", type: "naturalMinor" };

describe("palette", () => {
  describe("formatChordSymbol", () => {
    it("formats triads", () => {
      expect(formatChordSymbol("C", "major")).toBe("C");
      expect(formatChordSymbol("D", "minor")).toBe("Dm");
      expect(formatChordSymbol("B", "diminished")).toBe("B°");
      expect(formatChordSymbol("C", "augmented")).toBe("Caug");
    });

    it("formats sevenths", () => {
      expect(formatChordSymbol("C", "maj7")).toBe("Cmaj7");
      expect(formatChordSymbol("D", "min7")).toBe("Dm7");
      expect(formatChordSymbol("G", "dominant7")).toBe("G7");
      expect(formatChordSymbol("B", "halfDim7")).toBe("Bø7");
      expect(formatChordSymbol("B", "dim7")).toBe("Bdim7");
    });
  });

  describe("getPaletteItems - notes mode", () => {
    const items = getPaletteItems(C_MAJOR, "notes");

    it("lists the seven notes of C major, named with their octave", () => {
      expect(items.map((i) => i.label)).toEqual([
        "C4", "D4", "E4", "F4", "G4", "A4", "B4",
      ]);
    });

    it("follows the ascending run into the next octave", () => {
      // A minor at octave 4 starts on A4, so its third degree is C5, not C4.
      const aMinor = getPaletteItems({ root: "A", type: "naturalMinor" }, "notes");
      expect(aMinor.map((i) => i.label)).toEqual([
        "A4", "B4", "C5", "D5", "E5", "F5", "G5",
      ]);
      expect(aMinor.map((i) => i.octave)).toEqual([4, 4, 5, 5, 5, 5, 5]);
    });

    it("renames the blocks when the octave changes", () => {
      expect(getPaletteItems(C_MAJOR, "notes", 6).map((i) => i.label)).toEqual([
        "C6", "D6", "E6", "F6", "G6", "A6", "B6",
      ]);
    });

    it("labels each note with its scale degree numeral", () => {
      expect(items.map((i) => i.degreeLabel)).toEqual([
        "I", "ii", "iii", "IV", "V", "vi", "vii°",
      ]);
    });

    it("marks every item as a note and carries a MIDI pitch", () => {
      items.forEach((item) => {
        expect(item.kind).toBe("note");
        expect(typeof item.pitch).toBe("number");
      });
    });

    it("places the tonic at C4 (MIDI 60) by default", () => {
      expect(items[0].pitch).toBe(60);
    });

    it("respects the octave argument", () => {
      expect(getPaletteItems(C_MAJOR, "notes", 3)[0].pitch).toBe(48);
    });

    it("keeps pitches ascending within the octave", () => {
      const pitches = items.map((i) => i.pitch!);
      for (let i = 1; i < pitches.length; i++) {
        expect(pitches[i]).toBeGreaterThan(pitches[i - 1]);
      }
    });

    it("gives every item a stable unique id", () => {
      const ids = items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(getPaletteItems(C_MAJOR, "notes").map((i) => i.id)).toEqual(ids);
    });
  });

  describe("getPaletteItems - chords mode", () => {
    const items = getPaletteItems(C_MAJOR, "chords");

    it("lists the diatonic triads of C major", () => {
      expect(items.map((i) => i.label)).toEqual([
        "C", "Dm", "Em", "F", "G", "Am", "B°",
      ]);
    });

    it("labels each triad with its roman numeral", () => {
      expect(items.map((i) => i.degreeLabel)).toEqual([
        "I", "ii", "iii", "IV", "V", "vi", "vii°",
      ]);
    });

    it("lists the diatonic triads of A natural minor", () => {
      expect(getPaletteItems(A_MINOR, "chords").map((i) => i.label)).toEqual([
        "Am", "B°", "C", "Dm", "Em", "F", "G",
      ]);
    });

    it("keeps every degree of C major in the chosen octave", () => {
      expect(getPaletteItems(C_MAJOR, "chords", 4).map((i) => i.octave)).toEqual([
        4, 4, 4, 4, 4, 4, 4,
      ]);
    });

    it("voices the chosen octave from the root note, not the whole scale", () => {
      // D major at octave 4: the vii° is a C#, which sits *above* the D tonic and
      // so belongs in octave 5 — voicing it at 4 would leap a semitone downward.
      const dMajor = getPaletteItems({ root: "D", type: "major" }, "chords", 4);
      expect(dMajor.map((i) => i.label)).toEqual([
        "D", "Em", "F#m", "G", "A", "Bm", "C#°",
      ]);
      expect(dMajor.map((i) => i.octave)).toEqual([4, 4, 4, 4, 4, 4, 5]);
    });

    it("carries A minor's upper degrees into the next octave", () => {
      expect(getPaletteItems(A_MINOR, "chords", 4).map((i) => i.octave)).toEqual([
        4, 4, 5, 5, 5, 5, 5,
      ]);
    });

    it("clamps a wrapped degree to the highest register a segment may hold", () => {
      const dMajor = getPaletteItems({ root: "D", type: "major" }, "chords", 7);
      expect(dMajor.map((i) => i.octave)).toEqual([7, 7, 7, 7, 7, 7, 7]);
    });

    it("marks every item as a chord with a root and quality", () => {
      items.forEach((item) => {
        expect(item.kind).toBe("chord");
        expect(item.root).toBeDefined();
        expect(item.quality).toBeDefined();
      });
    });
  });

  describe("getPaletteItems - sevenths mode", () => {
    const items = getPaletteItems(C_MAJOR, "sevenths");

    it("lists the diatonic sevenths of C major", () => {
      expect(items.map((i) => i.label)).toEqual([
        "Cmaj7", "Dm7", "Em7", "Fmaj7", "G7", "Am7", "Bø7",
      ]);
    });

    it("labels each seventh with its roman numeral plus extension", () => {
      expect(items.map((i) => i.degreeLabel)).toEqual([
        "Imaj7", "ii7", "iii7", "IVmaj7", "V7", "vi7", "viiø7",
      ]);
    });

    it("lists the diatonic sevenths of A natural minor", () => {
      expect(getPaletteItems(A_MINOR, "sevenths").map((i) => i.label)).toEqual([
        "Am7", "Bø7", "Cmaj7", "Dm7", "Em7", "Fmaj7", "G7",
      ]);
    });

    it("voices sevenths from the root note too", () => {
      const dMajor = getPaletteItems({ root: "D", type: "major" }, "sevenths", 4);
      expect(dMajor[6].label).toBe("C#ø7");
      expect(dMajor.map((i) => i.octave)).toEqual([4, 4, 4, 4, 4, 4, 5]);
    });
  });

  describe("getPaletteItems - non-heptatonic scales", () => {
    it("returns 5 items for a pentatonic scale with no undefined qualities", () => {
      const items = getPaletteItems({ root: "C", type: "pentatonicMajor" }, "chords");
      expect(items).toHaveLength(5);
      items.forEach((item) => {
        expect(item.quality).toBeDefined();
        expect(item.label).toBeString();
        expect(item.degreeLabel).toBeString();
      });
    });

    it("returns 6 items for the blues scale", () => {
      expect(getPaletteItems({ root: "C", type: "blues" }, "notes")).toHaveLength(6);
    });
  });

  describe("paletteItemToSegment", () => {
    it("converts a chord item into a chord segment", () => {
      const item = getPaletteItems(C_MAJOR, "chords")[1]; // Dm
      const segment = paletteItemToSegment(item, 1, C_MAJOR);
      expect(segment.kind).toBe("chord");
      expect(segment.duration).toBe(1);
      expect(segment.root).toBe("D");
      expect(segment.quality).toBe("minor");
      expect(segment.chordSymbol).toBe("Dm");
      expect(segment.romanNumeral).toBe("ii");
      expect(segment.pitch).toBeUndefined();
    });

    it("converts a note item into a one-note segment", () => {
      const item = getPaletteItems(C_MAJOR, "notes")[2]; // E
      const segment = paletteItemToSegment(item, 2, C_MAJOR);
      expect(segment.kind).toBe("note");
      expect(segment.duration).toBe(2);
      expect(segment.pitch).toBe(64);
      expect(segment.chordSymbol).toBe("E4");
      expect(segment.octave).toBe(4);
    });

    it("starts every block at the palette's quieter velocity", () => {
      // Half-loud rather than the 100 an unmarked segment reads as, so a sketch
      // laid out from the palette can be accented as well as eased.
      expect(PALETTE_VELOCITY).toBe(50);
      for (const mode of ["notes", "chords", "sevenths"] as const) {
        const item = getPaletteItems(C_MAJOR, mode)[0];
        expect(paletteItemToSegment(item, 1, C_MAJOR).velocity).toBe(PALETTE_VELOCITY);
      }
    });

    it("carries the palette's octave onto a chord segment", () => {
      const item = getPaletteItems(C_MAJOR, "chords", 6)[0];
      expect(paletteItemToSegment(item, 1, C_MAJOR).octave).toBe(6);
    });

    it("converts a seventh item, preserving the four-note quality", () => {
      const item = getPaletteItems(C_MAJOR, "sevenths")[4]; // G7
      const segment = paletteItemToSegment(item, 1, C_MAJOR);
      expect(segment.quality).toBe("dominant7");
      expect(segment.chordSymbol).toBe("G7");
    });

    // What lets the block keep naming its own degree once the palette moves on
    // to another key, and what the inspector reads back.
    it("stamps the palette's key onto the segment", () => {
      const item = getPaletteItems(C_MAJOR, "chords")[1];
      const segment = paletteItemToSegment(item, 1, { root: "A", type: "naturalMinor" });
      expect(segment.scale).toEqual({ root: "A", type: "naturalMinor" });
    });

    it("gives each produced segment a fresh unique id", () => {
      const item = getPaletteItems(C_MAJOR, "chords")[0];
      const a = paletteItemToSegment(item, 1, C_MAJOR);
      const b = paletteItemToSegment(item, 1, C_MAJOR);
      expect(a.id).not.toBe(b.id);
    });
  });
});
