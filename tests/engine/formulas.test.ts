import { describe, it, expect } from 'vitest';
import {
  captureFormula,
  degreePitch,
  formulaLengthBeats,
  pitchDegree,
  pitchDegreeAlteration,
  realizeFormula,
  resolveScaleRef,
  scaleRefFrom,
  segmentAnchorPitch,
  type MelodicFormula,
} from '@/engine/formulas';
import type {
  Bar,
  ChordQuality,
  ChordSegment,
  NoteName,
  Project,
  Scale,
  TimeSignature,
} from '@/types/music';
import { soloContent, TEST_TRACK_ID } from '../helpers/tracks';

const C_MAJOR: Scale = { root: 'C', type: 'major' };
const A_MINOR: Scale = { root: 'A', type: 'naturalMinor' };
const C_PENT: Scale = { root: 'C', type: 'pentatonicMajor' };
const D_DORIAN: Scale = { root: 'D', type: 'dorian' };
const D_MINOR: Scale = { root: 'D', type: 'naturalMinor' };
const A_MINOR_SCALE: Scale = { root: 'A', type: 'naturalMinor' };
const G_MAJOR: Scale = { root: 'G', type: 'major' };
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

  it('skips a block that names no pitch at all, and says how many', () => {
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

const chord = (
  id: string,
  root: NoteName,
  quality: ChordQuality,
  startBeat: number,
  extra: Partial<ChordSegment> = {}
): ChordSegment => ({
  id,
  kind: 'chord',
  root,
  quality,
  octave: 4,
  startBeat,
  duration: 1,
  scale: C_MAJOR,
  ...extra,
});

// ---------------------------------------------------------------------------
// The mode a formula is written in
// ---------------------------------------------------------------------------

const C_MINOR: Scale = { root: 'C', type: 'naturalMinor' };

describe('the home mode', () => {
  /** i, ♭VI (first inversion) and the IV of the major a fourth up — a real capture. */
  const progression = (): ChordSegment[] => [
    chord('a', 'C', 'minor', 0, { scale: C_MINOR, romanNumeral: 'i' }),
    chord('b', 'G#', 'major', 1, { scale: C_MINOR, inversion: 1, romanNumeral: 'VI' }),
    chord('c', 'F', 'major', 2, { scale: { root: 'F', type: 'major' }, inversion: 2 }),
  ];

  it('keeps a captured progression’s chords whatever mode the palette is in', () => {
    // The bug this guards: the mode a formula was written in used to be thrown away,
    // so a minor progression dropped with the palette on major came back as I-vi-IV
    // with nothing to say it had changed.
    const project = makeProject([bar(0, progression())]);
    const captured = captureFormula(project, project.bars, ['a', 'b', 'c'], C_MAJOR, 'i-VI', 'f')!;
    expect(captured.formula.homeType).toBe('naturalMinor');

    const placed = realizeFormula(captured.formula, C_MAJOR, 4, 0);
    expect(placed.map(s => `${s.segment.chordSymbol}/${s.segment.inversion ?? 0}`)).toEqual([
      'Cm/0',
      'G#/1',
      'F/2',
    ]);
  });

  it('transposes such a progression as one thing, mode and all', () => {
    const project = makeProject([bar(0, progression())]);
    const captured = captureFormula(project, project.bars, ['a', 'b', 'c'], C_MAJOR, 'i-VI', 'f')!;

    // Dropped on F: the same shape a fourth up, still minor, still with its borrowed
    // major a fourth above *that*.
    const placed = realizeFormula(captured.formula, { root: 'F', type: 'major' }, 4, 0);
    expect(placed.map(s => `${s.segment.chordSymbol}/${s.segment.inversion ?? 0}`)).toEqual([
      'Fm/0',
      'C#/1',
      'A#/2',
    ]);
  });

  it('leaves a plain melodic run free to retune to the palette', () => {
    // Bare degrees mean the same steps of whatever scale they land in, so pinning a
    // mode here would take away most of what a formula is for.
    const project = makeProject([
      bar(0, [note('a', 60, 0, 1, C_MAJOR), note('b', 64, 1, 1, C_MAJOR)]),
    ]);
    const captured = captureFormula(project, project.bars, ['a', 'b'], C_MAJOR, 'Third', 'f')!;
    expect(captured.formula.homeType).toBeUndefined();
    // Dropped on D dorian it is that scale's own third, exactly as it always was.
    expect(realizeFormula(captured.formula, D_DORIAN, 4, 0).map(s => s.segment.pitch)).toEqual([
      62, 65,
    ]);
  });

  it('pins the mode for a modulating melody too, since its second key hangs off it', () => {
    const project = makeProject([
      bar(0, [note('a', 60, 0, 1, C_MAJOR), note('b', 62, 1, 1, D_MINOR)]),
    ]);
    const captured = captureFormula(project, project.bars, ['a', 'b'], C_MAJOR, 'Shift', 'f')!;
    expect(captured.formula.homeType).toBe('major');
  });

  it('uses the palette’s root even when the mode is pinned', () => {
    const project = makeProject([bar(0, progression())]);
    const captured = captureFormula(project, project.bars, ['a', 'b', 'c'], C_MAJOR, 'i-VI', 'f')!;
    // Only the mode is the formula's; the root is always the palette's choice.
    expect(realizeFormula(captured.formula, G_MAJOR, 4, 0)[0].segment.chordSymbol).toBe('Gm');
  });
});

// ---------------------------------------------------------------------------
// Several keys in one formula
// ---------------------------------------------------------------------------

describe('scale references', () => {
  it('resolves and names a scale as inverses of each other', () => {
    for (let rootOffset = 0; rootOffset < 12; rootOffset++) {
      const scale = resolveScaleRef(C_MAJOR, { rootOffset, type: 'naturalMinor' });
      expect(scaleRefFrom(C_MAJOR, scale)).toEqual({ rootOffset, type: 'naturalMinor' });
    }
  });

  it('names the home key as no reference at all, so nothing is written down', () => {
    expect(scaleRefFrom(C_MAJOR, { root: 'C', type: 'major' })).toBeUndefined();
    // Same root, different mode: still a key of its own.
    expect(scaleRefFrom(C_MAJOR, { root: 'C', type: 'dorian' })).toEqual({
      rootOffset: 0,
      type: 'dorian',
    });
    expect(resolveScaleRef(C_MAJOR, undefined)).toEqual(C_MAJOR);
  });
});

describe('capturing across keys', () => {
  it('reads each block in its own key rather than flattening them onto the first', () => {
    // C4 written in C major, D4 written in D natural minor: both are the tonic of
    // the key they were written in, and a capture that read them both in C major
    // would call the second one a plain second degree.
    const project = makeProject([
      bar(0, [note('a', 60, 0, 1, C_MAJOR), note('b', 62, 1, 1, D_MINOR)]),
    ]);
    const captured = captureFormula(project, project.bars, ['a', 'b'], C_MAJOR, 'Shift', 'f');

    expect(captured!.formula.steps[0].scale).toBeUndefined();
    expect(captured!.formula.steps[1].scale).toEqual({ rootOffset: 2, type: 'naturalMinor' });
    // Dropped back where it came from, it is the same two pitches.
    expect(realizeFormula(captured!.formula, C_MAJOR, 4, 0).map(s => s.segment.pitch)).toEqual([
      60, 62,
    ]);
  });

  it('transposes the whole shape, keys and all, when it is dropped elsewhere', () => {
    const project = makeProject([
      bar(0, [note('a', 60, 0, 1, C_MAJOR), note('b', 62, 1, 1, D_MINOR)]),
    ]);
    const captured = captureFormula(project, project.bars, ['a', 'b'], C_MAJOR, 'Shift', 'f');

    // C major + D natural minor, dropped on G major, is G major + A natural minor:
    // the second key keeps its distance from the first rather than staying put.
    const placed = realizeFormula(captured!.formula, G_MAJOR, 4, 0);
    expect(placed.map(s => s.segment.pitch)).toEqual([67, 69]);
    expect(placed[0].segment.scale).toEqual(G_MAJOR);
    expect(placed[1].segment.scale).toEqual(A_MINOR_SCALE);
  });

  it('stamps each block with the key it actually names, so a re-capture reads it back', () => {
    const project = makeProject([
      bar(0, [note('a', 60, 0, 1, C_MAJOR), note('b', 62, 1, 1, D_MINOR)]),
    ]);
    const first = captureFormula(project, project.bars, ['a', 'b'], C_MAJOR, 'Shift', 'f')!;

    const placed = realizeFormula(first.formula, C_MAJOR, 4, 0);
    const again = makeProject([
      bar(
        0,
        placed.map((step, i) => ({
          ...(step.segment as ChordSegment),
          id: `r${i}`,
          startBeat: step.offsetBeats,
        }))
      ),
    ]);
    const second = captureFormula(again, again.bars, ['r0', 'r1'], C_MAJOR, 'Shift', 'f')!;
    expect(second.formula.steps).toEqual(first.formula.steps);
  });
});

// ---------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------

describe('capturing chords', () => {
  it('reads a chord onto the same degree axis as a note', () => {
    expect(segmentAnchorPitch(note('a', 60, 0))).toBe(60);
    // A chord's root is its pitch: D4, the same note the palette voices a ii from.
    expect(segmentAnchorPitch(chord('c', 'D', 'minor', 0))).toBe(62);
    expect(segmentAnchorPitch({ id: 'x', kind: 'chord', duration: 1 })).toBeNull();
  });

  it('leaves a diatonic quality unwritten, so the chords follow the key they land in', () => {
    const project = makeProject([
      bar(0, [chord('a', 'C', 'major', 0), chord('b', 'D', 'minor', 1)]),
    ]);
    const captured = captureFormula(project, project.bars, ['a', 'b'], C_MAJOR, 'I-ii', 'f')!;
    expect(captured.skipped).toBe(0);
    expect(captured.formula.steps.map(s => s.quality)).toEqual([undefined, undefined]);

    // I-ii in C major becomes I-ii in G major, not G-D.
    const placed = realizeFormula(captured.formula, G_MAJOR, 4, 0);
    expect(placed.map(s => [s.segment.root, s.segment.quality])).toEqual([
      ['G', 'major'],
      ['A', 'minor'],
    ]);
    expect(placed.map(s => s.segment.chordSymbol)).toEqual(['G', 'Am']);
    expect(placed.map(s => s.segment.romanNumeral)).toEqual(['I', 'ii']);
  });

  it('writes a borrowed quality down, so it stays borrowed wherever it is dropped', () => {
    // A major chord on the second degree of C major is not what the key spells.
    const project = makeProject([
      bar(0, [chord('a', 'C', 'major', 0), chord('b', 'D', 'major', 1)]),
    ]);
    const captured = captureFormula(project, project.bars, ['a', 'b'], C_MAJOR, 'V/V', 'f')!;
    expect(captured.formula.steps.map(s => s.quality)).toEqual([undefined, 'major']);

    const placed = realizeFormula(captured.formula, G_MAJOR, 4, 0);
    expect(placed.map(s => [s.segment.root, s.segment.quality])).toEqual([
      ['G', 'major'],
      ['A', 'major'],
    ]);
  });

  it('carries inversion, voicing and velocity through unchanged', () => {
    const voicing = {
      spacing: 'drop2' as const,
      break: { mode: 'strum' as const, spreadBeats: 0.1, direction: 'up' as const },
    };
    const project = makeProject([
      bar(0, [
        chord('a', 'C', 'major', 0),
        chord('b', 'G', 'dominant7', 1, { inversion: 2, voicing, velocity: 72 }),
      ]),
    ]);
    const captured = captureFormula(project, project.bars, ['a', 'b'], C_MAJOR, 'Cadence', 'f')!;
    expect(captured.formula.steps[1]).toMatchObject({
      kind: 'chord',
      degree: 4,
      // A seventh is never the diatonic triad, so it is always written down.
      quality: 'dominant7',
      inversion: 2,
      voicing,
      velocity: 72,
    });

    const placed = realizeFormula(captured.formula, C_MAJOR, 4, 0);
    expect(placed[1].segment).toMatchObject({
      kind: 'chord',
      root: 'G',
      quality: 'dominant7',
      inversion: 2,
      octave: 4,
      voicing,
      velocity: 72,
      chordSymbol: 'G7',
      romanNumeral: 'V7',
    });
  });

  it('captures notes and chords together, keeping their order and rhythm', () => {
    const project = makeProject([
      bar(0, [
        note('n1', 60, 0, 0.5),
        chord('c1', 'F', 'major', 1),
        note('n2', 64, 2.5, 0.5),
      ]),
    ]);
    const captured = captureFormula(project, project.bars, ['c1', 'n2', 'n1'], C_MAJOR, 'Mix', 'f')!;
    expect(captured.formula.steps.map(s => [s.kind, s.degree, s.beats, s.gapBeats])).toEqual([
      [undefined, 0, 0.5, 0.5],
      ['chord', 3, 1, 0.5],
      [undefined, 2, 0.5, undefined],
    ]);
    // And back where it came from, it is the same three blocks again.
    const placed = realizeFormula(captured.formula, C_MAJOR, 4, 0);
    expect(placed.map(s => [s.segment.kind, s.segment.pitch ?? s.segment.root])).toEqual([
      ['note', 60],
      ['chord', 'F'],
      ['note', 64],
    ]);
  });

  it('reads a chord in the key its own block was written in', () => {
    const project = makeProject([
      bar(0, [
        chord('a', 'C', 'major', 0),
        chord('b', 'D', 'minor', 1, { scale: D_MINOR }),
      ]),
    ]);
    const captured = captureFormula(project, project.bars, ['a', 'b'], C_MAJOR, 'Shift', 'f')!;
    expect(captured.formula.steps[1].scale).toEqual({ rootOffset: 2, type: 'naturalMinor' });
    // D minor's own tonic triad is minor, so there is nothing to write down for it.
    expect(captured.formula.steps[1].quality).toBeUndefined();
    expect(
      realizeFormula(captured.formula, C_MAJOR, 4, 0).map(s => [s.segment.root, s.segment.quality])
    ).toEqual([
      ['C', 'major'],
      ['D', 'minor'],
    ]);
  });
});
