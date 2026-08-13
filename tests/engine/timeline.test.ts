import { describe, it, expect } from "vitest";
import {
  getBarBeats,
  getBarStartBeat,
  getMeterPulse,
  getTotalBeats,
  timeSignatureBeats,
  flattenSegments,
  removeSegmentById,
  resizeSegment,
  snapBeat,
  clampStartToBar,
  withStartBeats,
  placeSegmentInBar,
  refitBars,
  clearRange,
  SNAP_OPTIONS,
  DEFAULT_SNAP_BEATS,
  MIN_SEGMENT_BEATS,
  barChords,
  barNotes,
} from "@/engine/timeline";
import { Bar, ChordSegment, TimeSignature } from "@/types/music";
import { OTHER_TRACK_ID, soloContent, TEST_TRACK_ID } from "../helpers/tracks";

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
  content: soloContent(chords),
});

/** A chord segment with a caller-supplied id so assertions can track it. */
const seg = (id: string, duration = 1, startBeat?: number, lane?: number): ChordSegment => ({
  id,
  kind: "chord",
  startBeat,
  lane,
  romanNumeral: "I",
  chordSymbol: "C",
  duration,
});

/** Compact `id@start+duration` rendering, so ripple assertions read at a glance. */
const layout = (segments: ChordSegment[]): string[] =>
  segments.map((s) => `${s.id}@${s.startBeat}+${s.duration}`);

/** The same, with the sub-lane appended, for assertions that are about lanes. */
const laneLayout = (segments: ChordSegment[]): string[] =>
  segments.map((s) => `${s.id}@${s.startBeat}+${s.duration}/${s.lane ?? 0}`);

describe("timeline", () => {
  describe("getBarBeats", () => {
    it("uses the bar's own time signature when present", () => {
      expect(getBarBeats(makeBar(0, [], TS_3_4), TS_4_4)).toBe(3);
    });

    it("falls back to the project time signature when the bar has none", () => {
      expect(getBarBeats(makeBar(0), TS_4_4)).toBe(4);
      expect(getBarBeats(makeBar(0), TS_3_4)).toBe(3);
    });

    it("scales by the denominator, so a beat is always a quarter note", () => {
      // Six eighths are three quarters — a 6/8 bar is exactly as long as a 3/4 one.
      expect(timeSignatureBeats({ beatsPerMeasure: 6, beatUnit: 8 })).toBe(3);
      expect(timeSignatureBeats({ beatsPerMeasure: 3, beatUnit: 4 })).toBe(3);
      expect(timeSignatureBeats({ beatsPerMeasure: 12, beatUnit: 8 })).toBe(6);
      expect(timeSignatureBeats({ beatsPerMeasure: 7, beatUnit: 8 })).toBe(3.5);
      expect(timeSignatureBeats({ beatsPerMeasure: 2, beatUnit: 2 })).toBe(4);
      expect(timeSignatureBeats({ beatsPerMeasure: 4, beatUnit: 16 })).toBe(1);
    });
  });

  describe("getMeterPulse", () => {
    const pulseOf = (beatsPerMeasure: number, beatUnit: number) =>
      getMeterPulse({ beatsPerMeasure, beatUnit });

    it("gives a simple metre one beat per denominator unit", () => {
      expect(pulseOf(4, 4)).toEqual({
        pulseBeats: 1,
        pulseCount: 4,
        subdivisionBeats: 0.5,
        subdivisionsPerPulse: 2,
      });
      expect(pulseOf(2, 2)).toEqual({
        pulseBeats: 2,
        pulseCount: 2,
        subdivisionBeats: 1,
        subdivisionsPerPulse: 2,
      });
    });

    it("groups a compound metre in threes", () => {
      // 6/8 is two dotted-quarter beats, not six eighth beats and not three quarters.
      expect(pulseOf(6, 8)).toEqual({
        pulseBeats: 1.5,
        pulseCount: 2,
        subdivisionBeats: 0.5,
        subdivisionsPerPulse: 3,
      });
      expect(pulseOf(12, 8)).toMatchObject({ pulseBeats: 1.5, pulseCount: 4 });
      expect(pulseOf(9, 8)).toMatchObject({ pulseBeats: 1.5, pulseCount: 3 });
    });

    it("distinguishes 3/4 from 6/8, which are the same length", () => {
      expect(timeSignatureBeats({ beatsPerMeasure: 3, beatUnit: 4 })).toBe(
        timeSignatureBeats({ beatsPerMeasure: 6, beatUnit: 8 })
      );
      expect(pulseOf(3, 4).pulseCount).toBe(3);
      expect(pulseOf(6, 8).pulseCount).toBe(2);
    });

    it("leaves an irregular metre as an even grid", () => {
      // 7/8 has no equal grouping in threes, so it is not guessed at.
      expect(pulseOf(7, 8)).toMatchObject({ pulseBeats: 0.5, pulseCount: 7 });
      expect(pulseOf(5, 8)).toMatchObject({ pulseBeats: 0.5, pulseCount: 5 });
    });

    it("reads 3/8 as three eighth beats rather than one pulse", () => {
      expect(pulseOf(3, 8)).toMatchObject({ pulseBeats: 0.5, pulseCount: 3 });
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

    it("sums an eighth-denominator bar by its real length", () => {
      const bars = [makeBar(0, [], TS_4_4), makeBar(1, [], { beatsPerMeasure: 6, beatUnit: 8 })];
      // 4 + 3, not 4 + 6.
      expect(getTotalBeats(bars, TS_4_4)).toBe(7);
    });

    it("returns 0 for no bars", () => {
      expect(getTotalBeats([], TS_4_4)).toBe(0);
    });
  });

  describe("flattenSegments", () => {
    it("concatenates every bar's segments in bar order", () => {
      const bars = [makeBar(0, [seg("a"), seg("b")]), makeBar(1, [seg("c")])];
      expect(flattenSegments(bars, TEST_TRACK_ID).map((s) => s.id)).toEqual(["a", "b", "c"]);
    });

    it("returns an empty list when no bar has segments", () => {
      expect(flattenSegments([makeBar(0), makeBar(1)], TEST_TRACK_ID)).toEqual([]);
    });
  });

  describe("SNAP_OPTIONS", () => {
    it("offers whole down to thirty-second notes, in beats", () => {
      expect(SNAP_OPTIONS.map((o) => [o.label, o.beats])).toEqual([
        ["1/1", 4],
        ["1/2", 2],
        ["1/4", 1],
        ["1/8", 0.5],
        ["1/16", 0.25],
        ["1/32", 0.125],
      ]);
    });

    it("bottoms out at the shortest block that can be drawn", () => {
      const finest = SNAP_OPTIONS[SNAP_OPTIONS.length - 1].beats;
      expect(finest).toBe(MIN_SEGMENT_BEATS);
    });

    it("defaults to one beat, and the default is one of the options", () => {
      expect(DEFAULT_SNAP_BEATS).toBe(1);
      expect(SNAP_OPTIONS.some((o) => o.beats === DEFAULT_SNAP_BEATS)).toBe(true);
    });

    it("never offers a step finer than the minimum segment length", () => {
      for (const option of SNAP_OPTIONS) {
        expect(option.beats).toBeGreaterThanOrEqual(MIN_SEGMENT_BEATS);
      }
    });
  });

  describe("snapBeat", () => {
    it("rounds to the nearest whole beat at 1/4", () => {
      expect(snapBeat(1.4, 1)).toBe(1);
      expect(snapBeat(1.6, 1)).toBe(2);
    });

    it("rounds to half beats at 1/8", () => {
      expect(snapBeat(1.4, 0.5)).toBe(1.5);
      expect(snapBeat(1.2, 0.5)).toBe(1);
    });

    it("rounds to quarter beats at 1/16 without float drift", () => {
      // 1.4 / 0.25 = 5.6 -> 6 -> 1.5, and must be exactly 1.5, not 1.5000000000000002.
      expect(snapBeat(1.4, 0.25)).toBe(1.5);
      expect(snapBeat(0.3, 0.25)).toBe(0.25);
    });

    it("rounds to two beats at 1/2 and four at 1/1", () => {
      expect(snapBeat(1.3, 2)).toBe(2);
      expect(snapBeat(2.9, 2)).toBe(2);
      expect(snapBeat(1.9, 4)).toBe(0);
      expect(snapBeat(2.1, 4)).toBe(4);
    });

    it("never returns a negative beat", () => {
      expect(snapBeat(-3, 1)).toBe(0);
    });

    it("passes a value already on the grid through unchanged", () => {
      expect(snapBeat(2, 1)).toBe(2);
      expect(snapBeat(2.5, 0.5)).toBe(2.5);
    });
  });

  describe("clampStartToBar", () => {
    it("lets a block's tail cross the bar line", () => {
      // A 2-beat block dropped at 3.5 in 4/4 stays at 3.5 and hangs into bar 2.
      expect(clampStartToBar(3.5, 4)).toBe(3.5);
      // Even a block longer than the bar itself keeps the beat it was dropped on.
      expect(clampStartToBar(2, 4)).toBe(2);
    });

    it("keeps the onset inside the bar", () => {
      // The bar line itself is the next bar's beat 0, so a block cannot start there.
      expect(clampStartToBar(4, 4)).toBe(4 - MIN_SEGMENT_BEATS);
      expect(clampStartToBar(9, 4)).toBe(4 - MIN_SEGMENT_BEATS);
    });

    it("never goes below the start of the bar", () => {
      expect(clampStartToBar(-1, 4)).toBe(0);
    });

    it("pulls a snap that overshoots the bar back inside it", () => {
      // 1/1 snap in 3/4: snapping lands on 4, past the bar's three beats.
      expect(clampStartToBar(snapBeat(2.5, 4), 3)).toBe(3 - MIN_SEGMENT_BEATS);
    });
  });

  describe("withStartBeats", () => {
    it("packs segments that carry no position, as the old packed list implied", () => {
      const result = withStartBeats([seg("a"), seg("b", 2), seg("c")]);
      expect(layout(result)).toEqual(["a@0+1", "b@1+2", "c@3+1"]);
    });

    it("leaves explicit positions alone, gaps included", () => {
      const result = withStartBeats([seg("a", 1, 0), seg("b", 1, 3)]);
      expect(layout(result)).toEqual(["a@0+1", "b@3+1"]);
    });

    it("resumes packing after an explicitly positioned segment", () => {
      const result = withStartBeats([seg("a", 1, 2), seg("b")]);
      expect(layout(result)).toEqual(["a@2+1", "b@3+1"]);
    });

    it("does not mutate its input", () => {
      const segments = [seg("a")];
      withStartBeats(segments);
      expect(segments[0].startBeat).toBeUndefined();
    });

    it("returns an empty list unchanged", () => {
      expect(withStartBeats([])).toEqual([]);
    });
  });

  describe("placeSegmentInBar", () => {
    const packed = () => [seg("c", 1, 0), seg("am", 1, 1), seg("f", 1, 2)];

    it("places a block into empty space without touching anything", () => {
      expect(layout(placeSegmentInBar([seg("c", 1, 0)], seg("g"), 3))).toEqual([
        "c@0+1",
        "g@3+1",
      ]);
    });

    it("pushes an overlapped neighbour, and its neighbours, to the right", () => {
      expect(layout(placeSegmentInBar(packed(), seg("g"), 1))).toEqual([
        "c@0+1",
        "g@1+1",
        "am@2+1",
        "f@3+1",
      ]);
    });

    it("leaves blocks that end before the drop untouched", () => {
      const kept = placeSegmentInBar(packed(), seg("g"), 2);
      expect(layout(kept).slice(0, 2)).toEqual(["c@0+1", "am@1+1"]);
    });

    it("pushes a block that starts before the drop but overlaps it", () => {
      // A 2-beat block at 0 is not "before" a drop at beat 1 — it sits under it.
      const kept = placeSegmentInBar([seg("wide", 2, 0)], seg("g"), 1);
      expect(layout(kept)).toEqual(["g@1+1", "wide@2+2"]);
    });

    it("stops the cascade at a gap wide enough to absorb the shift", () => {
      // c@0, am@1, then a gap, then f@3. Dropping on am shifts am into the gap only.
      const segments = [seg("c", 1, 0), seg("am", 1, 1), seg("f", 1, 3)];
      expect(layout(placeSegmentInBar(segments, seg("g"), 1))).toEqual([
        "c@0+1",
        "g@1+1",
        "am@2+1",
        "f@3+1",
      ]);
    });

    it("ripples a block past the bar line rather than dropping it", () => {
      // Positions past the bar's four beats are simply positions further along;
      // `refitBars` is what re-homes `f` into the next bar.
      const segments = [seg("c", 1, 0), seg("am", 1, 1), seg("f", 1, 3)];
      expect(layout(placeSegmentInBar(segments, seg("g", 2), 1))).toEqual([
        "c@0+1",
        "g@1+2",
        "am@3+1",
        "f@4+1",
      ]);
    });

    it("replaces a block already in the bar rather than duplicating it", () => {
      // Moving a block within its own bar goes through the same call.
      const kept = placeSegmentInBar(packed(), seg("c", 1), 3);
      expect(kept.filter((s) => s.id === "c")).toHaveLength(1);
      expect(layout(kept)).toEqual(["am@1+1", "f@2+1", "c@3+1"]);
    });

    it("returns blocks sorted by position", () => {
      const kept = placeSegmentInBar([seg("late", 1, 3)], seg("early"), 0);
      expect(kept.map((s) => s.id)).toEqual(["early", "late"]);
    });

    it("does not mutate the input list", () => {
      const segments = packed();
      placeSegmentInBar(segments, seg("g"), 1);
      expect(layout(segments)).toEqual(["c@0+1", "am@1+1", "f@2+1"]);
    });

    // A lane is the only thing that makes two blocks rivals for a beat. Blocks in
    // other lanes are not in the way, so the ripple must not see them at all.
    describe("sub-lanes", () => {
      it("drops a block onto an occupied beat in another lane without rippling", () => {
        const kept = placeSegmentInBar([seg("c", 2, 0, 0)], seg("g", 2, undefined, 1), 0);
        expect(laneLayout(kept)).toEqual(["c@0+2/0", "g@0+2/1"]);
      });

      it("ripples only the blocks sharing the placed block's lane", () => {
        const segments = [seg("lo", 1, 1, 0), seg("hi", 1, 1, 1)];
        expect(laneLayout(placeSegmentInBar(segments, seg("g", 1, undefined, 0), 1))).toEqual([
          "g@1+1/0",
          "hi@1+1/1",
          "lo@2+1/0",
        ]);
      });

      it("moves a block between lanes rather than leaving a copy behind", () => {
        const kept = placeSegmentInBar([seg("c", 1, 0, 0)], seg("c", 1, undefined, 1), 0);
        expect(laneLayout(kept)).toEqual(["c@0+1/1"]);
      });

      it("orders blocks on the same beat by lane", () => {
        const kept = placeSegmentInBar([seg("hi", 1, 0, 2)], seg("lo", 1, undefined, 0), 0);
        expect(kept.map((s) => s.id)).toEqual(["lo", "hi"]);
      });
    });
  });

  describe("refitBars", () => {
    it("leaves a legal project untouched", () => {
      const bars = [makeBar(0, [seg("a", 1, 0), seg("b", 1, 2)])];
      const result = refitBars(bars, TS_4_4);
      expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["a@0+1", "b@2+1"]);
    });

    it("preserves the silence between blocks", () => {
      const bars = [makeBar(0, [seg("a", 1, 3)])];
      expect(layout(barChords(refitBars(bars, TS_4_4)[0], TEST_TRACK_ID))).toEqual(["a@3+1"]);
    });

    it("pushes a block that no longer fits into the next bar at beat 0", () => {
      const bars = [makeBar(0, [seg("a", 2, 0), seg("b", 2, 2), seg("c", 2, 3)])];
      const result = refitBars(bars, TS_4_4);
      expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["a@0+2", "b@2+2"]);
      expect(layout(barChords(result[1], TEST_TRACK_ID))).toEqual(["c@0+2"]);
    });

    it("appends a bar when the overflow has nowhere to go", () => {
      const bars = [makeBar(0, [seg("a", 4, 0), seg("b", 4, 0)])];
      const result = refitBars(bars, TS_4_4);
      expect(result).toHaveLength(2);
      expect(result[1].barIndex).toBe(1);
      expect(barChords(result[1], TEST_TRACK_ID).map((s) => s.id)).toEqual(["b"]);
    });

    it("squeezes a bar narrowed by a time-signature change", () => {
      // A 3/4 bar cannot hold four 1-beat blocks; the fourth moves on.
      const bars = [
        makeBar(0, [seg("a", 1, 0), seg("b", 1, 1), seg("c", 1, 2), seg("d", 1, 3)], TS_3_4),
        makeBar(1),
      ];
      const result = refitBars(bars, TS_4_4);
      expect(barChords(result[0], TEST_TRACK_ID).map((s) => s.id)).toEqual(["a", "b", "c"]);
      expect(layout(barChords(result[1], TEST_TRACK_ID))).toEqual(["d@0+1"]);
    });

    it("carries overflow in front of the next bar's own blocks", () => {
      const bars = [
        makeBar(0, [seg("a", 4, 0), seg("spill", 2, 0)]),
        makeBar(1, [seg("b", 1, 0)]),
      ];
      const result = refitBars(bars, TS_4_4);
      expect(layout(barChords(result[1], TEST_TRACK_ID))).toEqual(["spill@0+2", "b@2+1"]);
    });

    it("removes an overlap by shifting the later block right", () => {
      const bars = [makeBar(0, [seg("a", 2, 0), seg("b", 1, 1)])];
      expect(layout(barChords(refitBars(bars, TS_4_4)[0], TEST_TRACK_ID))).toEqual(["a@0+2", "b@2+1"]);
    });

    it("keeps a block longer than its bar rather than looping forever", () => {
      const bars = [makeBar(0, [seg("huge", 6, 0)], TS_3_4)];
      const result = refitBars(bars, TS_4_4);
      expect(flattenSegments(result, TEST_TRACK_ID).map((s) => s.id)).toEqual(["huge"]);
    });

    // A segment's *onset* belongs to one bar; how long it rings afterwards is its
    // own business. These are the cases the old bar clamp made unreachable.
    it("leaves a block hanging over the bar line where it was put", () => {
      const bars = [makeBar(0, [seg("held", 3, 3)]), makeBar(1)];
      const result = refitBars(bars, TS_4_4);
      expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["held@3+3"]);
      expect(barChords(result[1], TEST_TRACK_ID)).toEqual([]);
    });

    it("starts the next block after an overhang, in whichever bar that lands in", () => {
      const bars = [makeBar(0, [seg("held", 3, 3)]), makeBar(1, [seg("next", 1, 0)])];
      const result = refitBars(bars, TS_4_4);
      expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["held@3+3"]);
      // `held` rings until beat 2 of bar 2, so `next` moves to beat 2 rather than
      // being left overlapping the downbeat.
      expect(layout(barChords(result[1], TEST_TRACK_ID))).toEqual(["next@2+1"]);
    });

    it("re-homes a block whose onset was pushed over the bar line", () => {
      // `a` grows to fill the bar, pushing `b`'s onset to beat 4 — which is bar 2's
      // downbeat, not bar 1's last legal beat.
      const bars = [makeBar(0, [seg("a", 4, 0), seg("b", 1, 2)]), makeBar(1)];
      const result = refitBars(bars, TS_4_4);
      expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["a@0+4"]);
      expect(layout(barChords(result[1], TEST_TRACK_ID))).toEqual(["b@0+1"]);
    });

    it("keeps the beat a pushed block landed on rather than resetting it", () => {
      const bars = [makeBar(0, [seg("a", 5, 0), seg("b", 1, 2)]), makeBar(1)];
      const result = refitBars(bars, TS_4_4);
      // `a` ends at beat 1 of bar 2, so `b` starts there — not at the downbeat.
      expect(layout(barChords(result[1], TEST_TRACK_ID))).toEqual(["b@1+1"]);
    });

    it("grows the project to contain a block hanging off the end", () => {
      const bars = [makeBar(0, [seg("long", 7, 2)])];
      const result = refitBars(bars, TS_4_4);
      // The block rings to beat 9, so the song must be at least three bars long.
      expect(result).toHaveLength(3);
      expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["long@2+7"]);
    });

    it("is idempotent over a block that crosses a bar line", () => {
      const bars = [makeBar(0, [seg("held", 3, 3)]), makeBar(1, [seg("next", 1, 0)])];
      const once = refitBars(bars, TS_4_4);
      expect(refitBars(once, TS_4_4)).toEqual(once);
    });

    it("never drops a segment", () => {
      const chords = Array.from({ length: 11 }, (_, i) => seg(`s${i}`, 1, 0));
      const result = refitBars([makeBar(0, chords)], TS_4_4);
      expect(flattenSegments(result, TEST_TRACK_ID)).toHaveLength(11);
    });

    it("preserves each bar's notes, id and meter", () => {
      const bars = [makeBar(0, [seg("a", 1, 0)], TS_3_4)];
      bars[0].content[TEST_TRACK_ID].notes = [
        { id: "n1", pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
      ];
      const result = refitBars(bars, TS_4_4);
      expect(barNotes(result[0], TEST_TRACK_ID)).toHaveLength(1);
      expect(result[0].id).toBe("bar-0");
      expect(result[0].timeSignature).toEqual(TS_3_4);
    });

    it("fills in positions for segments that carry none", () => {
      const bars = [makeBar(0, [seg("a"), seg("b")])];
      expect(layout(barChords(refitBars(bars, TS_4_4)[0], TEST_TRACK_ID))).toEqual(["a@0+1", "b@1+1"]);
    });

    it("returns no bars for no bars", () => {
      expect(refitBars([], TS_4_4)).toEqual([]);
    });

    // The non-overlap rule is per *lane*, not per instrument: two blocks may share
    // a beat as long as they are stacked, which is the whole reason lanes exist.
    describe("per-lane isolation", () => {
      it("leaves two blocks on the same beat in different lanes alone", () => {
        const bars = [makeBar(0, [seg("lo", 2, 0, 0), seg("hi", 2, 0, 1)])];
        const result = refitBars(bars, TS_4_4);
        expect(laneLayout(barChords(result[0], TEST_TRACK_ID))).toEqual([
          "lo@0+2/0",
          "hi@0+2/1",
        ]);
      });

      it("keeps a whole chord's worth of blocks stacked on one beat", () => {
        const chord = [seg("c", 2, 0, 0), seg("e", 2, 0, 1), seg("g", 2, 0, 2)];
        const result = refitBars([makeBar(0, chord)], TS_4_4);
        expect(result).toHaveLength(1);
        expect(barChords(result[0], TEST_TRACK_ID).map((s) => s.startBeat)).toEqual([0, 0, 0]);
      });

      it("pushes an overlap apart within a lane and only within it", () => {
        const bars = [makeBar(0, [seg("a", 2, 0, 0), seg("b", 1, 1, 0), seg("hi", 1, 1, 1)])];
        const result = refitBars(bars, TS_4_4);
        expect(laneLayout(barChords(result[0], TEST_TRACK_ID))).toEqual([
          "a@0+2/0",
          "hi@1+1/1",
          "b@2+1/0",
        ]);
      });

      it("overflows one lane into the next bar without disturbing another", () => {
        const bars = [makeBar(0, [seg("a", 4, 0, 0), seg("b", 4, 0, 0), seg("hi", 1, 0, 1)])];
        const result = refitBars(bars, TS_4_4);
        expect(laneLayout(barChords(result[0], TEST_TRACK_ID))).toEqual(["a@0+4/0", "hi@0+1/1"]);
        expect(laneLayout(barChords(result[1], TEST_TRACK_ID))).toEqual(["b@0+4/0"]);
      });

      it("packs positionless blocks lane by lane", () => {
        // Two lanes of two, none positioned: each lane packs from its own beat 0.
        const bars = [
          makeBar(0, [
            seg("a", 1, undefined, 0),
            seg("x", 1, undefined, 1),
            seg("b", 1, undefined, 0),
            seg("y", 1, undefined, 1),
          ]),
        ];
        expect(laneLayout(barChords(refitBars(bars, TS_4_4)[0], TEST_TRACK_ID))).toEqual([
          "a@0+1/0",
          "x@0+1/1",
          "b@1+1/0",
          "y@1+1/1",
        ]);
      });

      it("is idempotent over stacked lanes", () => {
        const bars = [makeBar(0, [seg("lo", 2, 0, 0), seg("hi", 3, 1, 1)]), makeBar(1)];
        const once = refitBars(bars, TS_4_4);
        expect(refitBars(once, TS_4_4)).toEqual(once);
      });
    });

    // Instruments share bars but not lanes: the whole point of refitting each
    // track's list on its own is that one instrument's ripple cannot move
    // another's blocks, even when they sit on exactly the same beats.
    describe("per-instrument isolation", () => {
      const twoTrackBar = (): Bar => ({
        id: "bar-0",
        barIndex: 0,
        content: {
          [TEST_TRACK_ID]: { chords: [seg("a", 2, 0), seg("b", 2, 2)], notes: [] },
          [OTHER_TRACK_ID]: { chords: [seg("x", 2, 0), seg("y", 2, 2)], notes: [] },
        },
      });

      it("leaves another instrument's blocks where they are", () => {
        const bars = [twoTrackBar()];
        // `a` grows over `b`, so `b` is pushed along — to beat 3, from where its
        // two beats hang over the bar line into bar 2.
        bars[0].content[TEST_TRACK_ID].chords = [seg("a", 3, 0), seg("b", 2, 1)];

        const result = refitBars(bars, TS_4_4, [TEST_TRACK_ID, OTHER_TRACK_ID]);

        expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["a@0+3", "b@3+2"]);
        // The other instrument is untouched by all of that.
        expect(layout(barChords(result[0], OTHER_TRACK_ID))).toEqual(["x@0+2", "y@2+2"]);
      });

      it("lets each instrument fill the same bar independently", () => {
        const result = refitBars([twoTrackBar()], TS_4_4, [TEST_TRACK_ID, OTHER_TRACK_ID]);

        // Both instruments use the full bar; neither pushes the other along.
        expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["a@0+2", "b@2+2"]);
        expect(layout(barChords(result[0], OTHER_TRACK_ID))).toEqual(["x@0+2", "y@2+2"]);
      });

      it("appends only as many bars as the longest instrument needs", () => {
        const bars = [twoTrackBar()];
        // Five one-beat blocks overrun a 4/4 bar by one, on one instrument only.
        bars[0].content[TEST_TRACK_ID].chords = Array.from({ length: 5 }, (_, i) =>
          seg(`s${i}`, 1, i)
        );

        const result = refitBars(bars, TS_4_4, [TEST_TRACK_ID, OTHER_TRACK_ID]);

        expect(result).toHaveLength(2);
        expect(barChords(result[1], TEST_TRACK_ID).map(s => s.id)).toEqual(["s4"]);
        // The other instrument gains no content in the bar it did not overflow into.
        expect(barChords(result[1], OTHER_TRACK_ID)).toEqual([]);
      });
    });
  });

  describe("clearRange", () => {
    /** Two instruments in one bar, so the punch can be shown to spare the other. */
    const twoTracks = (chords: ChordSegment[], others: ChordSegment[]): Bar => ({
      id: "bar-0",
      barIndex: 0,
      content: {
        [TEST_TRACK_ID]: { chords, notes: [] },
        [OTHER_TRACK_ID]: { chords: others, notes: [] },
      },
    });

    it("drops a block wholly inside the range", () => {
      const bars = [makeBar(0, [seg("a", 1, 0), seg("b", 1, 1), seg("c", 1, 3)])];
      const result = clearRange(bars, TS_4_4, TEST_TRACK_ID, 1, 2);
      expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["a@0+1", "c@3+1"]);
    });

    it("punches only the named lane, sparing the ones stacked with it", () => {
      const bars = [makeBar(0, [seg("lo", 4, 0, 0), seg("hi", 4, 0, 1)])];
      const result = clearRange(bars, TS_4_4, TEST_TRACK_ID, 0, 4, undefined, 1);
      expect(laneLayout(barChords(result[0], TEST_TRACK_ID))).toEqual(["lo@0+4/0"]);
    });

    it("punches every lane when none is named", () => {
      const bars = [makeBar(0, [seg("lo", 4, 0, 0), seg("hi", 4, 0, 1)])];
      const result = clearRange(bars, TS_4_4, TEST_TRACK_ID, 0, 4);
      expect(barChords(result[0], TEST_TRACK_ID)).toEqual([]);
    });

    it("trims a block whose tail runs into the range", () => {
      const bars = [makeBar(0, [seg("a", 3, 0)])];
      const result = clearRange(bars, TS_4_4, TEST_TRACK_ID, 2, 4);
      expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["a@0+2"]);
    });

    it("trims a block whose head lies inside the range", () => {
      const bars = [makeBar(0, [seg("a", 3, 1)])];
      const result = clearRange(bars, TS_4_4, TEST_TRACK_ID, 0, 2);
      expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["a@2+2"]);
    });

    it("keeps only the head of a block spanning the whole range", () => {
      const bars = [makeBar(0, [seg("a", 4, 0)])];
      const result = clearRange(bars, TS_4_4, TEST_TRACK_ID, 1, 2);
      expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["a@0+1"]);
    });

    it("drops a block trimmed below the minimum length", () => {
      const bars = [makeBar(0, [seg("a", 1, 0)])];
      // Only 0.0625 beats would survive, which is shorter than MIN_SEGMENT_BEATS.
      const result = clearRange(bars, TS_4_4, TEST_TRACK_ID, 0.0625, 3);
      expect(barChords(result[0], TEST_TRACK_ID)).toEqual([]);
    });

    it("leaves a block touching the range only at its edge alone", () => {
      const bars = [makeBar(0, [seg("a", 1, 0), seg("b", 1, 2)])];
      const result = clearRange(bars, TS_4_4, TEST_TRACK_ID, 1, 2);
      expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["a@0+1", "b@2+1"]);
    });

    it("works in absolute beats across a bar line", () => {
      const bars = [makeBar(0, [seg("a", 1, 3)]), makeBar(1, [seg("b", 1, 0)])];
      const result = clearRange(bars, TS_4_4, TEST_TRACK_ID, 3, 5);
      expect(barChords(result[0], TEST_TRACK_ID)).toEqual([]);
      expect(barChords(result[1], TEST_TRACK_ID)).toEqual([]);
    });

    it("spares the other instrument's blocks", () => {
      const bars = [twoTracks([seg("a", 1, 0)], [seg("x", 1, 0)])];
      const result = clearRange(bars, TS_4_4, TEST_TRACK_ID, 0, 1);
      expect(barChords(result[0], TEST_TRACK_ID)).toEqual([]);
      expect(barChords(result[0], OTHER_TRACK_ID).map((s) => s.id)).toEqual(["x"]);
    });

    it("spares the segment being recorded, given its id", () => {
      const bars = [makeBar(0, [seg("take", 1, 0), seg("b", 1, 1)])];
      const result = clearRange(bars, TS_4_4, TEST_TRACK_ID, 0, 2, "take");
      expect(layout(barChords(result[0], TEST_TRACK_ID))).toEqual(["take@0+1"]);
    });

    it("is a no-op for an empty range", () => {
      const bars = [makeBar(0, [seg("a", 1, 0)])];
      expect(clearRange(bars, TS_4_4, TEST_TRACK_ID, 1, 1)).toBe(bars);
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
      const result = resizeSegment([seg("a")], "a", 2, 0.25);
      expect(result[0].duration).toBe(2);
    });

    it("snaps to the grid step", () => {
      const result = resizeSegment([seg("a")], "a", 1.3, 0.25);
      expect(result[0].duration).toBe(1.25);
    });

    it("snaps to the resolution it is given, not to the floor", () => {
      // The point of passing the grid in: at a coarse snap a resize must land on
      // that grid, not on the finest lattice the editor can represent.
      expect(resizeSegment([seg("a")], "a", 1.3, 1)[0].duration).toBe(1);
      expect(resizeSegment([seg("a")], "a", 1.3, 0.125)[0].duration).toBe(1.25);
      expect(resizeSegment([seg("a")], "a", 1.4, 0.125)[0].duration).toBe(1.375);
    });

    it("reaches a thirty-second on the finest grid", () => {
      const result = resizeSegment([seg("a")], "a", 0.125, 0.125);
      expect(result[0].duration).toBe(0.125);
    });

    it("clamps to at least one grid step", () => {
      const result = resizeSegment([seg("a")], "a", 0, 0.25);
      expect(result[0].duration).toBe(MIN_SEGMENT_BEATS);
    });

    it("clamps up rather than collapsing when the drag is under half a step", () => {
      // Snapping rounds to nearest, so a coarse grid sends a short drag to zero.
      const result = resizeSegment([seg("a")], "a", 0.1, 4);
      expect(result[0].duration).toBe(MIN_SEGMENT_BEATS);
    });

    it("clamps to the max beats when given one", () => {
      const result = resizeSegment([seg("a")], "a", 99, 0.25, 4);
      expect(result[0].duration).toBe(4);
    });

    it("leaves other segments untouched", () => {
      const result = resizeSegment([seg("a"), seg("b")], "a", 2, 0.25);
      expect(result[1].duration).toBe(1);
    });
  });
});
