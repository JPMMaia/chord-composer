import { describe, it, expect } from 'vitest';
import { describeMeter, describePosition, formatNoteValue } from '@/engine/meterDisplay';
import type { TimeSignature } from '@/types/music';

const ts = (beatsPerMeasure: number, beatUnit: number): TimeSignature => ({
  beatsPerMeasure,
  beatUnit,
});

describe('meterDisplay', () => {
  describe('formatNoteValue', () => {
    it('names the values a note can be written as', () => {
      expect(formatNoteValue(4)).toBe('whole');
      expect(formatNoteValue(3)).toBe('dotted half');
      expect(formatNoteValue(2)).toBe('half');
      expect(formatNoteValue(1.5)).toBe('dotted quarter');
      expect(formatNoteValue(1)).toBe('quarter');
      expect(formatNoteValue(0.75)).toBe('dotted eighth');
      expect(formatNoteValue(0.5)).toBe('eighth');
      expect(formatNoteValue(0.25)).toBe('sixteenth');
    });

    it('tolerates the float drift a chain of snapped edits leaves', () => {
      expect(formatNoteValue(0.1 + 0.2 + 1.2)).toBe('dotted quarter');
    });

    it('falls back to a beat count rather than rounding to a wrong name', () => {
      expect(formatNoteValue(5)).toBe('5 beats');
      expect(formatNoteValue(1.25)).toBe('1.25 beats');
    });

    it('does not pluralise a single beat', () => {
      // 1 itself is named "quarter", so this only shows up off the named list.
      expect(formatNoteValue(7)).toBe('7 beats');
      expect(formatNoteValue(Number.NaN)).toBe('—');
    });
  });

  describe('describeMeter', () => {
    it('counts a simple metre in its denominator units', () => {
      expect(describeMeter(ts(4, 4))).toBe('4 beats · 4 quarters');
      expect(describeMeter(ts(3, 4))).toBe('3 beats · 3 quarters');
      expect(describeMeter(ts(2, 2))).toBe('2 beats · 2 halves');
    });

    it('counts a compound metre in its groups of three', () => {
      // The half that distinguishes it from 3/4, which is the same length.
      expect(describeMeter(ts(6, 8))).toBe('2 beats · 6 eighths');
      expect(describeMeter(ts(12, 8))).toBe('4 beats · 12 eighths');
    });

    it('describes an irregular metre without inventing a grouping', () => {
      expect(describeMeter(ts(7, 8))).toBe('7 beats · 7 eighths');
    });
  });

  describe('describePosition', () => {
    it('counts a 3/4 bar in three and a 6/8 bar in two', () => {
      expect(describePosition(1.5, ts(3, 4))).toBe('beat 2 of 3 + eighth');
      expect(describePosition(1.5, ts(6, 8))).toBe('beat 2 of 2');
    });

    it('names the pulse a position lands on', () => {
      expect(describePosition(0, ts(4, 4))).toBe('beat 1 of 4');
      expect(describePosition(2, ts(4, 4))).toBe('beat 3 of 4');
      expect(describePosition(3, ts(12, 8))).toBe('beat 3 of 4');
    });

    it('locates an off-beat position by its offset into the pulse', () => {
      expect(describePosition(0.5, ts(6, 8))).toBe('beat 1 of 2 + eighth');
      expect(describePosition(0.25, ts(4, 4))).toBe('beat 1 of 4 + sixteenth');
    });

    it('keeps a position past the end of the bar inside it', () => {
      expect(describePosition(99, ts(3, 4))).toBe('beat 3 of 3 + 97 beats');
      expect(describePosition(-1, ts(3, 4))).toBe('beat 1 of 3');
    });
  });
});
