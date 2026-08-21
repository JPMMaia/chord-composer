import React, { useMemo, useState } from 'react';
import {
  FORMULA_DRAG_TYPE,
  accidentalLabel,
  captureFormula,
  formulaLengthBeats,
  type MelodicFormula,
} from '@/engine/formulas';
import { newId } from '@/engine/formulaLibrary';
import { getDiatonicChords } from '@/engine/chords';
import { editorStore } from '@/store/editorStore';
import { formulaLibraryStore } from '@/store/formulaLibraryStore';
import { editSurface, projectStore } from '@/store/projectStore';
import { selectionStore } from '@/store/selectionStore';
import { useFormulaLibraryState } from '@/context/formulaLibraryContext';
import { FormulaEditor } from '@/components/FormulaEditor';
import { FormulaLibraryDialog } from '@/components/FormulaLibraryDialog';

/** How a formula's shape reads under its name, e.g. '0 +1 +2♯ +1 0'. */
function shapeLabel(formula: MelodicFormula): string {
  return formula.steps
    .map(step => {
      const degree = step.degree > 0 ? `+${step.degree}` : String(step.degree);
      // The accidental follows the degree so the numbers stay in one column and an
      // altered step is still recognisable at a glance.
      return degree + accidentalLabel(step.alter ?? 0);
    })
    .join(' ');
}

/** The strip's group select carries both ids, since group ids are unique per library. */
const groupKey = (libraryId: string, groupId: string) => `${libraryId}:${groupId}`;

const CONTROL_CLASS =
  'px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-gray-200 hover:bg-gray-600 focus:outline-none focus:border-indigo-500';

/** A draft formula on its way into the editor, with anything the capture had to drop. */
interface Draft {
  formula: MelodicFormula;
  notice?: string;
}

/**
 * Strip of draggable melodic formulas — named phrases in scale degrees, grouped by
 * family, that drop onto the timeline as a run of note blocks.
 *
 * A formula is a *shape*, not a tune: its degrees are relative, so the strip's key,
 * octave and start degree decide what it actually sounds. Those first two are the
 * scale palette's own settings above, deliberately shared rather than duplicated —
 * a phrase and a chord dropped in the same session belong in the same key.
 *
 * What it offers is entirely the user's: the formulas come from the libraries open in
 * `formulaLibraryStore`, and with none open the strip has nothing to show and says so.
 */
export const FormulaPalette: React.FC = () => {
  const scale = editorStore(s => s.paletteScale);
  const octave = editorStore(s => s.paletteOctave);
  const startDegree = editorStore(s => s.formulaStartDegree);
  const setStartDegree = editorStore(s => s.setFormulaStartDegree);
  const expanded = editorStore(s => s.formulasExpanded);
  const setExpanded = editorStore(s => s.setFormulasExpanded);
  const setDraggingFormulaId = editorStore(s => s.setDraggingFormulaId);

  const libraries = formulaLibraryStore(s => s.libraries);
  const selectedLibraryId = formulaLibraryStore(s => s.selectedLibraryId);
  const selectedGroupId = formulaLibraryStore(s => s.selectedGroupId);
  const selectGroup = formulaLibraryStore(s => s.selectGroup);

  const selectedSegmentIds = selectionStore(s => s.selectedSegmentIds);
  const { openLibrary, loadStarterLibrary } = useFormulaLibraryState();

  const [managing, setManaging] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  // Degrees are named by the same numerals the scale palette uses, so 'start on iii'
  // means the same thing in both strips.
  const numerals = useMemo(() => getDiatonicChords(scale).map(c => c.romanNumeral), [scale]);

  const group =
    libraries
      .find(l => l.id === selectedLibraryId)
      ?.library.groups.find(g => g.id === selectedGroupId) ?? null;
  const hasGroups = libraries.some(l => l.library.groups.length > 0);

  const handleDragStart = (e: React.DragEvent, formula: MelodicFormula) => {
    e.dataTransfer.setData(FORMULA_DRAG_TYPE, JSON.stringify(formula));
    // jsdom — and a few browsers mid-drag — only expose text/plain reliably.
    e.dataTransfer.setData('text/plain', formula.id);
    e.dataTransfer.effectAllowed = 'copy';
    setDraggingFormulaId(formula.id);
  };

  /**
   * Read the selected blocks back into a formula and open the editor on it.
   *
   * The draft is not written anywhere yet: capture is a reading of the timeline, and
   * what it is called and where it belongs are still the user's to say.
   */
  const capture = () => {
    const project = projectStore.getState().project;
    if (!project) return;
    // Capture reads the phrase being edited: that is the timeline the selection was
    // made on, and the only place those ids mean anything.
    const surface = editSurface();
    if (!surface) return;
    const captured = captureFormula(
      project,
      surface.bars,
      selectedSegmentIds,
      scale,
      'Captured formula',
      newId('formula')
    );
    if (!captured) {
      setDraft({
        formula: { id: newId('formula'), name: 'Captured formula', steps: [] },
        notice: 'The selection holds no note blocks, so there was nothing to capture.',
      });
      return;
    }
    setDraft({
      formula: captured.formula,
      notice:
        captured.skipped > 0
          ? `${captured.skipped} chord ${captured.skipped === 1 ? 'block' : 'blocks'} skipped — a formula is one line at a time.`
          : undefined,
    });
  };

  return (
    <div className="shrink-0 px-4 py-2 bg-gray-800 border-b border-gray-700">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          data-testid="formula-toggle"
          className={CONTROL_CLASS}
        >
          Formulas {expanded ? '▾' : '▸'}
        </button>

        {expanded && (
          <>
            {hasGroups ? (
              <>
                <label htmlFor="formula-group" className="sr-only">
                  Formula group
                </label>
                <select
                  id="formula-group"
                  aria-label="Formula group"
                  value={
                    selectedLibraryId && selectedGroupId
                      ? groupKey(selectedLibraryId, selectedGroupId)
                      : ''
                  }
                  onChange={e => {
                    const [libraryId, groupId] = e.target.value.split(':');
                    selectGroup(libraryId, groupId);
                  }}
                  className={CONTROL_CLASS}
                >
                  {libraries
                    .filter(loaded => loaded.library.groups.length > 0)
                    .map(loaded => (
                      // One select rather than two: several libraries read as one list
                      // of groups, each under the name of the file it came from.
                      <optgroup key={loaded.id} label={loaded.library.name}>
                        {loaded.library.groups.map(g => (
                          <option key={g.id} value={groupKey(loaded.id, g.id)}>
                            {g.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                </select>

                <label htmlFor="formula-start-degree" className="sr-only">
                  Start degree
                </label>
                <select
                  id="formula-start-degree"
                  aria-label="Start degree"
                  value={Math.min(startDegree, numerals.length - 1)}
                  onChange={e => setStartDegree(Number(e.target.value))}
                  className={CONTROL_CLASS}
                >
                  {numerals.map((numeral, degree) => (
                    <option key={numeral + degree} value={degree}>
                      Start on {numeral}
                    </option>
                  ))}
                </select>

                {/* The strip states the register once, like the scale palette does,
                    rather than stamping it on every chip. */}
                <span className="text-xs text-gray-400" data-testid="formula-caption">
                  octave {octave}
                </span>
              </>
            ) : (
              <span className="text-xs text-gray-400" data-testid="formula-empty">
                No formulas yet — open a library, or start from the classic set.
              </span>
            )}

            <button
              type="button"
              className={CONTROL_CLASS}
              data-testid="formula-capture"
              onClick={capture}
              disabled={selectedSegmentIds.length === 0}
              title="Read the selected blocks back into a formula"
            >
              Capture selection
            </button>

            <button
              type="button"
              className={CONTROL_CLASS}
              data-testid="formula-libraries"
              onClick={() => setManaging(true)}
            >
              Libraries…
            </button>

            {!hasGroups && (
              <>
                <button
                  type="button"
                  className={CONTROL_CLASS}
                  data-testid="formula-open-library"
                  onClick={() => void openLibrary()}
                >
                  Open…
                </button>
                <button
                  type="button"
                  className={CONTROL_CLASS}
                  data-testid="formula-load-starter"
                  onClick={() => void loadStarterLibrary()}
                >
                  Load starter set
                </button>
              </>
            )}

            <div className="flex flex-wrap gap-2">
              {group?.formulas.map(formula => (
                <div
                  key={formula.id}
                  draggable
                  data-testid={`formula-item-${formula.id}`}
                  title={formula.description}
                  onDragStart={e => handleDragStart(e, formula)}
                  onDragEnd={() => setDraggingFormulaId(null)}
                  className="px-3 py-1 rounded-md text-sm cursor-grab active:cursor-grabbing select-none border transition-colors bg-purple-900/60 border-purple-700 text-purple-100 hover:bg-purple-800"
                >
                  <div className="font-semibold leading-tight">{formula.name}</div>
                  <div className="text-[10px] font-normal opacity-70 leading-tight">
                    {shapeLabel(formula)} · {formulaLengthBeats(formula)} beats
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {managing && <FormulaLibraryDialog onClose={() => setManaging(false)} />}
      {draft && (
        <FormulaEditor
          formula={draft.formula}
          notice={draft.notice}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  );
};
