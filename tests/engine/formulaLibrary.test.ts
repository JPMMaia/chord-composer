import { describe, it, expect } from 'vitest';
import {
  FORMULA_LIBRARY_VERSION,
  deserializeLibrary,
  emptyLibrary,
  newId,
  serializeLibrary,
  withFormula,
  withGroup,
  withRenamedGroup,
  withoutFormula,
  withoutGroup,
  type FormulaLibrary,
} from '@/engine/formulaLibrary';
import type { MelodicFormula } from '@/engine/formulas';

const arch: MelodicFormula = {
  id: 'arch',
  name: 'Arch',
  description: 'Up a fourth and back',
  steps: [
    { degree: 0, beats: 1 },
    { degree: 1, beats: 1, gapBeats: 0.5 },
    { degree: 0, beats: 2 },
  ],
};

const library = (): FormulaLibrary => ({
  ...emptyLibrary('Classic'),
  groups: [{ id: 'g1', name: 'Neumes', formulas: [arch] }],
});

describe('serializing a library', () => {
  it('round-trips everything a formula carries', () => {
    const read = deserializeLibrary(serializeLibrary(library()));
    expect(read.name).toBe('Classic');
    expect(read.groups).toEqual(library().groups);
  });

  it('refuses a file that lists no groups, naming what it probably is', () => {
    expect(() => deserializeLibrary('{"instruments":[]}')).toThrow(/lists no groups/);
    expect(() => deserializeLibrary('not json')).toThrow(/not a valid formula library/);
  });

  it('drops a step with no length rather than failing the whole load', () => {
    const read = deserializeLibrary(
      JSON.stringify({
        groups: [
          {
            id: 'g',
            name: 'G',
            formulas: [{ id: 'f', name: 'F', steps: [{ degree: 0, beats: 0 }, { degree: 1, beats: 1 }] }],
          },
        ],
      })
    );
    expect(read.groups[0].formulas[0].steps).toEqual([{ degree: 1, beats: 1, gapBeats: undefined }]);
  });

  it('drops a formula left with no steps at all', () => {
    const read = deserializeLibrary(
      JSON.stringify({ groups: [{ id: 'g', name: 'G', formulas: [{ id: 'f', name: 'F', steps: [] }] }] })
    );
    expect(read.groups[0].formulas).toEqual([]);
  });

  it('keeps an empty group, which is what a new one is', () => {
    const read = deserializeLibrary(JSON.stringify({ groups: [{ id: 'g', name: 'G', formulas: [] }] }));
    expect(read.groups).toHaveLength(1);
  });

  it('names and identifies what a hand-written file left out', () => {
    const read = deserializeLibrary(
      JSON.stringify({ groups: [{ formulas: [{ steps: [{ degree: 0, beats: 1 }] }] }] })
    );
    expect(read.version).toBe(FORMULA_LIBRARY_VERSION);
    expect(read.groups[0].id).toMatch(/^group-/);
    expect(read.groups[0].name).toBe('Group 1');
    expect(read.groups[0].formulas[0].id).toMatch(/^formula-/);
    expect(read.groups[0].formulas[0].name).toBe('Formula 1');
  });

  it('round-trips an alteration, and reads a natural as none', () => {
    const altered = deserializeLibrary(
      serializeLibrary({
        ...emptyLibrary('Chromatic'),
        groups: [
          {
            id: 'g',
            name: 'G',
            formulas: [
              {
                id: 'f',
                name: 'F',
                steps: [
                  { degree: 6, alter: 1, beats: 1 },
                  { degree: 0, alter: 0, beats: 1 },
                ],
              },
            ],
          },
        ],
      })
    );
    expect(altered.groups[0].formulas[0].steps[0].alter).toBe(1);
    expect(altered.groups[0].formulas[0].steps[1].alter).toBeUndefined();
  });

  it('rounds and clamps an alteration a file asks too much of', () => {
    const read = deserializeLibrary(
      JSON.stringify({
        groups: [
          {
            formulas: [
              {
                steps: [
                  { degree: 0, alter: 7, beats: 1 },
                  { degree: 1, alter: -1.4, beats: 1 },
                  { degree: 2, alter: 'sharp', beats: 1 },
                ],
              },
            ],
          },
        ],
      })
    );
    expect(read.groups[0].formulas[0].steps.map(s => s.alter)).toEqual([2, -1, undefined]);
  });

  it('reads a negative rest as no rest', () => {
    const read = deserializeLibrary(
      JSON.stringify({
        groups: [{ formulas: [{ steps: [{ degree: 0, beats: 1, gapBeats: -2 }] }] }],
      })
    );
    expect(read.groups[0].formulas[0].steps[0].gapBeats).toBeUndefined();
  });
});

describe('editing a library', () => {
  it('adds, renames and removes a group without touching the others', () => {
    const withNew = withGroup(library(), { id: 'g2', name: 'Cadences', formulas: [] });
    expect(withNew.groups.map(g => g.id)).toEqual(['g1', 'g2']);

    const renamed = withRenamedGroup(withNew, 'g2', 'Clausulae');
    expect(renamed.groups[1].name).toBe('Clausulae');
    expect(renamed.groups[0]).toEqual(library().groups[0]);

    expect(withoutGroup(renamed, 'g1').groups.map(g => g.id)).toEqual(['g2']);
  });

  it('inserts a formula, and replaces it when it is saved again', () => {
    const added = withFormula(library(), 'g1', { id: 'clivis', name: 'Clivis', steps: arch.steps });
    expect(added.groups[0].formulas.map(f => f.id)).toEqual(['arch', 'clivis']);

    const edited = withFormula(added, 'g1', { id: 'arch', name: 'Renamed', steps: arch.steps });
    expect(edited.groups[0].formulas.map(f => f.name)).toEqual(['Renamed', 'Clivis']);
  });

  it('moves a formula out of its old group when it is saved into another', () => {
    const two = withGroup(library(), { id: 'g2', name: 'Cadences', formulas: [] });
    const moved = withFormula(two, 'g2', arch);
    expect(moved.groups[0].formulas).toEqual([]);
    expect(moved.groups[1].formulas.map(f => f.id)).toEqual(['arch']);
  });

  it('removes a formula wherever it is', () => {
    expect(withoutFormula(library(), 'arch').groups[0].formulas).toEqual([]);
  });

  it('leaves the library it was given alone', () => {
    const original = library();
    withGroup(original, { id: 'g2', name: 'X', formulas: [] });
    withoutFormula(original, 'arch');
    expect(original.groups[0].formulas).toHaveLength(1);
    expect(original.groups).toHaveLength(1);
  });
});

describe('newId', () => {
  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newId('group')));
    expect(ids.size).toBe(50);
  });
});

describe('a step that names its own key or a chord', () => {
  const modulating: FormulaLibrary = {
    ...emptyLibrary('Modal'),
    groups: [
      {
        id: 'g1',
        name: 'Shifts',
        formulas: [
          {
            id: 'shift',
            name: 'Shift',
            steps: [
              { degree: 0, beats: 1 },
              {
                kind: 'chord',
                degree: 1,
                scale: { rootOffset: 2, type: 'naturalMinor' },
                quality: 'dominant7',
                inversion: 2,
                voicing: { spacing: 'drop2' },
                velocity: 72,
                beats: 2,
              },
            ],
          },
        ],
      },
    ],
  };

  it('round-trips every field a step can carry', () => {
    const read = deserializeLibrary(serializeLibrary(modulating));
    expect(read.groups[0].formulas[0].steps).toEqual(modulating.groups[0].formulas[0].steps);
  });

  it('writes nothing new for a formula that names one key and no chords', () => {
    // A library of plain melodic shapes must serialise exactly as it did before a
    // step could say any of this, or every saved file would churn on open.
    const text = serializeLibrary(library());
    expect(text).not.toContain('"scale"');
    expect(text).not.toContain('"kind"');
    expect(text).not.toContain('"quality"');
  });

  it('drops a key it cannot resolve rather than the step that names it', () => {
    const read = deserializeLibrary(
      JSON.stringify({
        groups: [
          {
            id: 'g',
            name: 'G',
            formulas: [
              {
                id: 'f',
                name: 'F',
                steps: [{ degree: 2, beats: 1, scale: { rootOffset: 3, type: 'wobbly' } }],
              },
            ],
          },
        ],
      })
    );
    // The degree still names a note in the home key, which is a better answer than
    // a scale invented out of a misspelling.
    expect(read.groups[0].formulas[0].steps).toEqual([
      { degree: 2, beats: 1, scale: undefined },
    ]);
  });

  it('normalises a root offset that runs off either end of the octave', () => {
    const step = (rootOffset: number) =>
      deserializeLibrary(
        JSON.stringify({
          groups: [
            {
              id: 'g',
              name: 'G',
              formulas: [
                { id: 'f', name: 'F', steps: [{ degree: 0, beats: 1, scale: { rootOffset, type: 'dorian' } }] },
              ],
            },
          ],
        })
      ).groups[0].formulas[0].steps[0].scale;

    expect(step(14)).toEqual({ rootOffset: 2, type: 'dorian' });
    expect(step(-1)).toEqual({ rootOffset: 11, type: 'dorian' });
  });

  it('ignores chord fields on a step that is not a chord', () => {
    const read = deserializeLibrary(
      JSON.stringify({
        groups: [
          {
            id: 'g',
            name: 'G',
            formulas: [
              {
                id: 'f',
                name: 'F',
                steps: [
                  { degree: 0, beats: 1, quality: 'minor', inversion: 2, voicing: { spacing: 'open' } },
                ],
              },
            ],
          },
        ],
      })
    );
    expect(read.groups[0].formulas[0].steps[0]).toEqual({
      kind: undefined,
      degree: 0,
      alter: undefined,
      scale: undefined,
      quality: undefined,
      inversion: undefined,
      voicing: undefined,
      velocity: undefined,
      beats: 1,
      gapBeats: undefined,
    });
  });

  it('keeps a chord step whose quality, inversion or velocity make no sense', () => {
    const read = deserializeLibrary(
      JSON.stringify({
        groups: [
          {
            id: 'g',
            name: 'G',
            formulas: [
              {
                id: 'f',
                name: 'F',
                steps: [
                  {
                    kind: 'chord',
                    degree: 0,
                    beats: 1,
                    quality: 'sparkly',
                    inversion: -3,
                    velocity: 900,
                    voicing: 'nonsense',
                  },
                ],
              },
            ],
          },
        ],
      })
    );
    // A chord with no quality is the one its scale spells, which is a real answer.
    expect(read.groups[0].formulas[0].steps[0]).toMatchObject({
      kind: 'chord',
      degree: 0,
      beats: 1,
      quality: undefined,
      inversion: undefined,
      velocity: 127,
      voicing: undefined,
    });
  });
});

describe('the mode a formula is written in', () => {
  const minor: FormulaLibrary = {
    ...emptyLibrary('Modal'),
    groups: [
      {
        id: 'g1',
        name: 'Cadences',
        formulas: [
          {
            id: 'i-VI',
            name: 'i-VI',
            homeType: 'naturalMinor',
            steps: [
              { kind: 'chord', degree: 0, beats: 1 },
              { kind: 'chord', degree: 5, beats: 1 },
            ],
          },
        ],
      },
    ],
  };

  it('round-trips through a file', () => {
    const read = deserializeLibrary(serializeLibrary(minor));
    expect(read.groups[0].formulas[0].homeType).toBe('naturalMinor');
  });

  it('hands a mode it cannot name back to the palette', () => {
    const read = deserializeLibrary(
      JSON.stringify({
        groups: [
          {
            id: 'g',
            name: 'G',
            formulas: [{ id: 'f', name: 'F', homeType: 'wobbly', steps: [{ degree: 0, beats: 1 }] }],
          },
        ],
      })
    );
    expect(read.groups[0].formulas[0].homeType).toBeUndefined();
  });

  it('writes nothing for a formula that follows the palette', () => {
    expect(serializeLibrary(library())).not.toContain('homeType');
  });
});

describe('the library version', () => {
  it('is written on everything this app saves', () => {
    expect(emptyLibrary('x').version).toBe(FORMULA_LIBRARY_VERSION);
    expect(FORMULA_LIBRARY_VERSION).toBe('1.1');
  });
});
