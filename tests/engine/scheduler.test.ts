import { describe, it, expect } from 'vitest';
import {
  cycleWindows,
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

  describe('cycleWindows', () => {
    /** Beats 0-4 of a 60 BPM song: song seconds 0 to 4, repeating. */
    const region = { from: 0, end: 4, repeat: true };

    it('leaves a window well inside one repetition alone', () => {
      expect(cycleWindows(1, 1.2, 0, region)).toEqual([
        { fromSong: 1, toSong: 1.2, songStartClockTime: 0 },
      ]);
    });

    it('cuts a window straddling the seam in two, a loop length apart', () => {
      // The whole point: the far half is placed against a frame one repetition on,
      // so the repeat's downbeat is scheduled at 4s while the clock still reads 3.9.
      expect(cycleWindows(3.75, 4.25, 0, region)).toEqual([
        { fromSong: 3.75, toSong: 4, songStartClockTime: 0 },
        { fromSong: 0, toSong: 0.25, songStartClockTime: 4 },
      ]);
    });

    it('yields only the far side once the window has cleared the seam', () => {
      // The pass after the one above, before the wrap is noticed: everything up to
      // 4.25 has already gone out, so only 4.25 onward is new — and it belongs to
      // the next repetition.
      expect(cycleWindows(4.25, 4.5, 0, region)).toEqual([
        { fromSong: 0.25, toSong: 0.5, songStartClockTime: 4 },
      ]);
    });

    it('hands every note out exactly once across a seam', () => {
      // A pass at a time, as the scheduler runs it: the cursor sits on the clock,
      // and the frame of reference moves on by a loop length once the playhead
      // crosses the seam.
      const timings = [timing(0), timing(1), timing(2), timing(3)];
      const emitted: number[] = [];
      let base = 0;
      let scheduledUpTo = 0;

      // Up to the moment the third repetition's downbeat comes into view, so the
      // expectation below is two whole repetitions and nothing half-scheduled.
      for (let pass = 0; (pass * TICK_MS) / 1000 < 7.8; pass++) {
        const clock = (pass * TICK_MS) / 1000;
        const toClock = clock + LOOKAHEAD_SECONDS;
        for (const slice of cycleWindows(scheduledUpTo, toClock, base, region)) {
          const due = notesInWindow({
            timings,
            fromSong: slice.fromSong,
            toSong: slice.toSong,
          });
          emitted.push(...due.map(n => toClockTime(n.startTime, slice.songStartClockTime)));
        }
        scheduledUpTo = Math.max(scheduledUpTo, toClock);
        if (clock - base >= region.end) base += region.end - region.from;
      }

      // Two repetitions of four notes a second apart, each note handed over once
      // and each one loop length on from its counterpart.
      expect(emitted.map(t => Math.round(t * 1e6) / 1e6)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('stops at the region end when the range does not repeat', () => {
      expect(cycleWindows(3.75, 4.25, 0, { ...region, repeat: false })).toEqual([
        { fromSong: 3.75, toSong: 4, songStartClockTime: 0 },
      ]);
    });

    it('offsets a range that does not start at the top of the song', () => {
      // Beats 4-8 at 60 BPM, played from a clock anchored at 10.
      const ranged = { from: 4, end: 8, repeat: true };
      expect(cycleWindows(17.75, 18.25, 10, ranged)).toEqual([
        { fromSong: 7.75, toSong: 8, songStartClockTime: 10 },
        { fromSong: 4, toSong: 4.25, songStartClockTime: 14 },
      ]);
    });

    it('yields nothing for a window that has already been scheduled', () => {
      expect(cycleWindows(2, 2, 0, region)).toEqual([]);
    });

    it('does not spin on a region with no length', () => {
      // A degenerate range cannot repeat over nothing; the caller stops instead.
      expect(cycleWindows(0, 0.2, 0, { from: 2, end: 2, repeat: true })).toEqual([]);
    });

    it('caps how many repetitions one window may be cut into', () => {
      // A look-ahead longer than the whole loop. The bound keeps this finite rather
      // than scheduling the same tiny range forever.
      const tiny = { from: 0, end: 0.02, repeat: true };
      expect(cycleWindows(0, 1, 0, tiny).length).toBeLessThanOrEqual(4);
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
