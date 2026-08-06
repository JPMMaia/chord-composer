import { describe, it, expect, vi } from 'vitest';
import { auditionPitches, auditionSegment } from '@/engine/audition';
import type { Instrument, ScheduledNote } from '@/engine/instrument';
import type { ChordSegment, Scale, TimeSignature } from '@/types/music';

const C_MAJOR: Scale = { root: 'C', type: 'major' };
const TS_4_4: TimeSignature = { beatsPerMeasure: 4, beatUnit: 4 };

const chord = (overrides: Partial<ChordSegment> = {}): ChordSegment => ({
  id: 'seg',
  kind: 'chord',
  root: 'C',
  quality: 'major',
  romanNumeral: 'I',
  octave: 4,
  duration: 0.25,
  ...overrides,
});

/** An instrument that records what it was asked to do, with a switchable `sustain`. */
function mockInstrument(withSustain: boolean) {
  const scheduled: ScheduledNote[] = [];
  const started: number[] = [];
  const stopped: number[] = [];

  const instrument: Instrument = {
    name: 'Mock',
    now: () => 10,
    load: async () => {},
    isLoaded: true,
    schedule: note => {
      scheduled.push(note);
    },
    stopAll: vi.fn(),
    setVolume: vi.fn(),
    dispose: vi.fn(),
    ...(withSustain
      ? {
          sustain: ({ midiNote }: { midiNote: number }) => {
            started.push(midiNote);
            return () => stopped.push(midiNote);
          },
        }
      : {}),
  };

  return { instrument, scheduled, started, stopped };
}

describe('audition', () => {
  describe('auditionPitches', () => {
    it('voices a chord block as its stack', () => {
      expect(auditionPitches(chord(), C_MAJOR, TS_4_4)).toEqual([60, 64, 67]);
    });

    it('honours the block’s inversion', () => {
      expect(auditionPitches(chord({ inversion: 1 }), C_MAJOR, TS_4_4)).toEqual([64, 67, 72]);
    });

    it('yields the single pitch of a note block', () => {
      expect(
        auditionPitches(chord({ kind: 'note', pitch: 67 }), C_MAJOR, TS_4_4)
      ).toEqual([67]);
    });

    it('previews an arpeggiated block as one stack, not a figure', () => {
      const arpeggiated = chord({ duration: 4, voicing: { break: { type: 'arpeggio' } } });
      expect(auditionPitches(arpeggiated, C_MAJOR, TS_4_4)).toEqual([60, 64, 67]);
    });

    it('sounds from the tonic even when the block is a minimum-length take', () => {
      // A key-down commits at MIN_SEGMENT_BEATS; that must not truncate the chord.
      expect(auditionPitches(chord({ duration: 0.25 }), C_MAJOR, TS_4_4)).toHaveLength(3);
    });
  });

  describe('auditionSegment', () => {
    it('holds every pitch until released', () => {
      const { instrument, started, stopped } = mockInstrument(true);
      const release = auditionSegment(instrument, chord(), C_MAJOR, TS_4_4);

      expect(started).toEqual([60, 64, 67]);
      expect(stopped).toEqual([]);

      release();
      expect(stopped).toEqual([60, 64, 67]);
    });

    it('releases only once, so a keyup racing a blur is harmless', () => {
      const { instrument, stopped } = mockInstrument(true);
      const release = auditionSegment(instrument, chord(), C_MAJOR, TS_4_4);
      release();
      release();
      expect(stopped).toEqual([60, 64, 67]);
    });

    it('falls back to a fixed-length preview when the backend cannot hold a note', () => {
      const { instrument, scheduled } = mockInstrument(false);
      const release = auditionSegment(instrument, chord(), C_MAJOR, TS_4_4);

      expect(scheduled.map(n => n.midiNote)).toEqual([60, 64, 67]);
      expect(scheduled.every(n => n.when === 10 && n.duration > 0)).toBe(true);
      // Releasing must not reach for stopAll, which would cut playback as well.
      release();
      expect(instrument.stopAll).not.toHaveBeenCalled();
    });

    it('is a no-op with no instrument to sound on', () => {
      expect(() => auditionSegment(undefined, chord(), C_MAJOR, TS_4_4)()).not.toThrow();
    });
  });
});
