import { describe, it, expect } from 'vitest';
import {
  notesInWindow,
  toClockTime,
  songTimeToBeat,
  beatToSongTime,
  LOOKAHEAD_SECONDS,
  TICK_MS,
} from '@/engine/scheduler';
import { calculateNoteTiming } from '@/engine/playback';
import type { NoteTiming, PlaybackConfig } from '@/engine/playback';
import type { Bar, Note, TimeSignature } from '@/types/music';
import { soloContent, TEST_TRACK_ID } from '../helpers/tracks';

const timing = (startTime: number, midiNote = 60): NoteTiming => ({
  midiNote,
  startTime,
  duration: 0.5,
  velocity: 100,
  barIndex: 0,
});

const makeNote = (pitch: number, startBeat: number, duration = 1): Note => ({
  id: `n-${pitch}-${startBeat}`,
  pitch,
  startBeat,
  duration,
  velocity: 100,
});

const makeBar = (barIndex: number, beats: number, notes: Note[] = []): Bar => ({
  id: `bar-${barIndex}`,
  barIndex,
  timeSignature: { beatsPerMeasure: beats, beatUnit: 4 },
  content: soloContent([], notes),
});

const makeConfig = (bpm: number, timeSignature: TimeSignature, bars: Bar[]): PlaybackConfig => ({
  bpm,
  timeSignature,
  bars,
  tracks: [],
  loopStart: null,
  loopEnd: null,
});

describe('scheduler', () => {
  describe('constants', () => {
    it('leaves the look-ahead comfortably longer than the tick interval', () => {
      // If a tick were slower than the look-ahead, a single late tick would leave a
      // silent gap. Several ticks must fit inside one window.
      expect(LOOKAHEAD_SECONDS * 1000).toBeGreaterThan(TICK_MS * 2);
    });
  });

  describe('notesInWindow', () => {
    it('returns notes starting inside the window', () => {
      const timings = [timing(0), timing(0.5), timing(1.0)];
      const found = notesInWindow({ timings, fromSong: 0, toSong: 0.75 });
      expect(found.map(t => t.startTime)).toEqual([0, 0.5]);
    });

    it('excludes notes before the window start', () => {
      const timings = [timing(0), timing(1), timing(2)];
      const found = notesInWindow({ timings, fromSong: 1, toSong: 3 });
      expect(found.map(t => t.startTime)).toEqual([1, 2]);
    });

    it('is half-open, so a note on the boundary belongs to exactly one window', () => {
      const timings = [timing(1.0)];
      const first = notesInWindow({ timings, fromSong: 0, toSong: 1.0 });
      const second = notesInWindow({ timings, fromSong: 1.0, toSong: 2.0 });

      expect(first).toHaveLength(0);
      expect(second).toHaveLength(1);
    });

    it('never yields the same note from two consecutive windows', () => {
      const timings = [timing(0), timing(0.2), timing(0.4), timing(0.6)];
      const windows = [
        notesInWindow({ timings, fromSong: 0, toSong: 0.2 }),
        notesInWindow({ timings, fromSong: 0.2, toSong: 0.4 }),
        notesInWindow({ timings, fromSong: 0.4, toSong: 0.6 }),
        notesInWindow({ timings, fromSong: 0.6, toSong: 0.8 }),
      ];

      const scheduled = windows.flat().map(t => t.startTime);
      expect(scheduled).toHaveLength(new Set(scheduled).size);
      expect(scheduled.sort()).toEqual([0, 0.2, 0.4, 0.6]);
    });

    it('returns an empty window when nothing is due', () => {
      expect(notesInWindow({ timings: [timing(5)], fromSong: 0, toSong: 1 })).toEqual([]);
    });

    it('keeps simultaneous notes of a chord together', () => {
      const timings = [timing(1, 60), timing(1, 64), timing(1, 67)];
      const found = notesInWindow({ timings, fromSong: 0.9, toSong: 1.1 });
      expect(found.map(t => t.midiNote)).toEqual([60, 64, 67]);
    });
  });

  describe('toClockTime', () => {
    it('offsets song time by the clock reading at song position 0', () => {
      expect(toClockTime(0, 12.5)).toBe(12.5);
      expect(toClockTime(2, 12.5)).toBe(14.5);
    });

    it('preserves the spacing between notes', () => {
      const anchor = 100.25;
      const a = toClockTime(1, anchor);
      const b = toClockTime(3.5, anchor);
      expect(b - a).toBeCloseTo(2.5, 10);
    });
  });

  describe('songTimeToBeat', () => {
    it('converts at the given tempo', () => {
      expect(songTimeToBeat(1, 60)).toBeCloseTo(1, 10);
      expect(songTimeToBeat(1, 120)).toBeCloseTo(2, 10);
      expect(songTimeToBeat(2, 240)).toBeCloseTo(8, 10);
    });

    it('clamps negatives to zero rather than running the playhead backwards', () => {
      expect(songTimeToBeat(-5, 120)).toBe(0);
    });

    it('returns 0 for a nonsensical tempo instead of NaN', () => {
      expect(songTimeToBeat(1, 0)).toBe(0);
      expect(songTimeToBeat(1, Number.NaN)).toBe(0);
      expect(songTimeToBeat(Number.POSITIVE_INFINITY, 120)).toBe(0);
    });

    it('round-trips through beatToSongTime', () => {
      for (const bpm of [60, 90, 120, 240]) {
        expect(beatToSongTime(songTimeToBeat(3.75, bpm), bpm)).toBeCloseTo(3.75, 10);
      }
    });
  });

  describe('scheduling against real note timings', () => {
    // The regression these tests exist for: playback used to discard startTime and
    // fire the whole project at once. Walking the windows must spread the notes out.
    const config = makeConfig(120, { beatsPerMeasure: 4, beatUnit: 4 }, [
      makeBar(0, 4, [makeNote(60, 0), makeNote(62, 2)]),
      makeBar(1, 4, [makeNote(64, 0), makeNote(65, 2)]),
    ]);

    it('spreads a project across successive windows instead of one burst', () => {
      const timings = calculateNoteTiming(config);
      // At 120 BPM a beat is 0.5s, so the notes sit at 0, 1, 2 and 3 seconds.
      expect(timings.map(t => t.startTime)).toEqual([0, 1, 2, 3]);

      const firstWindow = notesInWindow({ timings, fromSong: 0, toSong: LOOKAHEAD_SECONDS });
      expect(firstWindow.map(t => t.midiNote)).toEqual([60]);
      expect(firstWindow.length).toBeLessThan(timings.length);
    });

    it('emits every note exactly once when walking windows to the end', () => {
      const timings = calculateNoteTiming(config);
      const scheduled: NoteTiming[] = [];

      for (let from = 0; from < 4; from += LOOKAHEAD_SECONDS) {
        scheduled.push(...notesInWindow({ timings, fromSong: from, toSong: from + LOOKAHEAD_SECONDS }));
      }

      expect(scheduled).toHaveLength(timings.length);
      expect(scheduled.map(t => t.midiNote).sort()).toEqual([60, 62, 64, 65]);
    });

    it('gives each note a distinct clock time in ascending order', () => {
      const timings = calculateNoteTiming(config);
      const anchor = 7.5;
      const times = timings.map(t => toClockTime(t.startTime, anchor));

      expect(times).toEqual([7.5, 8.5, 9.5, 10.5]);
      expect(new Set(times).size).toBe(times.length);
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThan(times[i - 1]);
      }
    });

    it('keeps notes in time across a meter change', () => {
      // Bar 0 is 3/4, so bar 1 starts on beat 3 — 1.5s at 120 BPM, not 2s.
      const mixed = makeConfig(120, { beatsPerMeasure: 4, beatUnit: 4 }, [
        makeBar(0, 3, [makeNote(60, 0)]),
        makeBar(1, 4, [makeNote(64, 0)]),
      ]);
      const timings = calculateNoteTiming(mixed);
      expect(timings.map(t => t.startTime)).toEqual([0, 1.5]);

      const anchor = 2;
      expect(timings.map(t => toClockTime(t.startTime, anchor))).toEqual([2, 3.5]);
    });
  });
});
