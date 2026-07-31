import { describe, it, expect } from "vitest";
import {
  getBarBeats,
  getBarStartBeat,
  getTotalBeats,
  flattenSegments,
  reflowSegments,
  insertSegmentAt,
  removeSegmentById,
  resizeSegment,
  beatToInsertIndex,
  MIN_SEGMENT_BEATS,
} from "@/engine/timeline";
import { Bar, ChordSegment, TimeSignature } from "@/types/music";
import { generateId } from "@/utils/id";

const TS_4_4: TimeSignature = { beatsPerMeasure: 4, beatUnit: 4 };
const TS_3_4: TimeSignature = { beatsPerMeasure: 3, beatUnit: 4 };

const makeBar = (
  barIndex: number,
  chords: ChordSegment[] = [],
  timeSignature?: TimeSignature
): Bar => ({
  id: `bar-${barIndex}`,
  barIndex,
  timeSignature,
  scale: { root: "C", type: "major" },
  chords,
  notes: [],
});

/** A chord segment with a caller-supplied id so assertions can track it. */
const seg = (id: string, duration = 1): ChordSegment => ({
  id,
  kind: "chord",
  romanNumeral: "I",
  chordSymbol: "C",
  duration,
});

describe("timeline", () => {
  describe("getBarBeats", () => {
    it("uses the bar's own time signature when present", () => {
      expect(getBarBeats(makeBar(0, [], TS_3_4), TS_4_4)).toBe(3);
    });

    it("falls back to the project time signature when the bar has none", () => {
      expect(getBarBeats(makeBar(0), TS_4_4)).toBe(4);
      expect(getBarBeats(makeBar(0), TS_3_4)).toBe(3);
    });
  });

  describe("getBarStartBeat", () => {
    it("returns 0 for the first bar", () => {
      const bars = [makeBar(0), makeBar(1)];
      expect(getBarStartBeat(bars, 0, TS_4_4)).toBe(0);
    });

    it("accumulates uniform bar lengths", () => {
      const bars = [makeBar(0), makeBar(1), makeBar(2)];
      expect(getBarStartBeat(bars, 1, TS_4_4)).toBe(4);
      expect(getBarStartBeat(bars, 2, TS_4_4)).toBe(8);
    });

    it("accumulates mixed 4/4 and 3/4 bar lengths", () => {
      // 4/4 | 3/4 | 4/4  ->  starts at 0, 4, 7
      const bars = [
        makeBar(0, [], TS_4_4),
        makeBar(1, [], TS_3_4),
        makeBar(2, [], TS_4_4),
      ];
      expect(getBarStartBeat(bars, 0, TS_4_4)).toBe(0);
      expect(getBarStartBeat(bars, 1, TS_4_4)).toBe(4);
      expect(getBarStartBeat(bars, 2, TS_4_4)).toBe(7);
    });
  });

  describe("getTotalBeats", () => {
    it("sums uniform bars", () => {
      expect(getTotalBeats([makeBar(0), makeBar(1)], TS_4_4)).toBe(8);
    });

    it("sums mixed meters", () => {
      const bars = [makeBar(0, [], TS_4_4), makeBar(1, [], TS_3_4)];
      expect(getTotalBeats(bars, TS_4_4)).toBe(7);
    });

    it("returns 0 for no bars", () => {
      expect(getTotalBeats([], TS_4_4)).toBe(0);
    });
  });

  describe("flattenSegments", () => {
    it("concatenates every bar's segments in bar order", () => {
      const bars = [
        makeBar(0, [seg("a"), seg("b")]),
        makeBar(1, [seg("c")]),
      ];
      expect(flattenSegments(bars).map((s) => s.id)).toEqual(["a", "b", "c"]);
    });

    it("returns an empty list when no bar has segments", () => {
      expect(flattenSegments([makeBar(0), makeBar(1)])).toEqual([]);
    });
  });

  describe("reflowSegments", () => {
    it("fills a 4/4 bar with four 1-beat segments", () => {
      const bars = [makeBar(0), makeBar(1)];
      const segments = [seg("a"), seg("b"), seg("c"), seg("d")];
      const result = reflowSegments(segments, bars, TS_4_4);
      expect(result[0].chords.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
      expect(result[1].chords).toEqual([]);
    });

    it("pushes the fifth segment into the following bar", () => {
      const bars = [makeBar(0), makeBar(1)];
      const segments = [seg("a"), seg("b"), seg("c"), seg("d"), seg("e")];
      const result = reflowSegments(segments, bars, TS_4_4);
      expect(result[0].chords.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
      expect(result[1].chords.map((s) => s.id)).toEqual(["e"]);
    });

    it("moves a segment wholly to the next bar rather than splitting it", () => {
      // 3 beats used, then a 2-beat segment that cannot fit in the remaining 1 beat.
      const bars = [makeBar(0), makeBar(1)];
      const segments = [seg("a"), seg("b"), seg("c"), seg("wide", 2)];
      const result = reflowSegments(segments, bars, TS_4_4);
      expect(result[0].chords.map((s) => s.id)).toEqual(["a", "b", "c"]);
      expect(result[1].chords.map((s) => s.id)).toEqual(["wide"]);
      // The 2-beat segment kept its full duration — no tie, no split.
      expect(result[1].chords[0].duration).toBe(2);
    });

    it("appends new bars when segments overflow the last bar", () => {
      const bars = [makeBar(0)];
      const segments = [
        seg("a"), seg("b"), seg("c"), seg("d"),
        seg("e"), seg("f"),
      ];
      const result = reflowSegments(segments, bars, TS_4_4);
      expect(result).toHaveLength(2);
      expect(result[1].chords.map((s) => s.id)).toEqual(["e", "f"]);
      expect(result[1].barIndex).toBe(1);
    });

    it("respects a narrower per-bar time signature", () => {
      // Bar 0 is 3/4, so the fourth segment spills into bar 1.
      const bars = [makeBar(0, [], TS_3_4), makeBar(1)];
      const segments = [seg("a"), seg("b"), seg("c"), seg("d")];
      const result = reflowSegments(segments, bars, TS_4_4);
      expect(result[0].chords.map((s) => s.id)).toEqual(["a", "b", "c"]);
      expect(result[1].chords.map((s) => s.id)).toEqual(["d"]);
    });

    it("never drops a segment", () => {
      const bars = [makeBar(0)];
      const segments = Array.from({ length: 11 }, (_, i) => seg(`s${i}`));
      const result = reflowSegments(segments, bars, TS_4_4);
      expect(flattenSegments(result)).toHaveLength(11);
    });

    it("preserves each bar's notes, scale and id", () => {
      const bars = [makeBar(0), makeBar(1)];
      bars[0].notes = [
        { id: "n1", pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
      ];
      bars[0].scale = { root: "D", type: "dorian" };
      const result = reflowSegments([seg("a")], bars, TS_4_4);
      expect(result[0].notes).toHaveLength(1);
      expect(result[0].scale).toEqual({ root: "D", type: "dorian" });
      expect(result[0].id).toBe("bar-0");
    });

    it("empties trailing bars when all segments are removed", () => {
      const bars = [makeBar(0, [seg("a")]), makeBar(1, [seg("b")])];
      const result = reflowSegments([], bars, TS_4_4);
      expect(result[0].chords).toEqual([]);
      expect(result[1].chords).toEqual([]);
    });

    it("keeps at least one bar even with no segments", () => {
      expect(reflowSegments([], [], TS_4_4).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("insertSegmentAt", () => {
    it("inserts at the given index", () => {
      const segments = [seg("a"), seg("b")];
      const result = insertSegmentAt(segments, seg("x"), 1);
      expect(result.map((s) => s.id)).toEqual(["a", "x", "b"]);
    });

    it("appends when the index is past the end", () => {
      const result = insertSegmentAt([seg("a")], seg("x"), 99);
      expect(result.map((s) => s.id)).toEqual(["a", "x"]);
    });

    it("prepends at index 0 and does not mutate the input", () => {
      const segments = [seg("a")];
      const result = insertSegmentAt(segments, seg("x"), 0);
      expect(result.map((s) => s.id)).toEqual(["x", "a"]);
      expect(segments.map((s) => s.id)).toEqual(["a"]);
    });
  });

  describe("removeSegmentById", () => {
    it("removes the matching segment", () => {
      const result = removeSegmentById([seg("a"), seg("b")], "a");
      expect(result.map((s) => s.id)).toEqual(["b"]);
    });

    it("is a no-op for an unknown id", () => {
      const result = removeSegmentById([seg("a")], "nope");
      expect(result.map((s) => s.id)).toEqual(["a"]);
    });
  });

  describe("resizeSegment", () => {
    it("sets a new duration", () => {
      const result = resizeSegment([seg("a")], "a", 2);
      expect(result[0].duration).toBe(2);
    });

    it("snaps to the grid step", () => {
      const result = resizeSegment([seg("a")], "a", 1.3);
      expect(result[0].duration).toBe(1.25);
    });

    it("clamps to at least one grid step", () => {
      const result = resizeSegment([seg("a")], "a", 0);
      expect(result[0].duration).toBe(MIN_SEGMENT_BEATS);
    });

    it("clamps to the max beats when given one", () => {
      const result = resizeSegment([seg("a")], "a", 99, 4);
      expect(result[0].duration).toBe(4);
    });

    it("leaves other segments untouched", () => {
      const result = resizeSegment([seg("a"), seg("b")], "a", 2);
      expect(result[1].duration).toBe(1);
    });
  });

  describe("beatToInsertIndex", () => {
    const segments = [seg("a"), seg("b"), seg("c")]; // 1 beat each: [0,1) [1,2) [2,3)

    it("returns 0 at the very start", () => {
      expect(beatToInsertIndex(segments, 0)).toBe(0);
    });

    it("returns the index of the segment the beat falls in front of", () => {
      expect(beatToInsertIndex(segments, 1)).toBe(1);
      expect(beatToInsertIndex(segments, 2)).toBe(2);
    });

    it("rounds to the nearest boundary within a segment", () => {
      // 1.4 is nearer the start of segment b's slot than its end
      expect(beatToInsertIndex(segments, 1.4)).toBe(1);
      expect(beatToInsertIndex(segments, 1.6)).toBe(2);
    });

    it("returns the length when the beat is past the end", () => {
      expect(beatToInsertIndex(segments, 99)).toBe(3);
    });

    it("returns 0 for an empty list", () => {
      expect(beatToInsertIndex([], 5)).toBe(0);
    });
  });
});
