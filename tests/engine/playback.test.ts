import { describe, it, expect } from 'vitest';
import {
  calculateNoteTiming,
  createTimingCache,
  getLoopDuration,
  calculateMetronomeBeats,
  type MetronomeClick,
  type NoteTiming,
  type PlaybackConfig,
} from '@/engine/playback';
import { isTrackAudible } from '@/engine/instrumentPool';
import type { Bar, Note, TimeSignature, Track } from '@/types/music';
import { soloContent, TEST_TRACK_ID, OTHER_TRACK_ID } from '../helpers/tracks';

/** An audible instrument, unless a test says otherwise. */
const makeTrack = (id: string, overrides: Partial<Track> = {}): Track => ({
  id,
  name: id,
  instrument: 'acoustic_grand_piano',
  volume: 1,
  pan: 0,
  muted: false,
  solo: false,
  visible: true,
  ...overrides,
});

const makeBar = (barIndex: number, beats: number, notes: Note[] = []): Bar => ({
  id: `bar-${barIndex}`,
  barIndex,
  timeSignature: { beatsPerMeasure: beats, beatUnit: 4 },
  content: soloContent([], notes),
});

/** A bar with no meter of its own, so it inherits the project's. */
const makeInheritingBar = (barIndex: number, notes: Note[] = []): Bar => ({
  id: `bar-${barIndex}`,
  barIndex,
  content: soloContent([], notes),
});

const makeConfig = (
  bpm: number,
  timeSignature: TimeSignature,
  bars: Bar[],
  loopStart: number | null = null,
  loopEnd: number | null = null
): PlaybackConfig => ({
  bpm,
  timeSignature,
  bars,
  tracks: [makeTrack(TEST_TRACK_ID)],
  loopStart,
  loopEnd,
});

describe('playback', () => {
  describe('calculateNoteTiming', () => {
    it('calculates correct start time for each note', () => {
      const bars: Bar[] = [
        makeBar(0, 4, [
          { id: 'n1', pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
          { id: 'n2', pitch: 64, startBeat: 1, duration: 1, velocity: 100 },
          { id: 'n3', pitch: 67, startBeat: 2, duration: 1, velocity: 100 },
        ]),
      ];
      const config = makeConfig(120, { beatsPerMeasure: 4, beatUnit: 4 }, bars);
      const timings = calculateNoteTiming(config);

      // At 120 BPM, each beat = 0.5 seconds
      expect(timings).toHaveLength(3);
      expect(timings[0].midiNote).toBe(60);
      expect(timings[0].startTime).toBe(0);
      expect(timings[0].duration).toBe(0.5);
      expect(timings[1].midiNote).toBe(64);
      expect(timings[1].startTime).toBe(0.5);
      expect(timings[2].midiNote).toBe(67);
      expect(timings[2].startTime).toBe(1.0);
    });

    it('handles different time signatures', () => {
      const bars: Bar[] = [
        makeBar(0, 3, [
          { id: 'n1', pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
          { id: 'n2', pitch: 64, startBeat: 1, duration: 1, velocity: 100 },
          { id: 'n3', pitch: 67, startBeat: 2, duration: 1, velocity: 100 },
        ]),
      ];
      const config = makeConfig(60, { beatsPerMeasure: 3, beatUnit: 4 }, bars);
      const timings = calculateNoteTiming(config);

      // At 60 BPM, each beat = 1 second
      expect(timings).toHaveLength(3);
      expect(timings[0].startTime).toBe(0);
      expect(timings[1].startTime).toBe(1.0);
      expect(timings[2].startTime).toBe(2.0);
    });

    it('handles notes spanning bar boundaries', () => {
      const bars: Bar[] = [
        makeBar(0, 4, [
          { id: 'n1', pitch: 60, startBeat: 3, duration: 2, velocity: 100 },
        ]),
        makeBar(1, 4, [
          { id: 'n2', pitch: 64, startBeat: 0, duration: 1, velocity: 100 },
        ]),
      ];
      const config = makeConfig(60, { beatsPerMeasure: 4, beatUnit: 4 }, bars);
      const timings = calculateNoteTiming(config);

      // n1 starts at beat 3 of bar 0 = 3 seconds, duration 2 beats = 2 seconds
      expect(timings).toHaveLength(2);
      expect(timings[0].midiNote).toBe(60);
      expect(timings[0].startTime).toBe(3.0);
      expect(timings[0].duration).toBe(2.0);
      // n2 starts at beat 0 of bar 1 = 4 seconds
      expect(timings[1].midiNote).toBe(64);
      expect(timings[1].startTime).toBe(4.0);
    });

    it('respects BPM for timing', () => {
      const bars: Bar[] = [
        makeBar(0, 2, [
          { id: 'n1', pitch: 60, startBeat: 0, duration: 1, velocity: 100 },
        ]),
      ];

      // 60 BPM → 1 beat = 1 second
      const config60 = makeConfig(60, { beatsPerMeasure: 4, beatUnit: 4 }, bars);
      const timings60 = calculateNoteTiming(config60);
      expect(timings60[0].startTime).toBe(0);
      expect(timings60[0].duration).toBe(1.0);

      // 120 BPM → 1 beat = 0.5 seconds
      const config120 = makeConfig(120, { beatsPerMeasure: 4, beatUnit: 4 }, bars);
      const timings120 = calculateNoteTiming(config120);
      expect(timings120[0].startTime).toBe(0);
      expect(timings120[0].duration).toBe(0.5);

      // 240 BPM → 1 beat = 0.25 seconds
      const config240 = makeConfig(240, { beatsPerMeasure: 4, beatUnit: 4 }, bars);
      const timings240 = calculateNoteTiming(config240);
      expect(timings240[0].duration).toBe(0.25);
    });

    it('accumulates bar starts across differing per-bar time signatures', () => {
      const bars: Bar[] = [
        makeBar(0, 3, [{ id: 'n1', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }]),
        makeBar(1, 4, [{ id: 'n2', pitch: 62, startBeat: 0, duration: 1, velocity: 100 }]),
        makeBar(2, 2, [{ id: 'n3', pitch: 64, startBeat: 0, duration: 1, velocity: 100 }]),
      ];
      // 60 BPM → 1 beat = 1 second, so start times read directly as beats.
      const timings = calculateNoteTiming(
        makeConfig(60, { beatsPerMeasure: 4, beatUnit: 4 }, bars)
      );

      expect(timings.map(t => t.startTime)).toEqual([0, 3, 7]);
    });

    it('falls back to the project time signature for bars without one', () => {
      const bars: Bar[] = [
        makeInheritingBar(0),
        makeInheritingBar(1, [{ id: 'n1', pitch: 60, startBeat: 1, duration: 1, velocity: 100 }]),
      ];
      const timings = calculateNoteTiming(
        makeConfig(60, { beatsPerMeasure: 3, beatUnit: 4 }, bars)
      );

      // Bar 1 starts at beat 3, note sits a beat into it.
      expect(timings[0].startTime).toBe(4);
    });
  });

  // The scheduling loop asks for the timings on every pass so a mid-playback edit
  // is heard; the cache is what keeps that from re-walking the project 20×/second.
  describe('createTimingCache', () => {
    const fourFour: TimeSignature = { beatsPerMeasure: 4, beatUnit: 4 };
    const bars: Bar[] = [
      makeBar(0, 4, [{ id: 'n1', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }]),
    ];

    it('reuses the previous result for the same bars', () => {
      const timingsFor = createTimingCache(60, fourFour);

      // Identity, not equality: a fresh array would mean the walk ran again.
      expect(timingsFor(bars)).toBe(timingsFor(bars));
    });

    it('re-derives when the bars are replaced by an edit', () => {
      const timingsFor = createTimingCache(60, fourFour);
      expect(timingsFor(bars).map(t => t.midiNote)).toEqual([60]);

      const edited: Bar[] = [
        makeBar(0, 4, [
          { id: 'n1', pitch: 62, startBeat: 0, duration: 1, velocity: 100 },
          { id: 'n2', pitch: 65, startBeat: 2, duration: 1, velocity: 100 },
        ]),
      ];

      expect(timingsFor(edited).map(t => t.midiNote)).toEqual([62, 65]);
      expect(timingsFor(edited).map(t => t.startTime)).toEqual([0, 2]);
    });

    it('keeps the tempo it was built with', () => {
      const timingsFor = createTimingCache(120, fourFour);
      const edited: Bar[] = [
        makeBar(0, 4, [{ id: 'n1', pitch: 60, startBeat: 2, duration: 1, velocity: 100 }]),
      ];

      // 120 BPM: half a second a beat.
      expect(timingsFor(edited)[0].startTime).toBe(1);
    });
  });

  describe('getLoopDuration', () => {
    it('returns total duration when no loop is set', () => {
      const bars: Bar[] = [
        makeBar(0, 4),
        makeBar(1, 4),
        makeBar(2, 4),
      ];
      const config = makeConfig(120, { beatsPerMeasure: 4, beatUnit: 4 }, bars);
      // 3 bars × 4 beats = 12 beats. At 120 BPM, 1 beat = 0.5s → 6 seconds
      expect(getLoopDuration(config)).toBe(6.0);
    });

    it('returns loop region duration when set', () => {
      const bars: Bar[] = [
        makeBar(0, 4),
        makeBar(1, 4),
        makeBar(2, 4),
        makeBar(3, 4),
      ];
      const config = makeConfig(
        60,
        { beatsPerMeasure: 4, beatUnit: 4 },
        bars,
        2, // loop starts at beat 2
        6  // loop ends at beat 6
      );
      // Loop region = 6 - 2 = 4 beats. At 60 BPM, 1 beat = 1s → 4 seconds
      expect(getLoopDuration(config)).toBe(4.0);
    });

    it('handles loop region within first bar', () => {
      const bars: Bar[] = [makeBar(0, 4)];
      const config = makeConfig(
        60,
        { beatsPerMeasure: 4, beatUnit: 4 },
        bars,
        1,
        3
      );
      // 3 - 1 = 2 beats at 60 BPM = 2 seconds
      expect(getLoopDuration(config)).toBe(2.0);
    });

    it('sums differing bar lengths for the total duration', () => {
      const bars: Bar[] = [makeBar(0, 4), makeBar(1, 3), makeBar(2, 2)];
      const config = makeConfig(60, { beatsPerMeasure: 4, beatUnit: 4 }, bars);
      // 4 + 3 + 2 = 9 beats at 60 BPM → 9 seconds
      expect(getLoopDuration(config)).toBe(9.0);
    });
  });

  describe('calculateMetronomeBeats', () => {
    /** `count` bars that all inherit the project meter. */
    const inheriting = (count: number): Bar[] =>
      Array.from({ length: count }, (_, i) => makeInheritingBar(i));

    /** Click positions alone, for the cases that do not care about accents. */
    const positions = (clicks: MetronomeClick[]): number[] => clicks.map(c => c.beat);

    it('generates correct beat positions for 4/4 time', () => {
      const clicks = calculateMetronomeBeats(inheriting(2), { beatsPerMeasure: 4, beatUnit: 4 });
      // 2 bars × 4 quarter-note beats
      expect(positions(clicks)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('generates correct beat positions for 3/4 time', () => {
      const clicks = calculateMetronomeBeats(inheriting(2), { beatsPerMeasure: 3, beatUnit: 4 });
      // 2 bars × 3 quarter-note beats
      expect(positions(clicks)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('clicks in dotted quarters for 6/8, not in quarters', () => {
      const clicks = calculateMetronomeBeats(inheriting(1), { beatsPerMeasure: 6, beatUnit: 8 });
      // Compound duple: two beats a bar, each a dotted quarter. The bar is the same
      // three beats long as 3/4, but is counted in two rather than three.
      expect(clicks).toEqual([
        { beat: 0, accent: 'downbeat' },
        { beat: 1.5, accent: 'pulse' },
      ]);
    });

    it('groups 12/8 into four dotted-quarter beats', () => {
      const clicks = calculateMetronomeBeats(inheriting(1), { beatsPerMeasure: 12, beatUnit: 8 });
      expect(positions(clicks)).toEqual([0, 1.5, 3, 4.5]);
    });

    it('gives an irregular metre one click per denominator unit', () => {
      // 7/8 is not divisible into equal groups of three, so it is left as an even
      // grid of eighths rather than guessing between 3+2+2 and 2+2+3.
      const clicks = calculateMetronomeBeats(inheriting(1), { beatsPerMeasure: 7, beatUnit: 8 });
      expect(positions(clicks)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3]);
    });

    it('accents the first click of every bar', () => {
      const clicks = calculateMetronomeBeats(inheriting(2), { beatsPerMeasure: 3, beatUnit: 4 });
      expect(clicks.map(c => c.accent)).toEqual([
        'downbeat', 'pulse', 'pulse',
        'downbeat', 'pulse', 'pulse',
      ]);
    });

    it('handles single bar', () => {
      const clicks = calculateMetronomeBeats(inheriting(1), { beatsPerMeasure: 4, beatUnit: 4 });
      expect(clicks).toHaveLength(4);
    });

    it('clicks once per beat across bars of differing lengths', () => {
      const clicks = calculateMetronomeBeats(
        [makeBar(0, 4), makeBar(1, 3)],
        { beatsPerMeasure: 4, beatUnit: 4 }
      );
      expect(positions(clicks)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });
  });

  describe('instruments', () => {
    /** One bar, two instruments, one note each. */
    const twoInstrumentBar = (): Bar => ({
      id: 'bar-0',
      barIndex: 0,
      timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
      content: {
        [TEST_TRACK_ID]: {
          chords: [],
          notes: [{ id: 'a', pitch: 60, startBeat: 0, duration: 1, velocity: 100 }],
        },
        [OTHER_TRACK_ID]: {
          chords: [],
          notes: [{ id: 'b', pitch: 72, startBeat: 1, duration: 1, velocity: 100 }],
        },
      },
    });

    it('tags each timing with the instrument that plays it', () => {
      const timings = calculateNoteTiming({
        bpm: 60,
        timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
        bars: [twoInstrumentBar()],
        tracks: [makeTrack(TEST_TRACK_ID), makeTrack(OTHER_TRACK_ID)],
        loopStart: null,
        loopEnd: null,
        loopEnabled: false,
      });

      expect(timings.map(t => [t.midiNote, t.trackId])).toEqual([
        [60, TEST_TRACK_ID],
        [72, OTHER_TRACK_ID],
      ]);
    });

    // Mute and solo are applied when a note is dispatched, not here — filtering at
    // this point would freeze the mute state at the moment Play was pressed.
    it('includes muted instruments, leaving the decision to the dispatcher', () => {
      const timings = calculateNoteTiming({
        bpm: 60,
        timeSignature: { beatsPerMeasure: 4, beatUnit: 4 },
        bars: [twoInstrumentBar()],
        tracks: [makeTrack(TEST_TRACK_ID, { muted: true }), makeTrack(OTHER_TRACK_ID)],
        loopStart: null,
        loopEnd: null,
        loopEnabled: false,
      });

      expect(timings).toHaveLength(2);
    });
  });

  describe('isTrackAudible', () => {
    const piano = makeTrack(TEST_TRACK_ID);
    const strings = makeTrack(OTHER_TRACK_ID);

    it('hears an unmuted instrument when nothing is soloed', () => {
      expect(isTrackAudible(piano, [piano, strings])).toBe(true);
    });

    it('silences a muted instrument', () => {
      const muted = makeTrack(TEST_TRACK_ID, { muted: true });
      expect(isTrackAudible(muted, [muted, strings])).toBe(false);
    });

    it('silences everything that is not soloed once anything is', () => {
      const soloed = makeTrack(OTHER_TRACK_ID, { solo: true });
      expect(isTrackAudible(soloed, [piano, soloed])).toBe(true);
      expect(isTrackAudible(piano, [piano, soloed])).toBe(false);
    });

    // Otherwise soloing a muted instrument would un-mute it, which is not what
    // either control means.
    it('keeps a muted instrument silent even when it is the soloed one', () => {
      const both = makeTrack(TEST_TRACK_ID, { muted: true, solo: true });
      expect(isTrackAudible(both, [both, strings])).toBe(false);
    });
  });
});
