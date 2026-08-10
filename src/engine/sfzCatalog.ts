import { isTauri } from '@/engine/platform';
import { fileNameOf, readLocalText } from '@/engine/localFile';
import { parseSfz } from '@/engine/sfzParser';
import { sfzRef } from '@/engine/instrumentRef';

/**
 * The SFZ instruments this machine has been shown.
 *
 * The VST3 equivalent can *scan*: plugins live in known directories, so the picker can
 * offer every one installed without the user ever naming a file. An SFZ library lives
 * wherever the user put it, and there is no registry to walk, so the list is built the
 * only way it can be — a file at a time, as they are loaded, and remembered afterwards.
 *
 * `localStorage` rather than the project file, because this is a property of the
 * machine and not of the piece: the same library should be offered in every project,
 * and a project opened on another machine should not claim to know where it lives.
 *
 * Every read tolerates its own failure and answers with an empty list, the way
 * `refStorage` treats a missing IndexedDB. Forgetting which files were loaded is a
 * small loss; failing to start is not.
 */

/** Versioned so a future change of record shape can orphan the old list. */
const STORAGE_KEY = 'chord-composer-sfz-instruments-v1';

/**
 * How many are kept. A picker is not a file manager, and an unbounded list would grow
 * for as long as the app is used; the oldest entry falls off the end instead.
 */
const MAX_REMEMBERED = 50;

export interface SfzInstrumentInfo {
  /** Absolute path to the `.sfz`, exactly as the OS gave it. */
  path: string;
  name: string;
}

/** The remembered instruments, most recently loaded first. */
export function listSfzInstruments(): SfzInstrumentInfo[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter(isInfo) : [];
  } catch {
    // Absent, unavailable, or written by a build that stored something else.
    return [];
  }
}

/**
 * Remember an instrument, moving it to the front if it is already known.
 *
 * Paths are compared case-insensitively: Windows hands back whatever casing the user's
 * click produced, and the same library listed twice in different cases is a bug the
 * user cannot fix.
 */
export function rememberSfzInstrument(info: SfzInstrumentInfo): void {
  const others = listSfzInstruments().filter(
    existing => !samePath(existing.path, info.path)
  );
  write([info, ...others].slice(0, MAX_REMEMBERED));
}

export function forgetSfzInstrument(path: string): void {
  write(listSfzInstruments().filter(info => !samePath(info.path, path)));
}

/**
 * The display name for a path.
 *
 * From the remembered list where possible — an SFZ can name itself, and that name is
 * better than its file name — and from the file name otherwise, so an instrument this
 * machine has never seen still reads as something rather than as a path.
 */
export function sfzNameFor(path: string): string {
  const known = listSfzInstruments().find(info => samePath(info.path, path));
  return known?.name ?? fileNameOf(path, true) ?? path;
}

/** The picker entry for an instrument: the value it sets, and the label to show. */
export function sfzOption(info: SfzInstrumentInfo): { value: string; label: string } {
  return { value: sfzRef(info.path), label: info.name };
}

/**
 * Ask the user for an `.sfz`, remember it, and answer with what was chosen.
 *
 * Null when they cancel, and null in a browser build, where there is no dialog and no
 * way to read what it would return.
 */
export async function pickSfzFile(): Promise<SfzInstrumentInfo | null> {
  if (!isTauri()) return null;

  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'SFZ instrument', extensions: ['sfz'] }],
  });

  if (typeof path !== 'string') return null;

  const info: SfzInstrumentInfo = { path, name: await readName(path) };
  rememberSfzInstrument(info);
  return info;
}

/**
 * The name to show for a file just picked.
 *
 * An SFZ carries no name field, but the freepats libraries — and others following the
 * same habit — put one in a `//+ Name:` comment at the top, which is a better label
 * than `Ocarina 20241002`. A file that has none, or that will not read, falls back to
 * its own name: the label is cosmetic, and refusing the instrument over it would not be.
 */
async function readName(path: string): Promise<string> {
  const fallback = fileNameOf(path, true) || path;

  try {
    return parseSfz(await readLocalText(path)).name || fallback;
  } catch {
    return fallback;
  }
}

/** Forget everything. Exists for tests. */
export function resetSfzCatalog(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored means nothing to clear.
  }
}

function write(list: SfzInstrumentInfo[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Full, or unavailable. The instrument still loads; it is just not remembered.
  }
}

function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isInfo(value: unknown): value is SfzInstrumentInfo {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { path?: unknown; name?: unknown };
  return typeof candidate.path === 'string' && typeof candidate.name === 'string';
}
