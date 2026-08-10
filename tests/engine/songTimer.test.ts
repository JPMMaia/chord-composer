import { describe, it, expect } from 'vitest';
import {
  formatBarOffset,
  formatElapsed,
  formatPosition,
  getTimerReadout,
} from '@/engine/songTimer';
import type { Bar, TimeSignature } from '@/types/music';
import { soloContent } from '../helpers/tracks';

const TS_4_4: TimeSignature = { beatsPerMeasure: 4, beatUnit: 4 };
const TS_3_4: TimeSignature = { beatsPerMeasure: 3, beatUnit: 4 };

const makeBar = (barIndex: number, timeSignature?: TimeSignature): Bar => ({
  id: `bar-${barIndex}`,
  barIndex,
  timeSignature,
  content: soloContent(),
});

/** Four 4/4 bars — 2 s each at 120 BPM. */
const bars = [makeBar(0), makeBar(1), makeBar(2), makeBar(3)];

describe('getTimerReadout', () => {
  it('reports the top of the song', () => {
    expect(getTimerReadout(0, bars, TS_4_4, 120)).toEqual({
      songElapsed: 0,
      barElapsed: 0,
      barNumber: 1,
      beatInBar: 1,
    });
  });

  it('locates a position inside a bar', () => {
    // 5 s at 120 BPM is beat 10: bar 3 (beats 8-11), beat 3 of that bar.
    const readout = getTimerReadout(5, bars, TS_4_4, 120);
    expect(readout.songElapsed).toBe(5);
    expect(readout.barNumber).toBe(3);
    expect(readout.beatInBar).toBe(3);
    expect(readout.barElapsed).toBeCloseTo(1, 6);
  });

  it('resets the bar offset on a downbeat', () => {
    const readout = getTimerReadout(4, bars, TS_4_4, 120);
    expect(readout.barNumber).toBe(3);
    expect(readout.beatInBar).toBe(1);
    expect(readout.barElapsed).toBeCloseTo(0, 6);
  });

  it('walks mixed-metre bars rather than dividing', () => {
    // 4/4, 3/4, 4/4 — the third bar opens at beat 7, not beat 8.
    const mixed = [makeBar(0), makeBar(1, TS_3_4), makeBar(2)];

    // Beat 7 = 3.5 s at 120 BPM: the downbeat of bar 3.
    const onLine = getTimerReadout(3.5, mixed, TS_4_4, 120);
    expect(onLine.barNumber).toBe(3);
    expect(onLine.beatInBar).toBe(1);
    expect(onLine.barElapsed).toBeCloseTo(0, 6);

    // A whole-number division would have put 3 s (beat 6) in bar 2 beat 3 — it is
    // the last beat of the shortened bar 2 instead.
    const inShortBar = getTimerReadout(3, mixed, TS_4_4, 120);
    expect(inShortBar.barNumber).toBe(2);
    expect(inShortBar.beatInBar).toBe(3);
  });

  it('scales with tempo', () => {
    // At 60 BPM a beat is a second, so a 4/4 bar lasts 4 s.
    const readout = getTimerReadout(5, bars, TS_4_4, 60);
    expect(readout.barNumber).toBe(2);
    expect(readout.beatInBar).toBe(2);
    expect(readout.barElapsed).toBeCloseTo(1, 6);
  });

  it('clamps past the end of the project to the last bar', () => {
    const readout = getTimerReadout(1000, bars, TS_4_4, 120);
    expect(readout.barNumber).toBe(4);
    expect(readout.songElapsed).toBe(1000);
  });

  it('reads as the top of bar 1 for an empty or unplayable project', () => {
    expect(getTimerReadout(5, [], TS_4_4, 120)).toEqual({
      songElapsed: 5,
      barElapsed: 0,
      barNumber: 1,
      beatInBar: 1,
    });
    expect(getTimerReadout(5, bars, TS_4_4, 0).barNumber).toBe(1);
    expect(getTimerReadout(NaN, bars, TS_4_4, 120).songElapsed).toBe(0);
    expect(getTimerReadout(-3, bars, TS_4_4, 120).songElapsed).toBe(0);
  });
});

describe('formatElapsed', () => {
  it('zero-pads seconds and milliseconds', () => {
    expect(formatElapsed(0)).toBe('0:00.000');
    expect(formatElapsed(5.04)).toBe('0:05.040');
    expect(formatElapsed(83.45)).toBe('1:23.450');
  });

  it('keeps counting past ten minutes', () => {
    expect(formatElapsed(3723.5)).toBe('62:03.500');
  });

  it('truncates rather than rounding up into the next second', () => {
    expect(formatElapsed(1.9999)).toBe('0:01.999');
  });

  it('falls back for values that are not a time', () => {
    expect(formatElapsed(-1)).toBe('0:00.000');
    expect(formatElapsed(NaN)).toBe('0:00.000');
  });
});

describe('formatBarOffset', () => {
  it('signs the offset and keeps three decimals', () => {
    expect(formatBarOffset(0)).toBe('+0.000');
    expect(formatBarOffset(0.6115)).toBe('+0.612');
    expect(formatBarOffset(NaN)).toBe('+0.000');
  });
});

describe('formatPosition', () => {
  it('reads as bar.beat', () => {
    expect(
      formatPosition({ songElapsed: 0, barElapsed: 0, barNumber: 12, beatInBar: 3 })
    ).toBe('12.3');
  });
});
