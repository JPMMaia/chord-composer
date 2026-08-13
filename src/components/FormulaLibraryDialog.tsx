import React, { useRef, useState } from 'react';
import type { MelodicFormula } from '@/engine/formulas';
import { formulaLengthBeats } from '@/engine/formulas';
import {
  newId,
  withGroup,
  withRenamedGroup,
  withoutFormula,
  withoutGroup,
} from '@/engine/formulaLibrary';
import { canPickFiles, fileLabel } from '@/engine/projectFile';
import { formulaLibraryStore, isLibraryDirty } from '@/store/formulaLibraryStore';
import { useFormulaLibraryState } from '@/context/formulaLibraryContext';
import { FormulaEditor } from '@/components/FormulaEditor';

const BUTTON_CLASS =
  'px-2 py-1 text-xs bg-gray-700 border border-gray-600 rounded text-gray-200 hover:bg-gray-600 focus:outline-none focus:border-indigo-500';

const FIELD_CLASS =
  'px-2 py-1 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 focus:outline-none focus:border-indigo-500';

/** A draft being edited, and the group it came from. */
interface EditingFormula {
  formula: MelodicFormula;
  libraryId: string;
  groupId: string;
}

/**
 * Manager for the open formula libraries: their files, their groups, and what is in
 * them.
 *
 * The strip itself only ever shows one group at a time, which is the right amount of
 * furniture for dragging but no place to reorganise anything. This is where a library
 * is created, opened, saved and closed, and where groups and formulas are renamed and
 * thrown away.
 *
 * Every edit goes through `updateLibrary` and the pure helpers in `formulaLibrary.ts`,
 * so the dialog holds no copy of a library — only which row is currently being renamed.
 */
export const FormulaLibraryDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const libraries = formulaLibraryStore(s => s.libraries);
  const updateLibrary = formulaLibraryStore(s => s.updateLibrary);
  const closeLibraryInStore = formulaLibraryStore(s => s.closeLibrary);
  const {
    error,
    clearError,
    newLibrary,
    openLibrary,
    openLibraryFile,
    loadStarterLibrary,
    saveLibrary,
    saveLibraryAs,
    reloadLibrary,
  } = useFormulaLibraryState();

  const [editing, setEditing] = useState<EditingFormula | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const open = canPickFiles() ? openLibrary : () => fileInputRef.current?.click();

  const onFilePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so picking the same file twice still fires a change event.
    event.target.value = '';
    if (file) await openLibraryFile(file);
  };

  const closeLibrary = (id: string, name: string, dirty: boolean) => {
    // Only when there is something to lose: a confirm on every close would train the
    // user to click through the one that matters.
    if (dirty && !window.confirm(`“${name}” has unsaved changes. Close it anyway?`)) return;
    closeLibraryInStore(id);
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      data-testid="formula-library-dialog"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Formula libraries"
        className="w-full max-w-2xl max-h-full overflow-y-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-4 space-y-3"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-200">Formula libraries</h2>
          <div className="flex gap-2">
            <button type="button" className={BUTTON_CLASS} onClick={newLibrary}>
              New library
            </button>
            <button type="button" className={BUTTON_CLASS} onClick={() => void open()}>
              Open…
            </button>
            <button
              type="button"
              className={BUTTON_CLASS}
              onClick={() => void loadStarterLibrary()}
              title="The classic medieval, cadential, ornament and shape formulas that ship with the app"
            >
              Load starter set
            </button>
            <button type="button" className={BUTTON_CLASS} onClick={onClose} aria-label="Close">
              Done
            </button>
          </div>
        </div>

        {error && (
          <p role="alert" className="flex items-center gap-2 text-xs text-red-400">
            {error}
            <button onClick={clearError} className="underline" aria-label="Dismiss error">
              Dismiss
            </button>
          </p>
        )}

        {libraries.length === 0 && (
          <p className="text-sm text-gray-400">
            No libraries are open. Create one, open a <code>.ccformulas</code> file, or load
            the starter set.
          </p>
        )}

        {libraries.map(loaded => {
          const dirty = isLibraryDirty(loaded);
          return (
            <section
              key={loaded.id}
              className="border border-gray-700 rounded p-3 space-y-2"
              data-testid={`library-${loaded.id}`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  className={`${FIELD_CLASS} flex-1 min-w-40`}
                  aria-label="Library name"
                  value={loaded.library.name}
                  onChange={e =>
                    updateLibrary(loaded.id, library => ({ ...library, name: e.target.value }))
                  }
                />
                <span className="text-xs text-gray-400" data-testid={`library-file-${loaded.id}`}>
                  {loaded.ref ? fileLabel(loaded.ref) : 'Unsaved'}
                  {dirty && (
                    <span className="ml-1 text-yellow-500" title="Unsaved changes">
                      •
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className={BUTTON_CLASS}
                  onClick={() => void saveLibrary(loaded.id)}
                >
                  Save
                </button>
                <button
                  type="button"
                  className={BUTTON_CLASS}
                  onClick={() => void saveLibraryAs(loaded.id)}
                >
                  Save As…
                </button>
                {loaded.needsPermission && (
                  <button
                    type="button"
                    className={BUTTON_CLASS}
                    onClick={() => void reloadLibrary(loaded.id)}
                    title="This file was remembered but needs permission before it can be read"
                  >
                    Reload
                  </button>
                )}
                <button
                  type="button"
                  className={BUTTON_CLASS}
                  onClick={() => closeLibrary(loaded.id, loaded.library.name, dirty)}
                >
                  Close
                </button>
              </div>

              {loaded.needsPermission && (
                <p className="text-xs text-yellow-300">
                  This library was open last session. Reload it to grant access again.
                </p>
              )}

              {loaded.library.groups.map(group => (
                <div key={group.id} className="pl-2 border-l border-gray-700 space-y-1">
                  <div className="flex items-center gap-2">
                    <input
                      className={`${FIELD_CLASS} flex-1`}
                      aria-label="Group name"
                      value={group.name}
                      onChange={e =>
                        updateLibrary(loaded.id, library =>
                          withRenamedGroup(library, group.id, e.target.value)
                        )
                      }
                    />
                    <button
                      type="button"
                      className={BUTTON_CLASS}
                      aria-label={`Delete group ${group.name}`}
                      onClick={() =>
                        updateLibrary(loaded.id, library => withoutGroup(library, group.id))
                      }
                    >
                      Delete group
                    </button>
                  </div>

                  {group.formulas.length === 0 && (
                    <p className="text-xs text-gray-500">
                      Empty — capture a timeline selection into it, or add a formula.
                    </p>
                  )}

                  <ul className="space-y-1">
                    {group.formulas.map(formula => (
                      <li
                        key={formula.id}
                        className="flex items-center gap-2 text-sm text-gray-300"
                        data-testid={`library-formula-${formula.id}`}
                      >
                        <span className="flex-1 truncate">
                          {formula.name}
                          <span className="ml-2 text-xs text-gray-500">
                            {formula.steps.length} notes · {formulaLengthBeats(formula)} beats
                          </span>
                        </span>
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          aria-label={`Edit ${formula.name}`}
                          onClick={() =>
                            setEditing({ formula, libraryId: loaded.id, groupId: group.id })
                          }
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          aria-label={`Delete ${formula.name}`}
                          onClick={() =>
                            updateLibrary(loaded.id, library =>
                              withoutFormula(library, formula.id)
                            )
                          }
                        >
                          Delete
                        </button>
                      </li>
                    ))}
                  </ul>

                  <button
                    type="button"
                    className={BUTTON_CLASS}
                    onClick={() =>
                      setEditing({
                        // A blank draft rather than a saved formula: nothing is written
                        // to the library until the editor's own Save.
                        formula: { id: newId('formula'), name: 'New formula', steps: [] },
                        libraryId: loaded.id,
                        groupId: group.id,
                      })
                    }
                  >
                    Add formula
                  </button>
                </div>
              ))}

              <button
                type="button"
                className={BUTTON_CLASS}
                onClick={() =>
                  updateLibrary(loaded.id, library =>
                    withGroup(library, {
                      id: newId('group'),
                      name: `Group ${library.groups.length + 1}`,
                      formulas: [],
                    })
                  )
                }
              >
                New group
              </button>
            </section>
          );
        })}

        <input
          ref={fileInputRef}
          type="file"
          accept=".ccformulas,application/json"
          className="hidden"
          onChange={onFilePicked}
          data-testid="formula-library-file-input"
        />
      </div>

      {editing && (
        <FormulaEditor
          formula={editing.formula}
          libraryId={editing.libraryId}
          groupId={editing.groupId}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
};
