import { describe, it, expect } from 'vitest';
import {
  withStackSize,
  withToggledTone,
  withTriadColour,
  withSeventhColour,
  withDiatonicQuality,
  generateNotesFromSegments,
} from '@/engine/chordOperations';
import { retuneSegmentsToScale } from '@/engine/chordOperations';
import { PHRASE_TRACK_KEY } from '@/engine/phrases';
import { DEFAULT_TIME_SIGNATURE } from '@/utils/constants';
import type { Bar, ChordSegment, Scale } from '@/types/music';

const C_MAJOR: Scale = { root: 'C', type: 'major' };
const A_MINOR: Scale = { root: 'A', type: 'naturalMinor' };

function chord(overrides: Partial<ChordSegment> = {}): ChordSegment {
  return {
    id: 's1',
    kind: 'chord',
    duration: 4,
    root: 'C',
    quality: 'major',
    romanNumeral: 'I',
    octave: 4,
    ...overrides,
  };
}

function bar(chords: ChordSegment[]): Bar {
  return { id: 'b1', barIndex: 0, content: { [PHRASE_TRACK_KEY]: { chords, notes: [] } } };
}

function pitchesOf(segment: ChordSegment, scale: Scale = C_MAJOR): number[] {
  return generateNotesFromSegments([segment], bar([segment]), scale, DEFAULT_TIME_SIGNATURE, 4)
    .map(n => n.pitch)
    .sort((a, b) => a - b);
}

describe('withStackSize', () => {
  it('grows a triad through a seventh to a ninth', () => {
    const triad = chord();
    expect(pitchesOf(triad)).toEqual([60, 64, 67]);

    const seventh = withStackSize(triad, C_MAJOR, 4);
    expect(seventh.tones).toEqual([0, 1, 2, 3]);
    expect(seventh.quality).toBe('maj7');
    expect(seventh.chordSymbol).toBe('Cmaj7');
    expect(pitchesOf(seventh)).toEqual([60, 64, 67, 71]);

    const ninth = withStackSize(seventh, C_MAJOR, 5);
    expect(ninth.tones).toEqual([0, 1, 2, 3, 4]);
    expect(ninth.chordSymbol).toBe('Cmaj9');
    expect(pitchesOf(ninth)).toEqual([60, 64, 67, 71, 74]);
  });

  it('shrinks a ninth back to a dyad and a single tone', () => {
    const ninth = withStackSize(chord(), C_MAJOR, 5);

    const dyad = withStackSize(ninth, C_MAJOR, 2);
    expect(dyad.tones).toEqual([0, 1]);
    expect(dyad.quality).toBe('major');
    expect(dyad.chordSymbol).toBe('C(no5)');
    expect(pitchesOf(dyad)).toEqual([60, 64]);

    const single = withStackSize(dyad, C_MAJOR, 1);
    expect(single.tones).toEqual([0]);
    expect(single.chordSymbol).toBe('C');
    expect(pitchesOf(single)).toEqual([60]);
  });

  it('re-wraps an inversion the shrunken stack can no longer hold', () => {
    // Left pointing past the end, `voiceChord` would read it as a whole-chord octave
    // shift rather than an error — so it has to be wrapped here.
    const seventh = withStackSize(chord({ inversion: 3 }), C_MAJOR, 4);
    expect(seventh.inversion).toBe(3);

    const dyad = withStackSize(seventh, C_MAJOR, 2);
    expect(dyad.inversion).toBe(1);
  });

  it('takes the quality its key spells at each size', () => {
    const ii = chord({ root: 'D', quality: 'minor', romanNumeral: 'ii' });
    expect(withStackSize(ii, C_MAJOR, 4).quality).toBe('min7');
    expect(withStackSize(withStackSize(ii, C_MAJOR, 4), C_MAJOR, 3).quality).toBe('minor');
  });

  it('clamps a size the app cannot build', () => {
    expect(withStackSize(chord(), C_MAJOR, 0).tones).toEqual([0]);
    expect(withStackSize(chord(), C_MAJOR, 99).tones).toEqual([0, 1, 2, 3, 4]);
  });

  it('leaves a recorded note alone', () => {
    const note: ChordSegment = { id: 'n1', kind: 'note', pitch: 60, duration: 1 };
    expect(withStackSize(note, C_MAJOR, 4)).toBe(note);
  });
});

describe('withToggledTone', () => {
  it('turns a triad into a power chord and back', () => {
    const power = withToggledTone(chord(), C_MAJOR, 1);
    expect(power.tones).toEqual([0, 2]);
    expect(power.chordSymbol).toBe('C5');
    expect(pitchesOf(power)).toEqual([60, 67]);

    const back = withToggledTone(power, C_MAJOR, 1);
    expect(back.tones).toEqual([0, 1, 2]);
    expect(back.chordSymbol).toBe('C');
  });

  it('omits the fifth from a ninth without moving the tones above it', () => {
    const ninth = withStackSize(chord(), C_MAJOR, 5);
    const gapped = withToggledTone(ninth, C_MAJOR, 2);

    expect(gapped.tones).toEqual([0, 1, 3, 4]);
    expect(gapped.chordSymbol).toBe('Cmaj9(no5)');
    // The seventh and ninth are exactly where they were; only G4 is gone.
    expect(pitchesOf(gapped)).toEqual([60, 64, 71, 74]);
  });

  it('refuses to remove the root', () => {
    const segment = chord();
    expect(withToggledTone(segment, C_MAJOR, 0)).toBe(segment);
  });

  it('refuses a tone the app cannot voice', () => {
    const segment = chord();
    expect(withToggledTone(segment, C_MAJOR, 5)).toBe(segment);
    expect(withToggledTone(segment, C_MAJOR, -1)).toBe(segment);
  });
});

describe('pinning a colour', () => {
  it('pins a triad colour and keeps it through a change of key', () => {
    const ii = chord({ root: 'D', quality: 'minor', romanNumeral: 'ii' });
    const pinned = withTriadColour(ii, C_MAJOR, 'major');

    expect(pinned.quality).toBe('major');
    expect(pinned.qualityPinned).toBe(true);
    expect(pinned.romanNumeral).toBe('II');

    const [moved] = retuneSegmentsToScale([pinned], C_MAJOR, { root: 'G', type: 'major' });
    expect(moved.quality).toBe('major');
  });

  it('keeps the seventh it already had when the triad is recoloured', () => {
    const seventh = withStackSize(chord(), C_MAJOR, 4);
    expect(seventh.quality).toBe('maj7');

    const minor = withTriadColour(seventh, C_MAJOR, 'minor');
    // A minor triad under a major seventh is the minor-major seventh.
    expect(minor.quality).toBe('minMaj7');
    expect(minor.chordSymbol).toBe('CmMaj7');
  });

  it('recolours the seventh, keeping the triad', () => {
    const seventh = withStackSize(chord(), C_MAJOR, 4);
    const dominant = withSeventhColour(seventh, C_MAJOR, 'minor');

    expect(dominant.quality).toBe('dominant7');
    expect(dominant.chordSymbol).toBe('C7');
    expect(pitchesOf(dominant)).toEqual([60, 64, 67, 70]);
  });

  it('keeps the triad when the pair names no quality, letting the key spell the seventh', () => {
    // sus4 with a seventh has no member in ChordQuality, so the triad is stored and
    // the seventh comes from the key — said out loud in the symbol.
    const seventh = withStackSize(chord(), C_MAJOR, 4);
    const sus = withTriadColour(seventh, C_MAJOR, 'sus4');

    expect(sus.quality).toBe('sus4');
    expect(sus.chordSymbol).toBe('Csus4(maj7)');
    // C F G B — the key still spells the seventh.
    expect(pitchesOf(sus)).toEqual([60, 65, 67, 71]);
  });

  it('hands the colour back to the key', () => {
    const pinned = withTriadColour(
      chord({ root: 'D', quality: 'minor', romanNumeral: 'ii' }),
      C_MAJOR,
      'major'
    );
    const released = withDiatonicQuality(pinned, C_MAJOR);

    expect(released.quality).toBe('minor');
    expect(released.qualityPinned).toBeUndefined();
    expect(released.romanNumeral).toBe('ii');
  });

  it('follows a minor key when unpinned', () => {
    const i = chord({ root: 'A', quality: 'minor', romanNumeral: 'i' });
    expect(withStackSize(i, A_MINOR, 4).quality).toBe('min7');
    expect(withStackSize(i, A_MINOR, 4).chordSymbol).toBe('Am7');
  });
});
