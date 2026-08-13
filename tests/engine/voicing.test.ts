import { describe, it, expect } from 'vitest';
import {
  arpeggioOrder,
  breakChord,
  spacingOffsets,
  voiceChord,
  voicedPitches,
  withBreak,
  withInversion,
  withSpacing,
  withToggledDoubling,
  withToneOffset,
  withVelocity,
  withoutVoicing,
} from '@/engine/voicing';
import type { VoicedTone } from '@/engine/voicing';
import { CHORD_INTERVALS, invertIntervals } from '@/engine/chords';
import { PIANO_ROLL_MAX_MIDI, PIANO_ROLL_MIN_MIDI } from '@/utils/constants';
import type { ChordSegment, Scale } from '@/types/music';

const C_MAJOR: Scale = { root: 'C', type: 'major' };
const TRIAD = CHORD_INTERVALS.major; // [0, 4, 7]
const SEVENTH = CHORD_INTERVALS.dominant7; // [0, 4, 7, 10]

/** Chord segments in these tests only ever need a root and a quality. */
function chord(overrides: Partial<ChordSegment> = {}): ChordSegment {
  return { id: 's1', kind: 'chord', duration: 4, root: 'C', quality: 'major', ...overrides };
}

function intervalsOf(tones: { interval: number }[]): number[] {
  return tones.map(t => t.interval).sort((a, b) => a - b);
}

describe('voiceChord', () => {
  // The whole point of the refactor is that nothing changes for a chord with no
  // voicing. If this drifts, every project ever saved sounds different.
  it('reproduces invertIntervals exactly when no voicing is given', () => {
    for (const intervals of [TRIAD, SEVENTH]) {
      for (let inversion = 0; inversion <= 3; inversion++) {
        expect(intervalsOf(voiceChord(intervals, inversion))).toEqual(
          [...invertIntervals(intervals, inversion)].sort((a, b) => a - b)
        );
      }
    }
  });

  it('keeps a tone index attached to its own chord tone through an inversion', () => {
    // The third is interval 4 in root position and still the third — now an
    // octave up — in first inversion. This is what makes a hand-tweaked offset
    // survive the user changing inversion.
    const root = voiceChord(TRIAD, 0);
    const first = voiceChord(TRIAD, 1);
    expect(root.find(t => t.tone === 1)?.interval).toBe(4);
    expect(first.find(t => t.tone === 1)?.interval).toBe(4);
    expect(first.find(t => t.tone === 0)?.interval).toBe(12);
  });

  it('lets explicit offsets override the spacing preset', () => {
    const tones = voiceChord(TRIAD, 0, { spacing: 'drop2', offsets: [0, 0, -1] });
    expect(intervalsOf(tones)).toEqual([-5, 0, 4]);
  });

  it('adds a doubled voice an octave from its tone', () => {
    const tones = voiceChord(TRIAD, 0, { doublings: [{ tone: 0, octaves: -1 }] });
    expect(intervalsOf(tones)).toEqual([-12, 0, 4, 7]);
    expect(tones.filter(t => t.doubled)).toHaveLength(1);
  });

  it('drops a doubling of a tone the chord no longer has', () => {
    // A seventh's doubling left behind after the chord became a triad.
    const tones = voiceChord(TRIAD, 0, { doublings: [{ tone: 3, octaves: 1 }] });
    expect(intervalsOf(tones)).toEqual([0, 4, 7]);
  });

  it('returns nothing for an empty chord rather than throwing', () => {
    expect(voiceChord([], 0)).toEqual([]);
  });
});

describe('spacingOffsets', () => {
  const tonesFor = (intervals: number[], inversion = 0): VoicedTone[] =>
    voiceChord(intervals, inversion);

  it('leaves a close voicing alone', () => {
    expect(spacingOffsets(tonesFor(TRIAD), 'close')).toEqual([0, 0, 0]);
  });

  it('drops the second voice from the top for drop-2', () => {
    // Triad [0,4,7]: top is the fifth, second from top is the third.
    expect(spacingOffsets(tonesFor(TRIAD), 'drop2')).toEqual([0, -1, 0]);
    // Seventh [0,4,7,10]: second from top is the fifth.
    expect(spacingOffsets(tonesFor(SEVENTH), 'drop2')).toEqual([0, 0, -1, 0]);
  });

  it('drops the third voice from the top for drop-3', () => {
    expect(spacingOffsets(tonesFor(TRIAD), 'drop3')).toEqual([-1, 0, 0]);
    expect(spacingOffsets(tonesFor(SEVENTH), 'drop3')).toEqual([0, -1, 0, 0]);
  });

  it('leaves drop-3 closed on a chord too thin to have a third voice', () => {
    expect(spacingOffsets(tonesFor([0, 7]), 'drop3')).toEqual([0, 0]);
  });

  it('drops every other voice from the top for open position', () => {
    // On a triad, open position genuinely is drop-2 — three notes cannot be
    // spread any other way.
    expect(spacingOffsets(tonesFor(TRIAD), 'open')).toEqual([0, -1, 0]);
    expect(spacingOffsets(tonesFor(SEVENTH), 'open')).toEqual([-1, 0, -1, 0]);
  });

  it('follows the sounding order, so a preset moves the right voice in an inversion', () => {
    // First inversion triad sounds 4, 7, 12 — the top voice is now the root, so
    // drop-2 has to move the fifth, not the third.
    expect(spacingOffsets(tonesFor(TRIAD, 1), 'drop2')).toEqual([0, 0, -1]);
  });
});

describe('voicedPitches', () => {
  it('builds absolute pitches from the chord root', () => {
    expect(voicedPitches(TRIAD, 0, 60)).toEqual([60, 64, 67]);
  });

  it('drops pitches outside the piano roll rather than clamping them', () => {
    // Clamping would fold the doubling onto a note the user never asked for.
    const low = voicedPitches(TRIAD, 0, PIANO_ROLL_MIN_MIDI + 1, {
      doublings: [{ tone: 0, octaves: -1 }],
    });
    expect(low).not.toContain(PIANO_ROLL_MIN_MIDI);
    expect(low.every(p => p >= PIANO_ROLL_MIN_MIDI && p <= PIANO_ROLL_MAX_MIDI)).toBe(true);

    const high = voicedPitches(TRIAD, 0, PIANO_ROLL_MAX_MIDI - 1, {
      doublings: [{ tone: 0, octaves: 1 }],
    });
    expect(high.every(p => p <= PIANO_ROLL_MAX_MIDI)).toBe(true);
  });

  it('collapses duplicate pitches from a repeated doubling', () => {
    // Two chord tones can never collide — they have distinct pitch classes and
    // offsets only move things by whole octaves. A repeat of the *same* doubling
    // can, though, which is what a hand-edited file may well contain; toggling in
    // the panel cannot produce it. Two note-ons on one pitch would confuse both
    // the sampler and the MIDI export.
    const pitches = voicedPitches(TRIAD, 0, 60, {
      doublings: [
        { tone: 0, octaves: -1 },
        { tone: 0, octaves: -1 },
      ],
    });
    expect(pitches).toEqual([60, 64, 67, 48]);
  });
});

describe('arpeggioOrder', () => {
  const pitches = [60, 64, 67];

  it('keeps the voiced order for as-played', () => {
    expect(arpeggioOrder([67, 60, 64], 'asPlayed')).toEqual([67, 60, 64]);
  });

  it('sorts ascending and descending', () => {
    expect(arpeggioOrder(pitches, 'up')).toEqual([60, 64, 67]);
    expect(arpeggioOrder(pitches, 'down')).toEqual([67, 64, 60]);
  });

  it('turns without repeating either end for up-down', () => {
    expect(arpeggioOrder(pitches, 'upDown')).toEqual([60, 64, 67, 64]);
    expect(arpeggioOrder([60, 64, 67, 70], 'upDown')).toEqual([60, 64, 67, 70, 67, 64]);
    expect(arpeggioOrder([60, 64], 'upDown')).toEqual([60, 64]);
  });

  it('leaves a single pitch alone', () => {
    expect(arpeggioOrder([60], 'upDown')).toEqual([60]);
  });
});

describe('breakChord', () => {
  const pitches = [60, 64, 67];

  it('sounds every pitch at once for the full length when unbroken', () => {
    const notes = breakChord(pitches, 8, 4, undefined);
    expect(notes).toHaveLength(3);
    expect(notes.every(n => n.startBeat === 8 && n.duration === 4)).toBe(true);
    expect(notes.every(n => n.velocity === 100)).toBe(true);
  });

  it('returns nothing for an empty chord or a zero-length segment', () => {
    expect(breakChord([], 0, 4, undefined)).toEqual([]);
    expect(breakChord(pitches, 0, 0, undefined)).toEqual([]);
  });

  describe('arpeggio', () => {
    const spec = { mode: 'arpeggio', pattern: 'up' } as const;

    it('lays one note per step across the segment', () => {
      const notes = breakChord(pitches, 0, 3, spec);
      expect(notes.map(n => n.startBeat)).toEqual([0, 1, 2]);
      expect(notes.map(n => n.pitch)).toEqual([60, 64, 67]);
    });

    it('ends the last note exactly at the segment end', () => {
      const notes = breakChord(pitches, 2, 4, spec);
      const last = notes[notes.length - 1];
      expect(last.startBeat + last.duration).toBeCloseTo(6, 10);
    });

    it('never lets a note run past the segment', () => {
      const notes = breakChord([60, 64, 67, 70], 1, 2.5, { mode: 'arpeggio', pattern: 'upDown' });
      for (const note of notes) {
        expect(note.startBeat + note.duration).toBeLessThanOrEqual(1 + 2.5 + 1e-9);
      }
    });

    it('shortens each note by the gate without moving its onset', () => {
      const notes = breakChord(pitches, 0, 3, { ...spec, gate: 0.5 });
      expect(notes[0].startBeat).toBe(0);
      expect(notes[0].duration).toBeCloseTo(0.5, 10);
    });
  });

  describe('strum', () => {
    it('staggers onsets and releases every voice together', () => {
      const notes = breakChord(pitches, 0, 4, {
        mode: 'strum',
        spreadBeats: 0.1,
        direction: 'up',
      });
      expect(notes.map(n => n.startBeat)).toEqual([0, 0.1, 0.2]);
      for (const note of notes) {
        expect(note.startBeat + note.duration).toBeCloseTo(4, 10);
      }
    });

    it('leads with the top voice when strumming down', () => {
      const notes = breakChord(pitches, 0, 4, {
        mode: 'strum',
        spreadBeats: 0.1,
        direction: 'down',
      });
      expect(notes.map(n => n.pitch)).toEqual([67, 64, 60]);
    });

    it('squeezes a spread too wide for the segment instead of silencing voices', () => {
      const notes = breakChord(pitches, 0, 0.25, {
        mode: 'strum',
        spreadBeats: 2,
        direction: 'up',
      });
      expect(notes).toHaveLength(3);
      expect(notes.every(n => n.duration > 0)).toBe(true);
      for (const note of notes) {
        expect(note.startBeat + note.duration).toBeCloseTo(0.25, 10);
      }
    });
  });
});

describe('segment transforms', () => {
  it('records the preset and seeds the offsets it implies', () => {
    const next = withSpacing(chord(), C_MAJOR, 'drop2');
    expect(next.voicing?.spacing).toBe('drop2');
    expect(next.voicing?.offsets).toEqual([0, -1, 0]);
  });

  it('seeds from the unspaced chord, so presets do not compound', () => {
    const once = withSpacing(chord(), C_MAJOR, 'drop2');
    const twice = withSpacing(once, C_MAJOR, 'drop2');
    expect(twice.voicing?.offsets).toEqual(once.voicing?.offsets);
  });

  it('clears the preset when a single tone is hand-tweaked', () => {
    const spaced = withSpacing(chord(), C_MAJOR, 'drop2');
    const tweaked = withToneOffset(spaced, 2, -1);
    expect(tweaked.voicing?.spacing).toBeUndefined();
    expect(tweaked.voicing?.offsets).toEqual([0, -1, -1]);
  });

  it('toggles a doubling on and back off', () => {
    const on = withToggledDoubling(chord(), 0, -1);
    expect(on.voicing?.doublings).toEqual([{ tone: 0, octaves: -1 }]);
    const off = withToggledDoubling(on, 0, -1);
    expect(off.voicing).toBeUndefined();
  });

  it('wraps an inversion within the chord size', () => {
    expect(withInversion(chord(), C_MAJOR, 3).inversion).toBe(0);
    expect(withInversion(chord(), C_MAJOR, -1).inversion).toBe(2);
    expect(withInversion(chord({ quality: 'dominant7' }), C_MAJOR, 3).inversion).toBe(3);
  });

  it('prunes a voicing that says nothing back to absent', () => {
    // Returning to close position must leave a segment that serialises exactly
    // as it did before it was ever voiced.
    const spaced = withSpacing(chord(), C_MAJOR, 'drop2');
    expect(withSpacing(spaced, C_MAJOR, 'close').voicing).toBeUndefined();
    expect(withoutVoicing(spaced).voicing).toBeUndefined();
    expect(withBreak(withBreak(chord(), { mode: 'strum', spreadBeats: 0.1, direction: 'up' }), null).voicing).toBeUndefined();
  });

  it('leaves note segments untouched — one pitch has nothing to voice', () => {
    const note = chord({ kind: 'note', pitch: 60 });
    expect(withSpacing(note, C_MAJOR, 'drop2')).toBe(note);
    expect(withToneOffset(note, 0, -1)).toBe(note);
    expect(withToggledDoubling(note, 0, 1)).toBe(note);
    expect(withBreak(note, null)).toBe(note);
    expect(withInversion(note, C_MAJOR, 1)).toBe(note);
  });
});

describe('withVelocity', () => {
  it('clamps to the MIDI range and rounds', () => {
    expect(withVelocity(chord(), 0).velocity).toBe(1);
    expect(withVelocity(chord(), -20).velocity).toBe(1);
    expect(withVelocity(chord(), 400).velocity).toBe(127);
    expect(withVelocity(chord(), 63.6).velocity).toBe(64);
  });

  it('applies to every kind, unlike the voicing transforms', () => {
    // The property that sets this one apart: a note and a recorded block both
    // sound at some velocity, and only a chord has tones to space.
    const note = chord({ kind: 'note', pitch: 60 });
    const take = chord({
      kind: 'custom',
      customNotes: [{ pitch: 60, startBeat: 0, duration: 1, velocity: 88 }],
    });
    expect(withVelocity(note, 40).velocity).toBe(40);
    expect(withVelocity(take, 40).velocity).toBe(40);
    // The take's own notes are its business — the block value is only their fallback.
    expect(withVelocity(take, 40).customNotes).toEqual(take.customNotes);
  });

  it('writes the default out rather than clearing the field', () => {
    // Otherwise a segment could never be put back to 100 once it had held
    // anything else: the edit would silently become "never stated".
    const quiet = withVelocity(chord(), 40);
    expect(withVelocity(quiet, 100).velocity).toBe(100);
  });

  it('ignores a velocity that is not a number', () => {
    const source = chord();
    expect(withVelocity(source, Number.NaN)).toBe(source);
  });
});
