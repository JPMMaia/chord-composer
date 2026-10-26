import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_MIDI_PREFS,
  MIDI_PREFS_STORAGE_KEY,
  applyMidiPrefs,
  getMidiPrefs,
  loadMidiPrefs,
  reportVelocity,
  resetMidiPrefsCache,
  shapeVelocity,
  storeMidiPrefs,
  subscribeLastVelocity,
} from '@/engine/midiPrefs';

const ALL = Array.from({ length: 127 }, (_, i) => i + 1);

describe('MIDI preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMidiPrefsCache();
  });

  describe('shaping a velocity', () => {
    it('passes velocity through untouched by default', () => {
      expect(ALL.map(v => shapeVelocity(v, DEFAULT_MIDI_PREFS))).toEqual(ALL);
    });

    it('lifts the middle for a light touch and lowers it for a hard one', () => {
      expect(shapeVelocity(54, { touch: 50, minVelocity: 0 })).toBe(83);
      expect(shapeVelocity(54, { touch: -50, minVelocity: 0 })).toBeLessThan(54);
    });

    it('still reaches 127 at full force, whatever the touch', () => {
      for (const touch of [-100, -50, 0, 50, 100]) {
        expect(shapeVelocity(127, { touch, minVelocity: 0 })).toBe(127);
      }
    });

    it('never goes down as the key is struck harder', () => {
      for (const touch of [-100, 100]) {
        const out = ALL.map(v => shapeVelocity(v, { touch, minVelocity: 20 }));
        for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
      }
    });

    // A note-on at velocity 0 is a note-off, so the curve must never produce one.
    it('never returns zero, even at the hardest touch', () => {
      expect(shapeVelocity(1, { touch: -100, minVelocity: 0 })).toBe(1);
    });

    it('holds every key at or above the minimum', () => {
      for (const v of ALL) expect(shapeVelocity(v, { touch: 0, minVelocity: 40 })).toBeGreaterThanOrEqual(40);
    });
  });

  describe('what is remembered', () => {
    it('is the identity on a machine nobody has configured', () => {
      expect(loadMidiPrefs()).toEqual(DEFAULT_MIDI_PREFS);
    });

    it('round-trips a choice', () => {
      storeMidiPrefs({ touch: 35, minVelocity: 12 });
      expect(loadMidiPrefs()).toEqual({ touch: 35, minVelocity: 12 });
    });

    it('clamps numbers out of range rather than trusting them', () => {
      localStorage.setItem(MIDI_PREFS_STORAGE_KEY, JSON.stringify({ touch: 900, minVelocity: -4 }));
      expect(loadMidiPrefs()).toEqual({ touch: 100, minVelocity: 0 });
    });

    it('reads nonsense as the defaults rather than throwing', () => {
      localStorage.setItem(MIDI_PREFS_STORAGE_KEY, 'not json');
      expect(loadMidiPrefs()).toEqual(DEFAULT_MIDI_PREFS);

      localStorage.setItem(MIDI_PREFS_STORAGE_KEY, JSON.stringify({ touch: 'light' }));
      expect(loadMidiPrefs()).toEqual(DEFAULT_MIDI_PREFS);
    });

    it('applies a change to this session and the next', () => {
      applyMidiPrefs({ touch: 40 });
      expect(getMidiPrefs()).toEqual({ touch: 40, minVelocity: 0 });

      resetMidiPrefsCache();
      expect(getMidiPrefs()).toEqual({ touch: 40, minVelocity: 0 });
    });
  });

  it('tells subscribers each raw velocity until they unsubscribe', () => {
    const heard: number[] = [];
    const stop = subscribeLastVelocity(v => heard.push(v));
    reportVelocity(54);
    stop();
    reportVelocity(99);

    expect(heard).toEqual([54]);
  });
});
