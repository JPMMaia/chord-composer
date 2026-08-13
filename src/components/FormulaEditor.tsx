import React, { useMemo, useState } from 'react';
import type { FormulaStep, MelodicFormula } from '@/engine/formulas';
import { accidentalLabel, formulaLengthBeats } from '@/engine/formulas';
import { emptyLibrary, newId, withFormula, withGroup } from '@/engine/formulaLibrary';
import { formulaLibraryStore, newLoadedId } from '@/store/formulaLibraryStore';

/** Sentinel value for the "new group" entry in the group select. */
const NEW_GROUP = '__new__';

/** Alterations a step may carry, in the order the accidentals read on a stave. */
const ALTERATIONS = [-2, -1, 0, 1, 2];

const FIELD_CLASS =
  'px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500';

const BUTTON_CLASS =
  'px-3 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 hover:bg-gray-600 focus:outline-none focus:border-indigo-500';

export interface FormulaEditorProps {
  /** The formula being edited, or a captured draft. */
  formula: MelodicFormula;
  /** Library and group it should land in, when they are already known. */
  libraryId?: string | null;
  groupId?: string | null;
  /** One line about where the draft came from, e.g. what a capture had to skip. */
  notice?: string;
  onClose: () => void;
}

/**
 * Editor for one formula: what it is called, and the notes it is made of.
 *
 * A formula is a shape in scale degrees rather than a tune, so the table below asks
 * for degrees and beats rather than pitches: 0 is wherever the phrase is started from,
 * +1 the step above it, -1 the step below. That is what lets the same row of numbers
 * be dropped in any key, from any degree, and still be the same gesture. The accidental
 * beside each degree is how a phrase names a note its scale does not contain — a
 * leading tone into the tonic of D dorian is degree 6 with a sharp on it.
 *
 * Opened three ways — empty for a new formula, on an existing one from the library
 * dialog, or pre-filled from a timeline selection — which are the same thing once the
 * draft exists, so there is only the one component.
 */
export const FormulaEditor: React.FC<FormulaEditorProps> = ({
  formula,
  libraryId,
  groupId,
  notice,
  onClose,
}) => {
  const libraries = formulaLibraryStore(s => s.libraries);
  const selectedLibraryId = formulaLibraryStore(s => s.selectedLibraryId);
  const selectedGroupId = formulaLibraryStore(s => s.selectedGroupId);

  const [name, setName] = useState(formula.name);
  const [description, setDescription] = useState(formula.description ?? '');
  const [steps, setSteps] = useState<FormulaStep[]>(formula.steps);
  const [targetLibraryId, setTargetLibraryId] = useState<string | null>(
    libraryId ?? selectedLibraryId ?? libraries[0]?.id ?? null
  );
  const [targetGroupId, setTargetGroupId] = useState<string>(
    groupId ?? selectedGroupId ?? NEW_GROUP
  );
  const [newGroupName, setNewGroupName] = useState('My Formulas');

  const targetLibrary = libraries.find(l => l.id === targetLibraryId) ?? null;
  const groups = targetLibrary?.library.groups ?? [];
  // A group belonging to another library is not a target here, and neither is a
  // remembered id whose group has since been deleted.
  const groupValue = groups.some(g => g.id === targetGroupId) ? targetGroupId : NEW_GROUP;

  const preview = useMemo(
    () => ({ ...formula, name, description, steps }),
    [formula, name, description, steps]
  );

  const setStep = (index: number, changes: Partial<FormulaStep>) => {
    setSteps(current => current.map((step, i) => (i === index ? { ...step, ...changes } : step)));
  };

  const addStep = () => {
    // A new row copies the last one's rhythm — a phrase is usually written in one
    // note value, and repeating that by hand for every step is the tedious part.
    const last = steps[steps.length - 1];
    setSteps([...steps, { degree: last ? last.degree : 0, beats: last ? last.beats : 1 }]);
  };

  const removeStep = (index: number) => {
    setSteps(current => current.filter((_, i) => i !== index));
  };

  const save = () => {
    if (steps.length === 0) return;
    const store = formulaLibraryStore.getState();

    // Everything below can be missing at once — a capture made before any library was
    // opened has neither — so the target is built up rather than required.
    let intoLibraryId = targetLibraryId;
    if (!intoLibraryId) {
      intoLibraryId = newLoadedId();
      store.addLibrary({
        id: intoLibraryId,
        library: emptyLibrary('My Formulas'),
        ref: null,
        savedText: null,
      });
    }

    let intoGroupId = groupValue;
    if (intoGroupId === NEW_GROUP) {
      intoGroupId = newId('group');
      store.updateLibrary(intoLibraryId, library =>
        withGroup(library, {
          id: intoGroupId,
          name: newGroupName.trim() || 'My Formulas',
          formulas: [],
        })
      );
    }

    store.updateLibrary(intoLibraryId, library =>
      withFormula(library, intoGroupId, {
        id: formula.id,
        name: name.trim() || 'Formula',
        description: description.trim() || undefined,
        steps,
      })
    );
    store.selectGroup(intoLibraryId, intoGroupId);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      data-testid="formula-editor"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Edit formula"
        className="w-full max-w-xl max-h-full overflow-y-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-4 space-y-3"
      >
        <h2 className="text-sm font-semibold text-gray-200">Formula</h2>

        {notice && (
          <p className="text-xs text-yellow-300" role="status" data-testid="formula-editor-notice">
            {notice}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Name
            <input
              className={FIELD_CLASS}
              aria-label="Formula name"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Description
            <input
              className={FIELD_CLASS}
              aria-label="Formula description"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Library
            <select
              className={FIELD_CLASS}
              aria-label="Target library"
              value={targetLibraryId ?? ''}
              onChange={e => {
                setTargetLibraryId(e.target.value || null);
                // Groups belong to one library, so the old choice cannot survive.
                setTargetGroupId(NEW_GROUP);
              }}
            >
              {libraries.length === 0 && <option value="">New library</option>}
              {libraries.map(loaded => (
                <option key={loaded.id} value={loaded.id}>
                  {loaded.library.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Group
            <select
              className={FIELD_CLASS}
              aria-label="Target group"
              value={groupValue}
              onChange={e => setTargetGroupId(e.target.value)}
            >
              {groups.map(group => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
              <option value={NEW_GROUP}>New group…</option>
            </select>
          </label>
          {groupValue === NEW_GROUP && (
            <label className="flex flex-col gap-1 text-xs text-gray-400 col-span-2">
              New group name
              <input
                className={FIELD_CLASS}
                aria-label="New group name"
                value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
              />
            </label>
          )}
        </div>

        <div className="space-y-1">
          <div className="grid grid-cols-[1fr_auto_1fr_1fr_auto] gap-2 text-xs text-gray-400">
            <span>Degree</span>
            <span>Alter</span>
            <span>Beats</span>
            <span>Rest after</span>
            <span className="sr-only">Remove</span>
          </div>
          {steps.map((step, index) => (
            <div key={index} className="grid grid-cols-[1fr_auto_1fr_1fr_auto] gap-2">
              <input
                type="number"
                step={1}
                className={FIELD_CLASS}
                aria-label={`Step ${index + 1} degree`}
                value={step.degree}
                onChange={e => setStep(index, { degree: Math.round(Number(e.target.value) || 0) })}
              />
              <select
                className={FIELD_CLASS}
                aria-label={`Step ${index + 1} alteration`}
                value={step.alter ?? 0}
                onChange={e => {
                  // A natural is the plain degree, so it is stored as no alteration
                  // at all — the same note, and the same JSON as before this existed.
                  const alter = Number(e.target.value);
                  setStep(index, { alter: alter || undefined });
                }}
              >
                {ALTERATIONS.map(alter => (
                  <option key={alter} value={alter}>
                    {accidentalLabel(alter) || '♮'}
                  </option>
                ))}
              </select>
              <input
                type="number"
                step={0.25}
                min={0.25}
                className={FIELD_CLASS}
                aria-label={`Step ${index + 1} beats`}
                value={step.beats}
                onChange={e => {
                  // A note of no length is not a note; the smallest grid value is the
                  // floor rather than letting a zero through.
                  const beats = Number(e.target.value);
                  setStep(index, { beats: Number.isFinite(beats) && beats > 0 ? beats : 0.25 });
                }}
              />
              <input
                type="number"
                step={0.25}
                min={0}
                className={FIELD_CLASS}
                aria-label={`Step ${index + 1} rest`}
                value={step.gapBeats ?? 0}
                onChange={e => {
                  const gap = Number(e.target.value);
                  setStep(index, {
                    gapBeats: Number.isFinite(gap) && gap > 0 ? gap : undefined,
                  });
                }}
              />
              <button
                type="button"
                className={BUTTON_CLASS}
                aria-label={`Remove step ${index + 1}`}
                onClick={() => removeStep(index)}
              >
                ✕
              </button>
            </div>
          ))}
          <button type="button" className={BUTTON_CLASS} onClick={addStep}>
            Add step
          </button>
        </div>

        <p className="text-xs text-gray-400" data-testid="formula-editor-length">
          {steps.length} {steps.length === 1 ? 'note' : 'notes'} ·{' '}
          {formulaLengthBeats(preview)} beats
        </p>

        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON_CLASS} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-sm bg-indigo-600 rounded text-white hover:bg-indigo-500 disabled:opacity-50"
            onClick={save}
            disabled={steps.length === 0}
          >
            Save formula
          </button>
        </div>
      </div>
    </div>
  );
};
