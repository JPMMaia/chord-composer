import { describe, it, expect } from 'vitest';
import {
  captureFormula,
  degreePitch,
  formulaLengthBeats,
  pitchDegree,
  pitchDegreeAlteration,
  realizeFormula,
  type MelodicFormula,
} from '@/engine/formulas';
import type { Bar, ChordSegment, Project, Scale, TimeSignature } from '@/types/music';
import { soloContent, TEST_TRACK_ID } from '../helpers/tracks';

const C_MAJOR: Scale = { root: 'C', type: 'major' };
const A_MINOR: Scale = { root: 'A', type: 'naturalMinor' };
const C_PENT: Scale = { root: 'C', type: 'pentatonicMajor' };
const D_DORIAN: Scale = { root: 'D', type: 'dorian' };
const TS_4_4: TimeSignature = { beatsPerMeasure: 4, beatUnit: 4 };

/** Built here rather than fetched from a catalog: there is no catalog any more. */
const even = (id: string, degrees: number[], beats = 1): MelodicFormula => ({
  id,
  name: id,
  steps: degrees.map(degree => ({ degree, beats })),
});

const arch = (): MelodicFormula => even('arch', [0, 1, 2, 3, 2, 1, 0]);

/** `pitch@offset` per step, so a phrase's shape and rhythm read at a glance. */
function phrase(steps: ReturnType<typeof realizeFormula>): string[] {
  return steps.map(s => `${s.segment.pitch}@${s.offsetBeats}`);
}

describe('degreePitch', () => {
  it('walks the scale upwards from the tonic', () => {
    const run = [0, 1, 2, 3, 4, 5, 6].map(d => degreePitch(C_MAJOR, d, 4));
    expect(run).toEqual([60, 62, 64, 65, 67, 69, 71]);
  });

  it('reads degree 7 as the tonic an octave up', () => {
    expect(degreePitch(C_MAJOR, 7, 4)).toBe(72);
    expect(degreePitch(C_MAJOR, 8, 4)).toBe(74);
  });

  it('reads negative degrees as the notes below the tonic', () => {
    expect(degreePitch(C_MAJOR, -1, 4)).toBe(59);
    expect(degreePitch(C_MAJOR, -7, 4)).toBe(48);
  });

  it('starts a minor scale on its own tonic rather than dipping below it', () => {
    // A4, not the A below middle C — the same ascending-run rule the palette uses.
    expect(degreePitch(A_MINOR, 0, 4)).toBe(69);
    expect(degreePitch(A_MINOR, 2, 4)).toBe(72);
  });

  it('wraps after five degrees in a pentatonic scale', () => {
    expect(degreePitch(C_PENT, 4, 4)).toBe(69);
    expect(degreePitch(C_PENT, 5, 4)).toBe(72);
  });

  it('clamps to the MIDI range rather than producing an unplayable pitch', () => {
    expect(degreePitch(C_MAJOR, 70, 7)).toBe(127);
    expect(degreePitch(C_MAJOR, -70, 1)).toBe(0);
  });
});

describe('pitchDegree', () => {
  it('inverts degreePitch across octaves', () => {
    for (const degree of [-14, -7, -1, 0, 3, 7, 15]) {
      expect(pitchDegree(C_MAJOR, degreePitch(C_MAJOR, degree, 4))).toBe(degree);
    }
  });

  it('inverts it in a scale of five notes too', () => {
    for (const degree of [-5, 0, 2, 5, 9]) {
      expect(pitchDegree(C_PENT, degreePitch(C_PENT, degree, 4))).toBe(degree);
    }
  });

  it('answers a chromatic pitch with the degree nearest to it', () => {
    // F#4 is not in C major; F is a semitone below and G a semitone above, so the
    // lower of the two wins and the capture snaps into the scale.
    const fSharp = degreePitch(C_MAJOR, 3, 4) + 1;
    expect(pitchDegree(C_MAJOR, fSharp)).toBe(pitchDegree(C_MAJOR, degreePitch(C_MAJOR, 3, 4)));
  });
});

describe('pitchDegreeAlteration', () => {
  it('reports no alteration for a note the scale contains', () => {
    for (const degree of [-7, 0, 4, 11]) {
      expect(pitchDegreeAlteration(C_MAJOR, degreePitch(C_MAJOR, degree, 4))).toEqual({
        degree,
        alter: 0,
      });
    }
  });

  it('spells a pitch between two degrees as the lower one raised', () => {
    // C#5 in D dorian: a semitone above the seventh degree (C5) and a semitone below
    // the octave (D5). It is a leading tone, so it is the C raised, not the D flattened.
    expect(pitchDegreeAlteration(D_DORIAN, 73)).toEqual({ degree: 6, alter: 1 });
  });

  it('flattens the degree above when the pitch is nearer to it', () => {
    // F#4 sits two semitones above E4 and one below G4 in the pentatonic scale, which
    // has no degree between them.
    expect(pitchDegreeAlteration(C_PENT, 66)).toEqual({ degree: 3, alter: -1 });
  });
});

describe('realizeFormula', () => {
  it('turns an arch into its notes, laid end to end', () => {
    expect(phrase(realizeFormula(arch(), C_MAJOR, 4, 0))).toEqual([
      '60@0',
      '62@1',
      '64@2',
      '65@3',
      '64@4',
      '62@5',
      '60@6',
    ]);
  });

  it('moves the whole shape when the start degree moves', () => {
    const from4th = realizeFormula(arch(), C_MAJOR, 4, 3).map(s => s.segment.pitch);
    expect(from4th).toEqual([65, 67, 69, 71, 69, 67, 65]);
  });

  it('transposes with the key', () => {
    expect(realizeFormula(arch(), A_MINOR, 4, 0).map(s => s.segment.pitch)).toEqual([
      69, 71, 72, 74, 72, 71, 69,
    ]);
  });

  it('produces note blocks stamped with the key they were realized in', () => {
    const [first] = realizeFormula(arch(), A_MINOR, 4, 0);
    expect(first.segment).toMatchObject({
      kind: 'note',
      pitch: 69,
      chordSymbol: 'A4',
      root: 'A',
      octave: 4,
      duration: 1,
      romanNumeral: 'i',
      scale: A_MINOR,
    });
  });

  it('keeps each step’s own length rather than assuming one beat', () => {
    const appoggiatura: MelodicFormula = {
      id: 'appoggiatura',
      name: 'Appoggiatura',
      steps: [
        { degree: 1, beats: 0.5 },
        { degree: 0, beats: 1.5 },
      ],
    };
    const steps = realizeFormula(appoggiatura, C_MAJOR, 4, 0);
    expect(steps.map(s => s.segment.duration)).toEqual([0.5, 1.5]);
    expect(steps.map(s => s.offsetBeats)).toEqual([0, 0.5]);
  });

  it('raises and flattens an altered step by a semitone', () => {
    const chromatic: MelodicFormula = {
      id: 'chromatic',
      name: 'Chromatic',
      steps: [
        { degree: 0, beats: 1 },
        { degree: 6, alter: 1, beats: 1 },
        { degree: 2, alter: -1, beats: 1 },
      ],
    };
    // C5 raised is C#5; F4 flattened is E4.
    expect(realizeFormula(chromatic, D_DORIAN, 4, 0).map(s => s.segment.pitch)).toEqual([
      62, 73, 64,
    ]);
  });

  it('names an altered block with its accidental rather than the plain degree', () => {
    const raised: MelodicFormula = {
      id: 'raised',
      name: 'Raised',
      steps: [{ degree: 6, alter: 1, beats: 1 }],
    };
    const [step] = realizeFormula(raised, D_DORIAN, 4, 0);
    expect(step.segment.romanNumeral?.startsWith('♯')).toBe(true);
    expect(step.segment.chordSymbol).toBe('C#5');
  });

  it('stamps the alteration on the block it makes, so the timeline remembers it', () => {
    const chromatic: MelodicFormula = {
      id: 'chromatic',
      name: 'Chromatic',
      steps: [
        { degree: 5, alter: 1, beats: 1 },
        { degree: 6, beats: 1 },
      ],
    };
    const steps = realizeFormula(chromatic, D_DORIAN, 4, 1);
    expect(steps.map(s => s.segment.alter)).toEqual([1, undefined]);
  });

  it('keeps an altered step inside the MIDI range at the top of the keyboard', () => {
    const high: MelodicFormula = {
      id: 'high',
      name: 'High',
      steps: [{ degree: 70, alter: 1, beats: 1 }],
    };
    expect(realizeFormula(high, C_MAJOR, 7, 0)[0].segment.pitch).toBe(127);
  });

  it('pushes later steps past a rest without lengthening the note before it', () => {
    const withRest: MelodicFormula = {
      id: 'with-rest',
      name: 'With rest',
      steps: [
        { degree: 0, beats: 1, gapBeats: 2 },
        { degree: 1, beats: 1 },
      ],
    };
    const steps = realizeFormula(withRest, C_MAJOR, 4, 0);
    expect(steps.map(s => s.segment.duration)).toEqual([1, 1]);
    expect(steps.map(s => s.offsetBeats)).toEqual([0, 3]);
  });
});

describe('formulaLengthBeats', () => {
  it('sums the steps', () => {
    expect(formulaLengthBeats(arch())).toBe(7);
    expect(formulaLengthBeats(even('turn', [1, 0, -1, 0], 0.5))).toBe(2);
  });

  it('counts a rest as part of the phrase', () => {
    expect(
      formulaLengthBeats({
        id: 'x',
        name: 'x',
        steps: [{ degree: 0, beats: 1, gapBeats: 2 }],
      })
    ).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

const note = (
  id: string,
  pitch: number,
  startBeat: number,
  duration = 1,
  scale: Scale = C_MAJOR
): ChordSegment => ({
  id,
  kind: 'note',
  pitch,
  startBeat,
  duration,
  scale,
});

const makeProject = (bars: Bar[]): Project => ({
  id: 'p',
  name: 'Test',
  bpm: 120,
  timeSignature: TS_4_4,
  key: 'C',
  keyMode: 'major',
  tracks: [
    {
      id: TEST_TRACK_ID,
      name: 'Piano',
      instrument: 'acoustic_grand_piano',
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      visible: true,
    },
  ],
  bars,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const bar = (barIndex: number, chords: ChordSegment[]): Bar => ({
  id: `bar-${barIndex}`,
  barIndex,
  content: soloContent(chords),
});

describe('captureFormula', () => {
  it('reads a dropped phrase back as the formula that produced it', () => {
    // Drop an arch, capture it, realize it again: the round trip must be exact, or a
    // phrase would drift every time it was saved and reused.
    const realized = realizeFormula(arch(), C_MAJOR, 4, 0);
    const segments = realized.map((step, i) =>
      note(`n${i}`, step.segment.pitch as number, step.offsetBeats % 4)
    );
    const project = makeProject([bar(0, segments.slice(0, 4)), bar(1, segments.slice(4))]);

    const captured = captureFormula(
      project,
      project.bars,
      segments.map(s => s.id),
      C_MAJOR,
      'Arch',
      'formula-1'
    );

    expect(captured).not.toBeNull();
    expect(captured!.formula.steps.map(s => s.degree)).toEqual([0, 1, 2, 3, 2, 1, 0]);
    expect(phrase(realizeFormula(captured!.formula, C_MAJOR, 4, 0))).toEqual(phrase(realized));
  });

  it('takes the shape relative to the first note, whatever register it sits in', () => {
    const project = makeProject([bar(0, [note('a', 67, 0), note('b', 69, 1)])]);
    const captured = captureFormula(project, project.bars, ['a', 'b'], C_MAJOR, 'Pair', 'f');
    expect(captured!.formula.steps.map(s => s.degree)).toEqual([0, 1]);
  });

  it('records silence between blocks as a rest rather than a longer note', () => {
    const project = makeProject([bar(0, [note('a', 60, 0), note('b', 62, 3)])]);
    const captured = captureFormula(project, project.bars, ['a', 'b'], C_MAJOR, 'Gap', 'f');
    expect(captured!.formula.steps).toEqual([
      { degree: 0, beats: 1, gapBeats: 2 },
      { degree: 1, beats: 1, gapBeats: undefined },
    ]);
  });

  it('orders by position, not by the order the blocks were selected', () => {
    const project = makeProject([bar(0, [note('a', 60, 0), note('b', 64, 1)])]);
    const captured = captureFormula(project, project.bars, ['b', 'a'], C_MAJOR, 'Pair', 'f');
    expect(captured!.formula.steps.map(s => s.degree)).toEqual([0, 2]);
  });

  it('reads the degrees in the key the blocks were written in', () => {
    const project = makeProject([
      bar(0, [note('a', 69, 0, 1, A_MINOR), note('b', 71, 1, 1, A_MINOR)]),
    ]);
    const captured = captureFormula(project, project.bars, ['a', 'b'], C_MAJOR, 'Pair', 'f');
    expect(captured!.formula.steps.map(s => s.degree)).toEqual([0, 1]);
  });

  it('skips chord blocks and says how many', () => {
    const chord: ChordSegment = {
      id: 'c',
      kind: 'chord',
      startBeat: 1,
      duration: 1,
      romanNumeral: 'I',
    };
    const project = makeProject([bar(0, [note('a', 60, 0), chord, note('b', 62, 2)])]);
    const captured = captureFormula(project, project.bars, ['a', 'c', 'b'], C_MAJOR, 'Pair', 'f');
    expect(captured!.skipped).toBe(1);
    expect(captured!.formula.steps.map(s => s.degree)).toEqual([0, 1]);
  });

  it('writes a note outside the scale as an altered degree', () => {
    // E4, C#5, D5 in D dorian: the C# belongs to no degree of the scale, and without
    // an alteration to hold it the phrase would come back as E, C, D.
    const project = makeProject([
      bar(0, [
        note('a', 64, 0, 1, D_DORIAN),
        note('b', 73, 1, 1, D_DORIAN),
        note('c', 74, 2, 1, D_DORIAN),
      ]),
    ]);
    const captured = captureFormula(project, project.bars, ['a', 'b', 'c'], D_DORIAN, 'Cadence', 'f');

    expect(captured!.formula.steps).toEqual([
      { degree: 0, alter: undefined, beats: 1, gapBeats: undefined },
      { degree: 5, alter: 1, beats: 1, gapBeats: undefined },
      { degree: 6, alter: undefined, beats: 1, gapBeats: undefined },
    ]);
    // Dropped back where it came from, it is the same three pitches — the round trip
    // the whole degree model rests on, now for a chromatic phrase.
    expect(realizeFormula(captured!.formula, D_DORIAN, 4, 1).map(s => s.segment.pitch)).toEqual([
      64, 73, 74,
    ]);
  });

  it('believes a block’s own alteration over the pitch it sounds', () => {
    // Both blocks are MIDI 60. The first says it is a raised sixth of D dorian, the
    // second is the plain seventh — read off the pitch alone they would be one note.
    const raised: ChordSegment = { ...note('a', 60, 0, 1, D_DORIAN), alter: 1 };
    const p = makeProject([bar(0, [raised, note('b', 60, 1, 1, D_DORIAN)])]);
    const captured = captureFormula(p, p.bars, ['a', 'b'], D_DORIAN, 'Pair', 'f');

    expect(captured!.formula.steps.map(s => ({ degree: s.degree, alter: s.alter }))).toEqual([
      { degree: 0, alter: 1 },
      { degree: 1, alter: undefined },
    ]);
    // And realized from where it was read, it is those same two pitches again.
    expect(realizeFormula(captured!.formula, D_DORIAN, 4, -2).map(s => s.segment.pitch)).toEqual([
      60, 60,
    ]);
  });

  it('keeps the alteration of its own first note', () => {
    // The shape is relative to the first note; its accidental is not, or a phrase
    // starting on a leading tone would lose it the moment it was captured.
    const project = makeProject([
      bar(0, [note('a', 73, 0, 1, D_DORIAN), note('b', 74, 1, 1, D_DORIAN)]),
    ]);
    const captured = captureFormula(project, project.bars, ['a', 'b'], D_DORIAN, 'Lead', 'f');
    expect(captured!.formula.steps.map(s => ({ degree: s.degree, alter: s.alter }))).toEqual([
      { degree: 0, alter: 1 },
      { degree: 1, alter: undefined },
    ]);
    expect(realizeFormula(captured!.formula, D_DORIAN, 4, 6).map(s => s.segment.pitch)).toEqual([
      73, 74,
    ]);
  });

  it('answers null when the selection holds no notes at all', () => {
    const project = makeProject([bar(0, [])]);
    expect(captureFormula(project, project.bars, ['nope'], C_MAJOR, 'Empty', 'f')).toBeNull();
  });
});
