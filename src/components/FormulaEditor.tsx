import React, { useMemo, useState } from 'react';
import type { ChordQuality, ScaleType, SegmentVoicing } from '@/types/music';
import type { FormulaStep, MelodicFormula } from '@/engine/formulas';
import { accidentalLabel, formulaLengthBeats, formulaNeedsHomeType } from '@/engine/formulas';
import { emptyLibrary, newId, withFormula, withGroup } from '@/engine/formulaLibrary';
import { CHORD_INTERVALS } from '@/engine/chords';
import { QUALITY_SUFFIX } from '@/engine/palette';
import { formatScaleType, SCALE_INTERVALS } from '@/engine/scales';
import { formulaLibraryStore, newLoadedId } from '@/store/formulaLibraryStore';

/** Sentinel value for the "new group" entry in the group select. */
const NEW_GROUP = '__new__';

/** Alterations a step may carry, in the order the accidentals read on a stave. */
const ALTERATIONS = [-2, -1, 0, 1, 2];

const SCALE_TYPES = Object.keys(SCALE_INTERVALS) as ScaleType[];
const QUALITIES = Object.keys(CHORD_INTERVALS) as ChordQuality[];

/** Root offsets a step's own key may sit at, in semitones from the home key's root. */
const ROOT_OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** How a quality reads in the picker: 'minor (m)', 'dominant7 (7)', 'major'. */
function qualityLabel(quality: ChordQuality): string {
  const suffix = QUALITY_SUFFIX[quality];
  return suffix ? `${quality} (${suffix})` : quality;
}

/**
 * What a captured voicing amounts to, in a few words.
 *
 * A summary rather than a set of controls: a voicing is spacing, per-tone offsets,
 * doublings and a break, and it already has a proper editor in the inspector. What
 * this dialog owes the user is that a captured one is *there* and can be taken off,
 * not a second place to author one.
 */
function voicingSummary(voicing: SegmentVoicing): string {
  const parts: string[] = [];
  if (voicing.spacing) parts.push(voicing.spacing);
  if (voicing.offsets?.some(o => o !== 0)) parts.push('tone offsets');
  if (voicing.doublings?.length) parts.push(`${voicing.doublings.length} doubled`);
  if (voicing.break) parts.push(voicing.break.mode);
  return parts.join(' · ') || 'block';
}

/** One step's row: kind, degree, alter, scale, beats, rest, remove. */
const STEP_GRID = 'grid-cols-[auto_1fr_auto_minmax(0,1.6fr)_1fr_1fr_auto]';

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
 * Editor for one formula: what it is called, and the blocks it is made of.
 *
 * A formula is a shape in scale degrees rather than a tune, so the table below asks
 * for degrees and beats rather than pitches: 0 is wherever the phrase is started from,
 * +1 the step above it, -1 the step below. That is what lets the same row of numbers
 * be dropped in any key, from any degree, and still be the same gesture. The accidental
 * beside each degree is how a phrase names a note its scale does not contain — a
 * leading tone into the tonic of D dorian is degree 6 with a sharp on it.
 *
 * The Scale column is the same idea one level up: a step may name a key of its own,
 * given as an interval from the formula's home key rather than as a fixed key, so a
 * gesture that modulates still transposes as a whole. '— home —' is what every step
 * of a formula written in one key says.
 *
 * A step may also be a chord instead of a note, in which case its degree names the
 * chord's root and its quality is whatever the step's scale spells there unless it
 * says otherwise — so a captured ii-V-I becomes the new key's own ii-V-I, while a
 * borrowed chord keeps what it was captured as.
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
  const [homeType, setHomeType] = useState<ScaleType | undefined>(formula.homeType);
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
    () => ({ ...formula, name, description, homeType, steps }),
    [formula, name, description, homeType, steps]
  );

  // A shape in bare degrees means the same thing in any mode, so it can be left to
  // follow the palette. One naming a chord or a second key cannot, and saying so is
  // more use than silently retuning a progression the user meant literally.
  const modeMatters = formulaNeedsHomeType(steps);

  const setStep = (index: number, changes: Partial<FormulaStep>) => {
    setSteps(current => current.map((step, i) => (i === index ? { ...step, ...changes } : step)));
  };

  const addStep = () => {
    // A new row copies the last one's rhythm, kind and key — a phrase is usually
    // written in one note value and one key, and repeating that by hand for every
    // step is the tedious part. Its voicing is not copied: that belonged to the chord
    // it was captured from, not to the next one.
    const last = steps[steps.length - 1];
    setSteps([
      ...steps,
      last
        ? { kind: last.kind, degree: last.degree, scale: last.scale, beats: last.beats }
        : { degree: 0, beats: 1 },
    ]);
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
        homeType,
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
        className="w-full max-w-3xl max-h-full overflow-y-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-4 space-y-3"
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
          <label className="flex flex-col gap-1 text-xs text-gray-400 col-span-2">
            Home mode
            <select
              className={FIELD_CLASS}
              aria-label="Home mode"
              value={homeType ?? ''}
              onChange={e => setHomeType((e.target.value as ScaleType) || undefined)}
            >
              <option value="">— the palette's —</option>
              {SCALE_TYPES.map(type => (
                <option key={type} value={type}>
                  {formatScaleType(type)}
                </option>
              ))}
            </select>
            <span className="text-[11px] leading-tight opacity-70">
              {homeType
                ? `Always dropped in ${formatScaleType(homeType)}, on whichever root the palette is set to.`
                : modeMatters
                  ? 'This formula names a chord or a second key, so the palette’s mode will decide what its chords are. Pin a mode to keep the ones it was captured with.'
                  : 'Retunes to whatever key the palette is set to.'}
            </span>
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
          <div className={`grid ${STEP_GRID} gap-2 text-xs text-gray-400`}>
            <span>Kind</span>
            <span>Degree</span>
            <span>Alter</span>
            <span>Scale</span>
            <span>Beats</span>
            <span>Rest after</span>
            <span className="sr-only">Remove</span>
          </div>
          {steps.map((step, index) => (
            <div key={index} className="space-y-1">
             <div className={`grid ${STEP_GRID} gap-2`}>
              <select
                className={FIELD_CLASS}
                aria-label={`Step ${index + 1} kind`}
                value={step.kind === 'chord' ? 'chord' : 'note'}
                onChange={e => {
                  // A note has no quality, inversion or voicing to keep, and a row
                  // holding them while calling itself a note would be lying about
                  // what it sounds.
                  const chord = e.target.value === 'chord';
                  setStep(index, {
                    kind: chord ? 'chord' : undefined,
                    quality: undefined,
                    inversion: undefined,
                    voicing: chord ? step.voicing : undefined,
                  });
                }}
              >
                <option value="note">Note</option>
                <option value="chord">Chord</option>
              </select>
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
              <div className="flex gap-1">
                <select
                  className={`${FIELD_CLASS} min-w-0 flex-1`}
                  aria-label={`Step ${index + 1} scale`}
                  value={step.scale?.type ?? ''}
                  onChange={e => {
                    // The home key is stored as no key at all, the way a natural is
                    // stored as no alteration — the same step, and the same JSON as
                    // before a step could name one.
                    const type = e.target.value as ScaleType | '';
                    setStep(index, {
                      scale: type
                        ? { rootOffset: step.scale?.rootOffset ?? 0, type }
                        : undefined,
                    });
                  }}
                >
                  <option value="">— home —</option>
                  {SCALE_TYPES.map(type => (
                    <option key={type} value={type}>
                      {formatScaleType(type)}
                    </option>
                  ))}
                </select>
                {step.scale && (
                  <select
                    className={FIELD_CLASS}
                    aria-label={`Step ${index + 1} scale root`}
                    value={step.scale.rootOffset}
                    onChange={e =>
                      setStep(index, {
                        scale: {
                          rootOffset: Number(e.target.value),
                          type: step.scale?.type ?? 'major',
                        },
                      })
                    }
                  >
                    {ROOT_OFFSETS.map(offset => (
                      <option key={offset} value={offset}>
                        +{offset}
                      </option>
                    ))}
                  </select>
                )}
              </div>
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
             {step.kind === 'chord' && (
              <div className="flex flex-wrap items-center gap-2 pl-2 text-xs text-gray-400">
                <label className="flex items-center gap-1">
                  Quality
                  <select
                    className={FIELD_CLASS}
                    aria-label={`Step ${index + 1} quality`}
                    value={step.quality ?? ''}
                    onChange={e =>
                      // No quality means the one the step's scale spells for its
                      // degree, which is what makes a diatonic progression follow the
                      // key it is dropped in.
                      setStep(index, {
                        quality: (e.target.value as ChordQuality) || undefined,
                      })
                    }
                  >
                    <option value="">— diatonic —</option>
                    {QUALITIES.map(quality => (
                      <option key={quality} value={quality}>
                        {qualityLabel(quality)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1">
                  Inversion
                  <select
                    className={FIELD_CLASS}
                    aria-label={`Step ${index + 1} inversion`}
                    value={step.inversion ?? 0}
                    onChange={e =>
                      setStep(index, { inversion: Number(e.target.value) || undefined })
                    }
                  >
                    {[0, 1, 2, 3].map(inversion => (
                      <option key={inversion} value={inversion}>
                        {inversion}
                      </option>
                    ))}
                  </select>
                </label>
                {step.voicing && (
                  <span className="flex items-center gap-1">
                    <span data-testid={`formula-step-voicing-${index}`}>
                      Voicing: {voicingSummary(step.voicing)}
                    </span>
                    <button
                      type="button"
                      className={BUTTON_CLASS}
                      aria-label={`Clear step ${index + 1} voicing`}
                      onClick={() => setStep(index, { voicing: undefined })}
                    >
                      Clear
                    </button>
                  </span>
                )}
              </div>
             )}
            </div>
          ))}
          <button type="button" className={BUTTON_CLASS} onClick={addStep}>
            Add step
          </button>
        </div>

        <p className="text-xs text-gray-400" data-testid="formula-editor-length">
          {steps.length} {steps.length === 1 ? 'block' : 'blocks'} ·{' '}
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
