import { describe, it, expect } from 'vitest';
import {
  snapToGrid,
  beatToPixel,
  pixelToBeat,
  pitchToPixel,
  pixelToPitch,
  pitchRangeHeight,
  getVisibleBars,
} from '@/engine/quantize';
import { PIANO_ROLL_MAX_MIDI, PIANO_ROLL_MIN_MIDI } from '@/utils/constants';

describe('quantize', () => {
  describe('snapToGrid', () => {
    it('snaps 0.3 to 0.25 (1/4 grid)', () => {
      expect(snapToGrid(0.3, 0.25)).toBe(0.25);
    });

    it('snaps 0.6 to 0.5 (1/2 grid)', () => {
      expect(snapToGrid(0.6, 0.5)).toBe(0.5);
    });

    it('snaps 0.125 to 0.125 (1/8 grid)', () => {
      expect(snapToGrid(0.125, 0.125)).toBe(0.125);
    });

    it('snaps 0.0625 to 0.0625 (1/16 grid)', () => {
      expect(snapToGrid(0.0625, 0.0625)).toBe(0.0625);
    });

    it('snaps to nearest beat for 1/1 grid', () => {
      expect(snapToGrid(2.7, 1)).toBe(3);
      expect(snapToGrid(2.3, 1)).toBe(2);
    });

    it('snaps 0 to 0 on any grid', () => {
      expect(snapToGrid(0, 0.25)).toBe(0);
      expect(snapToGrid(0, 0.5)).toBe(0);
      expect(snapToGrid(0, 1)).toBe(0);
    });

    it('snaps negative values correctly', () => {
      expect(snapToGrid(-0.3, 0.25)).toBe(-0.25);
      expect(snapToGrid(-0.6, 0.5)).toBe(-0.5);
    });

    it('handles fractional grid sizes', () => {
      expect(snapToGrid(0.75, 0.125)).toBe(0.75);
      expect(snapToGrid(0.8, 0.125)).toBe(0.75);
    });
  });

  describe('beatToPixel', () => {
    it('converts beat 0 to pixel 0', () => {
      expect(beatToPixel(0, 100)).toBe(0);
    });

    it('converts beat 1 to pixel 100 with 100px/beat', () => {
      expect(beatToPixel(1, 100)).toBe(100);
    });

    it('converts beat 2.5 to pixel 250 with 100px/beat', () => {
      expect(beatToPixel(2.5, 100)).toBe(250);
    });

    it('converts with different pixels per beat', () => {
      expect(beatToPixel(1, 50)).toBe(50);
      expect(beatToPixel(1, 200)).toBe(200);
    });

    it('handles fractional beats', () => {
      expect(beatToPixel(0.5, 100)).toBe(50);
      expect(beatToPixel(1.25, 100)).toBe(125);
    });

    it('handles negative beats', () => {
      expect(beatToPixel(-1, 100)).toBe(-100);
    });
  });

  describe('pixelToBeat', () => {
    it('converts pixel 0 to beat 0', () => {
      expect(pixelToBeat(0, 100)).toBe(0);
    });

    it('converts pixel 100 to beat 1 with 100px/beat', () => {
      expect(pixelToBeat(100, 100)).toBe(1);
    });

    it('converts pixel 250 to beat 2.5 with 100px/beat', () => {
      expect(pixelToBeat(250, 100)).toBe(2.5);
    });

    it('converts with different pixels per beat', () => {
      expect(pixelToBeat(50, 50)).toBe(1);
      expect(pixelToBeat(200, 200)).toBe(1);
    });

    it('handles fractional pixels', () => {
      expect(pixelToBeat(50, 100)).toBe(0.5);
      expect(pixelToBeat(125, 100)).toBe(1.25);
    });

    it('handles negative pixels', () => {
      expect(pixelToBeat(-100, 100)).toBe(-1);
    });
  });

  describe('pitchToPixel', () => {
    it('puts the top of the range (C8) at pixel 0', () => {
      expect(pitchToPixel(PIANO_ROLL_MAX_MIDI, 120)).toBe(0);
    });

    it('puts the bottom of the range (A0) at the foot of the bed', () => {
      expect(pitchToPixel(PIANO_ROLL_MIN_MIDI, 120)).toBe(870);
    });

    it('draws higher pitches above lower ones', () => {
      expect(pitchToPixel(96, 120)).toBeLessThan(pitchToPixel(60, 120));
    });

    it('places C7 one octave below C8', () => {
      expect(pitchToPixel(96, 120)).toBe(120);
    });

    it('converts with different pixels per octave', () => {
      expect(pitchToPixel(96, 50)).toBe(50);
      expect(pitchToPixel(96, 200)).toBe(200);
    });

    it('honours an explicit top note', () => {
      expect(pitchToPixel(60, 100, 60)).toBe(0);
      expect(pitchToPixel(48, 100, 60)).toBe(100);
    });

    it('handles fractional semitones', () => {
      expect(pitchToPixel(102, 100)).toBeCloseTo(50, 0);
    });
  });

  describe('pixelToPitch', () => {
    it('reads pixel 0 as the top of the range', () => {
      expect(pixelToPitch(0, 120)).toBe(PIANO_ROLL_MAX_MIDI);
    });

    it('reads the foot of the bed as the bottom of the range', () => {
      expect(pixelToPitch(870, 120)).toBe(PIANO_ROLL_MIN_MIDI);
    });

    it('round-trips pitchToPixel', () => {
      for (const midi of [PIANO_ROLL_MIN_MIDI, 48, 60, 72, PIANO_ROLL_MAX_MIDI]) {
        expect(pixelToPitch(pitchToPixel(midi, 120), 120)).toBeCloseTo(midi, 6);
      }
    });

    it('converts with different pixels per octave', () => {
      expect(pixelToPitch(50, 50)).toBe(96);
      expect(pixelToPitch(200, 200)).toBe(96);
    });

    it('honours an explicit top note', () => {
      expect(pixelToPitch(100, 100, 60)).toBe(48);
    });

    it('ceils to the key row a pixel falls inside', () => {
      // 10px per semitone: 5px down from C8's top edge is still C8.
      expect(Math.ceil(pixelToPitch(5, 120))).toBe(PIANO_ROLL_MAX_MIDI);
      expect(Math.ceil(pixelToPitch(11, 120))).toBe(PIANO_ROLL_MAX_MIDI - 1);
    });
  });

  describe('pitchRangeHeight', () => {
    it('is tall enough for all 88 keys', () => {
      expect(pitchRangeHeight(120)).toBe(880);
    });

    it('scales with the zoom level', () => {
      expect(pitchRangeHeight(60)).toBe(440);
    });
  });

  describe('getVisibleBars', () => {
    it('returns bars within viewport range', () => {
      const bars = [
        { id: '1', barIndex: 0, startBeat: 0, endBeat: 4 },
        { id: '2', barIndex: 1, startBeat: 4, endBeat: 8 },
        { id: '3', barIndex: 2, startBeat: 8, endBeat: 12 },
        { id: '4', barIndex: 3, startBeat: 12, endBeat: 16 },
      ];
      const visible = getVisibleBars({ start: 4, end: 12 }, bars);
      expect(visible.length).toBe(2);
      expect(visible[0].id).toBe('2');
      expect(visible[1].id).toBe('3');
    });

    it('returns bars that overlap viewport', () => {
      const bars = [
        { id: '1', barIndex: 0, startBeat: 0, endBeat: 4 },
        { id: '2', barIndex: 1, startBeat: 2, endBeat: 6 },
        { id: '3', barIndex: 2, startBeat: 6, endBeat: 10 },
      ];
      const visible = getVisibleBars({ start: 3, end: 7 }, bars);
      // All 3 bars overlap: bar0(0-4 overlaps 3-7), bar1(2-6 overlaps 3-7), bar2(6-10 overlaps 3-7)
      expect(visible.length).toBe(3);
    });

    it('returns empty array when no bars visible', () => {
      const bars = [
        { id: '1', barIndex: 0, startBeat: 0, endBeat: 4 },
        { id: '2', barIndex: 1, startBeat: 4, endBeat: 8 },
      ];
      const visible = getVisibleBars({ start: 20, end: 24 }, bars);
      expect(visible.length).toBe(0);
    });

    it('returns all bars when viewport covers everything', () => {
      const bars = [
        { id: '1', barIndex: 0, startBeat: 0, endBeat: 4 },
        { id: '2', barIndex: 1, startBeat: 4, endBeat: 8 },
        { id: '3', barIndex: 2, startBeat: 8, endBeat: 12 },
      ];
      const visible = getVisibleBars({ start: 0, end: 12 }, bars);
      expect(visible.length).toBe(3);
    });

    it('handles empty bars array', () => {
      const visible = getVisibleBars({ start: 0, end: 4 }, []);
      expect(visible.length).toBe(0);
    });

    it('handles partial bar overlap at start', () => {
      const bars = [
        { id: '1', barIndex: 0, startBeat: 0, endBeat: 4 },
        { id: '2', barIndex: 1, startBeat: 4, endBeat: 8 },
      ];
      const visible = getVisibleBars({ start: 2, end: 6 }, bars);
      expect(visible.length).toBe(2);
    });

    it('handles partial bar overlap at end', () => {
      const bars = [
        { id: '1', barIndex: 0, startBeat: 0, endBeat: 4 },
        { id: '2', barIndex: 1, startBeat: 4, endBeat: 8 },
      ];
      const visible = getVisibleBars({ start: 2, end: 6 }, bars);
      expect(visible.length).toBe(2);
    });
  });
});
