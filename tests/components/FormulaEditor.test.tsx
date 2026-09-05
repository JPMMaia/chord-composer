import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FormulaEditor } from '@/components/FormulaEditor';
import { emptyLibrary, serializeLibrary, withGroup } from '@/engine/formulaLibrary';
import { formulaLibraryStore, type LoadedLibrary } from '@/store/formulaLibraryStore';
import type { MelodicFormula } from '@/engine/formulas';

vi.mock('@/engine/refStorage', () => ({
  storeLibraryRefs: vi.fn(async () => {}),
  loadLibraryRefs: vi.fn(async () => []),
}));

const arch: MelodicFormula = {
  id: 'f1',
  name: 'Arch',
  steps: [
    { degree: 0, beats: 1 },
    { degree: 1, beats: 1 },
  ],
};

function loaded(): LoadedLibrary {
  const library = withGroup(emptyLibrary('Classic'), {
    id: 'g1',
    name: 'Neumes',
    formulas: [arch],
  });
  return { id: 'l1', library, ref: null, savedText: serializeLibrary(library) };
}

const groups = () => formulaLibraryStore.getState().libraries[0].library.groups;

describe('FormulaEditor', () => {
  beforeEach(() => {
    formulaLibraryStore.setState({
      libraries: [],
      selectedLibraryId: null,
      selectedGroupId: null,
    });
    formulaLibraryStore.getState().addLibrary(loaded());
  });

  it('saves an edited formula back over the one it opened on', () => {
    const onClose = vi.fn();
    render(<FormulaEditor formula={arch} libraryId="l1" groupId="g1" onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('Formula name'), { target: { value: 'Renamed' } });
    fireEvent.change(screen.getByLabelText('Step 2 degree'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Save formula'));

    expect(groups()[0].formulas).toHaveLength(1);
    expect(groups()[0].formulas[0]).toMatchObject({
      id: 'f1',
      name: 'Renamed',
      steps: [
        { degree: 0, beats: 1 },
        { degree: 2, beats: 1 },
      ],
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('adds and removes steps', () => {
    render(<FormulaEditor formula={arch} libraryId="l1" groupId="g1" onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Add step'));
    expect(screen.getByLabelText('Step 3 beats')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Remove step 1'));
    fireEvent.click(screen.getByText('Save formula'));

    expect(groups()[0].formulas[0].steps).toHaveLength(2);
  });

  it('records a rest after a step', () => {
    render(<FormulaEditor formula={arch} libraryId="l1" groupId="g1" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Step 1 rest'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Save formula'));

    expect(groups()[0].formulas[0].steps[0].gapBeats).toBe(2);
  });

  it('raises a step, and reads a natural back as no alteration', () => {
    const { unmount } = render(
      <FormulaEditor formula={arch} libraryId="l1" groupId="g1" onClose={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText('Step 2 alteration'), { target: { value: '1' } });
    fireEvent.click(screen.getByText('Save formula'));
    expect(groups()[0].formulas[0].steps[1].alter).toBe(1);

    // Reopened on what was just saved: the select comes up on the sharp, and setting
    // it back to a natural must clear the field rather than store a zero.
    unmount();
    render(
      <FormulaEditor
        formula={groups()[0].formulas[0]}
        libraryId="l1"
        groupId="g1"
        onClose={vi.fn()}
      />
    );
    fireEvent.change(screen.getByLabelText('Step 2 alteration'), { target: { value: '0' } });
    fireEvent.click(screen.getByText('Save formula'));
    expect(groups()[0].formulas[0].steps[1].alter).toBeUndefined();
  });

  it('measures the draft as it is edited, rests included', () => {
    render(<FormulaEditor formula={arch} libraryId="l1" groupId="g1" onClose={vi.fn()} />);
    expect(screen.getByTestId('formula-editor-length')).toHaveTextContent('2 blocks · 2 beats');

    fireEvent.change(screen.getByLabelText('Step 1 rest'), { target: { value: '2' } });
    expect(screen.getByTestId('formula-editor-length')).toHaveTextContent('2 blocks · 4 beats');
  });

  it('puts a capture into a new group when it is told to', () => {
    render(
      <FormulaEditor
        formula={{ id: 'f2', name: 'Captured', steps: [{ degree: 0, beats: 1 }] }}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText('Target group'), { target: { value: '__new__' } });
    fireEvent.change(screen.getByLabelText('New group name'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByText('Save formula'));

    expect(groups().map(g => g.name)).toEqual(['Neumes', 'Mine']);
    expect(groups()[1].formulas.map(f => f.id)).toEqual(['f2']);
    // The strip follows what was just saved, so the new chip is on screen.
    expect(formulaLibraryStore.getState().selectedGroupId).toBe(groups()[1].id);
  });

  it('starts a library for a capture made before there was one', () => {
    formulaLibraryStore.setState({
      libraries: [],
      selectedLibraryId: null,
      selectedGroupId: null,
    });
    render(
      <FormulaEditor
        formula={{ id: 'f2', name: 'Captured', steps: [{ degree: 0, beats: 1 }] }}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('Save formula'));

    const libraries = formulaLibraryStore.getState().libraries;
    expect(libraries).toHaveLength(1);
    expect(libraries[0].ref).toBeNull();
    expect(libraries[0].library.groups[0].formulas.map(f => f.id)).toEqual(['f2']);
  });

  it('shows what a capture had to leave behind', () => {
    render(
      <FormulaEditor
        formula={{ id: 'f2', name: 'Captured', steps: [{ degree: 0, beats: 1 }] }}
        notice="1 chord block skipped"
        onClose={vi.fn()}
      />
    );
    expect(screen.getByTestId('formula-editor-notice')).toHaveTextContent('1 chord block skipped');
  });

  it('gives a step a key of its own, named as an interval from the home key', () => {
    render(<FormulaEditor formula={arch} libraryId="l1" groupId="g1" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Step 2 scale'), {
      target: { value: 'naturalMinor' },
    });
    fireEvent.change(screen.getByLabelText('Step 2 scale root'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Save formula'));

    expect(groups()[0].formulas[0].steps[1].scale).toEqual({
      rootOffset: 2,
      type: 'naturalMinor',
    });
    // The other step still says nothing, which is what the home key means.
    expect(groups()[0].formulas[0].steps[0].scale).toBeUndefined();
  });

  it('puts a step back in the home key, writing nothing down for it', () => {
    const modal: MelodicFormula = {
      id: 'f1',
      name: 'Modal',
      steps: [
        { degree: 0, beats: 1 },
        { degree: 1, beats: 1, scale: { rootOffset: 2, type: 'naturalMinor' } },
      ],
    };
    render(<FormulaEditor formula={modal} libraryId="l1" groupId="g1" onClose={vi.fn()} />);

    expect(screen.getByLabelText('Step 2 scale')).toHaveValue('naturalMinor');
    fireEvent.change(screen.getByLabelText('Step 2 scale'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save formula'));

    expect(groups()[0].formulas[0].steps[1].scale).toBeUndefined();
  });

  it('turns a step into a chord, and asks only then what chord it is', () => {
    render(<FormulaEditor formula={arch} libraryId="l1" groupId="g1" onClose={vi.fn()} />);
    // A note has no quality to state, so the row does not ask for one.
    expect(screen.queryByLabelText('Step 2 quality')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Step 2 kind'), { target: { value: 'chord' } });
    fireEvent.change(screen.getByLabelText('Step 2 quality'), { target: { value: 'dominant7' } });
    fireEvent.change(screen.getByLabelText('Step 2 inversion'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Save formula'));

    expect(groups()[0].formulas[0].steps[1]).toMatchObject({
      kind: 'chord',
      quality: 'dominant7',
      inversion: 2,
    });
  });

  it('leaves a chord diatonic when nothing else is said', () => {
    render(<FormulaEditor formula={arch} libraryId="l1" groupId="g1" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Step 1 kind'), { target: { value: 'chord' } });
    fireEvent.click(screen.getByText('Save formula'));

    expect(groups()[0].formulas[0].steps[0]).toMatchObject({ kind: 'chord' });
    expect(groups()[0].formulas[0].steps[0].quality).toBeUndefined();
  });

  it('drops the chord fields when a chord is turned back into a note', () => {
    const progression: MelodicFormula = {
      id: 'f1',
      name: 'Cadence',
      steps: [
        { degree: 0, beats: 1 },
        {
          kind: 'chord',
          degree: 4,
          quality: 'dominant7',
          inversion: 1,
          voicing: { spacing: 'drop2' },
          beats: 1,
        },
      ],
    };
    render(<FormulaEditor formula={progression} libraryId="l1" groupId="g1" onClose={vi.fn()} />);

    // The captured voicing is visible, since it is part of what the step sounds.
    expect(screen.getByTestId('formula-step-voicing-1')).toHaveTextContent('drop2');

    fireEvent.change(screen.getByLabelText('Step 2 kind'), { target: { value: 'note' } });
    fireEvent.click(screen.getByText('Save formula'));

    expect(groups()[0].formulas[0].steps[1]).toMatchObject({ degree: 4, beats: 1 });
    expect(groups()[0].formulas[0].steps[1].kind).toBeUndefined();
    expect(groups()[0].formulas[0].steps[1].quality).toBeUndefined();
    expect(groups()[0].formulas[0].steps[1].voicing).toBeUndefined();
  });

  it('takes a captured voicing off a chord without touching the rest of it', () => {
    const strummed: MelodicFormula = {
      id: 'f1',
      name: 'Strum',
      steps: [
        {
          kind: 'chord',
          degree: 0,
          inversion: 1,
          voicing: { break: { mode: 'strum', spreadBeats: 0.1, direction: 'up' } },
          beats: 1,
        },
      ],
    };
    render(<FormulaEditor formula={strummed} libraryId="l1" groupId="g1" onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('Clear step 1 voicing'));
    fireEvent.click(screen.getByText('Save formula'));

    expect(groups()[0].formulas[0].steps[0]).toMatchObject({ kind: 'chord', inversion: 1 });
    expect(groups()[0].formulas[0].steps[0].voicing).toBeUndefined();
  });

  it('pins the mode a formula is dropped in, or leaves it to the palette', () => {
    render(<FormulaEditor formula={arch} libraryId="l1" groupId="g1" onClose={vi.fn()} />);
    expect(screen.getByLabelText('Home mode')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('Home mode'), { target: { value: 'naturalMinor' } });
    fireEvent.click(screen.getByText('Save formula'));
    expect(groups()[0].formulas[0].homeType).toBe('naturalMinor');
  });

  it('says that a chord formula following the palette will not keep its chords', () => {
    render(<FormulaEditor formula={arch} libraryId="l1" groupId="g1" onClose={vi.fn()} />);
    // A bare melodic shape is fine either way, so nothing is said about it.
    expect(screen.getByLabelText('Home mode').parentElement).toHaveTextContent(
      'Retunes to whatever key'
    );

    fireEvent.change(screen.getByLabelText('Step 1 kind'), { target: { value: 'chord' } });
    expect(screen.getByLabelText('Home mode').parentElement).toHaveTextContent(
      'names a chord or a second key'
    );
  });

  it('refuses to save a formula with no notes in it', () => {
    render(<FormulaEditor formula={{ id: 'f3', name: 'Empty', steps: [] }} onClose={vi.fn()} />);
    expect(screen.getByText('Save formula')).toBeDisabled();
  });
});
