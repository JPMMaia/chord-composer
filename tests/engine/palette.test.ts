import { describe, it, expect } from "vitest";
import {
  getPaletteItems,
  paletteItemToSegment,
  formatChordSymbol,
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

    it("lists the seven notes of C major", () => {
      expect(items.map((i) => i.label)).toEqual([
        "C", "D", "E", "F", "G", "A", "B",
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
      const segment = paletteItemToSegment(item, 1);
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
      const segment = paletteItemToSegment(item, 2);
      expect(segment.kind).toBe("note");
      expect(segment.duration).toBe(2);
      expect(segment.pitch).toBe(64);
      expect(segment.chordSymbol).toBe("E");
    });

    it("converts a seventh item, preserving the four-note quality", () => {
      const item = getPaletteItems(C_MAJOR, "sevenths")[4]; // G7
      const segment = paletteItemToSegment(item, 1);
      expect(segment.quality).toBe("dominant7");
      expect(segment.chordSymbol).toBe("G7");
    });

    it("gives each produced segment a fresh unique id", () => {
      const item = getPaletteItems(C_MAJOR, "chords")[0];
      const a = paletteItemToSegment(item, 1);
      const b = paletteItemToSegment(item, 1);
      expect(a.id).not.toBe(b.id);
    });
  });
});
