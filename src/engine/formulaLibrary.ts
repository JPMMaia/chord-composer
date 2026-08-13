/**
 * A set of melodic formulas, saved on its own so it can be carried between pieces.
 *
 * Formulas used to be a hard-coded catalog, which meant the app could offer twenty
 * gestures and the user could offer none. A library is the missing half: a named
 * collection of groups of formulas, living in a file the user owns, opened and saved
 * like any other document. Several can be open at once — one for medieval neumes, one
 * for a piece's own motives — and each remembers the file it came from.
 *
 * The document is a plain JSON object read by a deliberately tolerant reader, in the
 * same style and for the same reasons as `instrumentTemplate.ts`: something a user may
 * hand-edit must degrade to what it can express rather than refuse to open. The one
 * exception is the same too — JSON with no `groups` array is rejected outright, because
 * that is what a project or an instruments file picked by mistake looks like, and
 * opening it as an empty library would be a worse answer than a message.
 *
 * Where a library *goes* is not decided here; see `projectFile.ts`, which knows about
 * paths, file handles and downloads, exactly as it does for the project itself.
 */
import type { FormulaGroup, FormulaStep, MelodicFormula } from '@/engine/formulas';
import type { FileFilter } from '@/engine/projectFile';

/**
 * Version 1.0 — the first. Every field is written, so there is nothing yet for a
 * reader to infer from absence; the field exists so a later change can.
 */
export const FORMULA_LIBRARY_VERSION = '1.0';

/** The Open/Save dialog filter. JSON contents, but a name and a suffix of its own. */
export const FORMULA_LIBRARY_FILTER: FileFilter = {
  name: 'Chord Composer Formulas',
  extensions: ['ccformulas'],
};

/** Where the starter set of classic formulas is served from, in both builds. */
export const STARTER_LIBRARY_URL = 'formulas/classic.ccformulas';

export interface FormulaLibrary {
  version: string;
  /** What the collection is called — the label its groups sit under in the strip. */
  name: string;
  groups: FormulaGroup[];
  createdAt: string;
}

/**
 * A fresh id for a group or a formula.
 *
 * Unique within a session, which is all that is needed: ids are only ever compared
 * inside one library, and two libraries with a colliding id are still told apart by
 * the library they were loaded into.
 */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A library with nothing in it yet — what "New library" produces. */
export function emptyLibrary(name: string): FormulaLibrary {
  return {
    version: FORMULA_LIBRARY_VERSION,
    name,
    groups: [],
    createdAt: new Date().toISOString(),
  };
}

/** Two-space JSON, matching what the project and template writers produce. */
export function serializeLibrary(library: FormulaLibrary): string {
  return JSON.stringify(library, null, 2);
}

/** Read one step, or null when it describes no note. */
function readStep(raw: unknown): FormulaStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;

  // A step with no length is not a shorter note, it is no note at all — there is
  // nothing sensible to substitute, so it goes.
  if (typeof s.beats !== 'number' || !Number.isFinite(s.beats) || s.beats <= 0) return null;
  const degree =
    typeof s.degree === 'number' && Number.isFinite(s.degree) ? Math.round(s.degree) : 0;
  // Rounded and clamped rather than dropped: a hand-written file asking for a triple
  // sharp means something, and the nearest thing we can spell is closer to what it
  // meant than a natural would be. A zero is written as absent, which is the same note.
  const alter =
    typeof s.alter === 'number' && Number.isFinite(s.alter)
      ? Math.max(-2, Math.min(2, Math.round(s.alter))) || undefined
      : undefined;
  // A negative or absent gap is no gap, which is what most steps mean.
  const gapBeats =
    typeof s.gapBeats === 'number' && Number.isFinite(s.gapBeats) && s.gapBeats > 0
      ? s.gapBeats
      : undefined;

  return { degree, alter, beats: s.beats, gapBeats };
}

/** Read one formula, or null when nothing playable survives. */
function readFormula(raw: unknown, index: number): MelodicFormula | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;

  const steps = Array.isArray(f.steps)
    ? f.steps.map(readStep).filter((step): step is FormulaStep => step !== null)
    : [];
  // A formula with no steps names no gesture, so there is nothing to put on a chip.
  if (steps.length === 0) return null;

  return {
    id: typeof f.id === 'string' && f.id ? f.id : newId('formula'),
    name: typeof f.name === 'string' && f.name ? f.name : `Formula ${index + 1}`,
    description: typeof f.description === 'string' ? f.description : undefined,
    steps,
  };
}

/** Read one group, or null when it holds no formula worth showing. */
function readGroup(raw: unknown, index: number): FormulaGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;

  const formulas = Array.isArray(g.formulas)
    ? g.formulas
        .map((entry, i) => readFormula(entry, i))
        .filter((formula): formula is MelodicFormula => formula !== null)
    : [];

  return {
    id: typeof g.id === 'string' && g.id ? g.id : newId('group'),
    name: typeof g.name === 'string' && g.name ? g.name : `Group ${index + 1}`,
    // Kept even when empty: an empty group is a real thing to have — it is what
    // "New group" makes, and the next capture goes into it.
    formulas,
  };
}

/** Read a library back, dropping whatever cannot be understood. */
export function deserializeLibrary(json: string): FormulaLibrary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That file is not a valid formula library.');
  }

  const l = parsed as Record<string, unknown> | null;
  if (!l || typeof l !== 'object' || !Array.isArray(l.groups)) {
    throw new Error('That file is not a formula library — it lists no groups.');
  }

  return {
    version: typeof l.version === 'string' ? l.version : FORMULA_LIBRARY_VERSION,
    name: typeof l.name === 'string' && l.name ? l.name : 'Formulas',
    groups: (l.groups as unknown[])
      .map((entry, i) => readGroup(entry, i))
      .filter((group): group is FormulaGroup => group !== null),
    createdAt: typeof l.createdAt === 'string' ? l.createdAt : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------
//
// Every helper answers with a new library rather than mutating one, so the store's
// updater stays a plain `set` and React sees a changed object without anything having
// to remember to copy.

/** Add a group, named as given. */
export function withGroup(library: FormulaLibrary, group: FormulaGroup): FormulaLibrary {
  return { ...library, groups: [...library.groups, group] };
}

export function withRenamedGroup(
  library: FormulaLibrary,
  groupId: string,
  name: string
): FormulaLibrary {
  return {
    ...library,
    groups: library.groups.map(g => (g.id === groupId ? { ...g, name } : g)),
  };
}

export function withoutGroup(library: FormulaLibrary, groupId: string): FormulaLibrary {
  return { ...library, groups: library.groups.filter(g => g.id !== groupId) };
}

/**
 * Put a formula in a group, replacing the one with its id if it is already there.
 *
 * One function for both because the editor cannot usefully tell the difference: it
 * opens on a formula that may or may not have been saved yet, and either way what the
 * user means by Save is "this is what it is now".
 */
export function withFormula(
  library: FormulaLibrary,
  groupId: string,
  formula: MelodicFormula
): FormulaLibrary {
  return {
    ...library,
    groups: library.groups.map(group => {
      if (group.id !== groupId) {
        // A formula that has been moved to another group must not stay in this one.
        const kept = group.formulas.filter(f => f.id !== formula.id);
        return kept.length === group.formulas.length ? group : { ...group, formulas: kept };
      }
      const exists = group.formulas.some(f => f.id === formula.id);
      return {
        ...group,
        formulas: exists
          ? group.formulas.map(f => (f.id === formula.id ? formula : f))
          : [...group.formulas, formula],
      };
    }),
  };
}

export function withoutFormula(library: FormulaLibrary, formulaId: string): FormulaLibrary {
  return {
    ...library,
    groups: library.groups.map(group => ({
      ...group,
      formulas: group.formulas.filter(f => f.id !== formulaId),
    })),
  };
}
