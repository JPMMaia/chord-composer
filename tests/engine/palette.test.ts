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

  describe("getPaletteItems - one tone", () => {
    const items = getPaletteItems(C_MAJOR, 1);

    it("lists the seven degrees of C major as bare notes", () => {
      expect(items.map((i) => i.label)).toEqual([
        "C", "D", "E", "F", "G", "A", "B",
      ]);
    });

    it("labels each with its scale degree numeral", () => {
      expect(items.map((i) => i.degreeLabel)).toEqual([
        "I", "ii", "iii", "IV", "V", "vi", "vii°",
      ]);
    });

    it("is a chord segment of one tone, not a note segment", () => {
      // A degree-named block is a chord at every size; `kind: 'note'` is now only
      // ever a recorded absolute pitch.
      items.forEach((item) => {
        expect(item.kind).toBe("chord");
        expect(item.tones).toEqual([0]);
      });
    });

    it("follows the ascending run into the next octave", () => {
      // A minor at octave 4 starts on A4, so its third degree is voiced at 5.
      const aMinor = getPaletteItems(A_MINOR, 1);
      expect(aMinor.map((i) => i.octave)).toEqual([4, 4, 5, 5, 5, 5, 5]);
    });

    it("respects the octave argument", () => {
      expect(getPaletteItems(C_MAJOR, 1, 3)[0].octave).toBe(3);
    });

    it("gives every item a stable unique id", () => {
      const ids = items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(getPaletteItems(C_MAJOR, 1).map((i) => i.id)).toEqual(ids);
    });
  });

  describe("getPaletteItems - dyads", () => {
    it("stacks a third on each degree", () => {
      const items = getPaletteItems(C_MAJOR, 2);
      expect(items.map((i) => i.label)).toEqual([
        "C(no5)", "Dm(no5)", "Em(no5)", "F(no5)", "G(no5)", "Am(no5)", "B°(no5)",
      ]);
      expect(items[0].tones).toEqual([0, 1]);
    });
  });

  describe("getPaletteItems - ninths", () => {
    it("lists the diatonic ninths of C major", () => {
      const items = getPaletteItems(C_MAJOR, 5);
      expect(items.map((i) => i.label)).toEqual([
        "Cmaj9", "Dm9", "Em9", "Fmaj9", "G9", "Am9", "Bø9",
      ]);
      expect(items.map((i) => i.degreeLabel)).toEqual([
        "Imaj9", "ii9", "iii9", "IVmaj9", "V9", "vi9", "viiø9",
      ]);
    });

    it("stacks every tone, so the block sounds five notes", () => {
      expect(getPaletteItems(C_MAJOR, 5)[0].tones).toEqual([0, 1, 2, 3, 4]);
    });
  });

  describe("getPaletteItems - triads", () => {
    const items = getPaletteItems(C_MAJOR, 3);

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
      expect(getPaletteItems(A_MINOR, 3).map((i) => i.label)).toEqual([
        "Am", "B°", "C", "Dm", "Em", "F", "G",
      ]);
    });

    it("keeps every degree of C major in the chosen octave", () => {
      expect(getPaletteItems(C_MAJOR, 3, 4).map((i) => i.octave)).toEqual([
        4, 4, 4, 4, 4, 4, 4,
      ]);
    });

    it("voices the chosen octave from the root note, not the whole scale", () => {
      // D major at octave 4: the vii° is a C#, which sits *above* the D tonic and
      // so belongs in octave 5 — voicing it at 4 would leap a semitone downward.
      const dMajor = getPaletteItems({ root: "D", type: "major" }, 3, 4);
      expect(dMajor.map((i) => i.label)).toEqual([
        "D", "Em", "F#m", "G", "A", "Bm", "C#°",
      ]);
      expect(dMajor.map((i) => i.octave)).toEqual([4, 4, 4, 4, 4, 4, 5]);
    });

    it("carries A minor's upper degrees into the next octave", () => {
      expect(getPaletteItems(A_MINOR, 3, 4).map((i) => i.octave)).toEqual([
        4, 4, 5, 5, 5, 5, 5,
      ]);
    });

    it("clamps a wrapped degree to the highest register a segment may hold", () => {
      const dMajor = getPaletteItems({ root: "D", type: "major" }, 3, 7);
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

  describe("getPaletteItems - sevenths", () => {
    const items = getPaletteItems(C_MAJOR, 4);

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
      expect(getPaletteItems(A_MINOR, 4).map((i) => i.label)).toEqual([
        "Am7", "Bø7", "Cmaj7", "Dm7", "Em7", "Fmaj7", "G7",
      ]);
    });

    it("voices sevenths from the root note too", () => {
      const dMajor = getPaletteItems({ root: "D", type: "major" }, 4, 4);
      expect(dMajor[6].label).toBe("C#ø7");
      expect(dMajor.map((i) => i.octave)).toEqual([4, 4, 4, 4, 4, 4, 5]);
    });
  });

  describe("getPaletteItems - non-heptatonic scales", () => {
    it("returns 5 items for a pentatonic scale with no undefined qualities", () => {
      const items = getPaletteItems({ root: "C", type: "pentatonicMajor" }, 3);
      expect(items).toHaveLength(5);
      items.forEach((item) => {
        expect(item.quality).toBeDefined();
        expect(item.label).toBeString();
        expect(item.degreeLabel).toBeString();
      });
    });

    it("returns 6 items for the blues scale", () => {
      expect(getPaletteItems({ root: "C", type: "blues" }, 1)).toHaveLength(6);
    });
  });

  describe("paletteItemToSegment", () => {
    it("converts a chord item into a chord segment", () => {
      const item = getPaletteItems(C_MAJOR, 3)[1]; // Dm
      const segment = paletteItemToSegment(item, 1, C_MAJOR);
      expect(segment.kind).toBe("chord");
      expect(segment.duration).toBe(1);
      expect(segment.root).toBe("D");
      expect(segment.quality).toBe("minor");
      expect(segment.chordSymbol).toBe("Dm");
      expect(segment.romanNumeral).toBe("ii");
      expect(segment.pitch).toBeUndefined();
    });

    it("converts a one-tone item into a one-tone chord segment", () => {
      // A degree-named block is a chord at every size, so a single tone carries a
      // root and a register rather than an absolute pitch. `kind: 'note'` is now
      // only ever a recorded pitch.
      const item = getPaletteItems(C_MAJOR, 1)[2]; // E
      const segment = paletteItemToSegment(item, 2, C_MAJOR);
      expect(segment.kind).toBe("chord");
      expect(segment.duration).toBe(2);
      expect(segment.tones).toEqual([0]);
      expect(segment.root).toBe("E");
      expect(segment.chordSymbol).toBe("E");
      expect(segment.octave).toBe(4);
      expect(segment.pitch).toBeUndefined();
    });

    it("starts every block at the palette's quieter velocity", () => {
      // Half-loud rather than the 100 an unmarked segment reads as, so a sketch
      // laid out from the palette can be accented as well as eased.
      expect(PALETTE_VELOCITY).toBe(50);
      for (const size of [1, 3, 4] as const) {
        const item = getPaletteItems(C_MAJOR, size)[0];
        expect(paletteItemToSegment(item, 1, C_MAJOR).velocity).toBe(PALETTE_VELOCITY);
      }
    });

    it("carries the palette's octave onto a chord segment", () => {
      const item = getPaletteItems(C_MAJOR, 3, 6)[0];
      expect(paletteItemToSegment(item, 1, C_MAJOR).octave).toBe(6);
    });

    it("converts a seventh item, preserving the four-note quality", () => {
      const item = getPaletteItems(C_MAJOR, 4)[4]; // G7
      const segment = paletteItemToSegment(item, 1, C_MAJOR);
      expect(segment.quality).toBe("dominant7");
      expect(segment.chordSymbol).toBe("G7");
    });

    // What lets the block keep naming its own degree once the palette moves on
    // to another key, and what the inspector reads back.
    it("stamps the palette's key onto the segment", () => {
      const item = getPaletteItems(C_MAJOR, 3)[1];
      const segment = paletteItemToSegment(item, 1, { root: "A", type: "naturalMinor" });
      expect(segment.scale).toEqual({ root: "A", type: "naturalMinor" });
    });

    it("gives each produced segment a fresh unique id", () => {
      const item = getPaletteItems(C_MAJOR, 3)[0];
      const a = paletteItemToSegment(item, 1, C_MAJOR);
      const b = paletteItemToSegment(item, 1, C_MAJOR);
      expect(a.id).not.toBe(b.id);
    });
  });
});
