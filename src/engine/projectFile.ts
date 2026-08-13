/**
 * The file a project came from, and what can be done with it.
 *
 * Saving used to mean "produce a file" — a picker every time in the browser, a blind
 * download to the Downloads folder on the desktop, and no memory of where the last
 * one went. This module is the missing half: a *reference* to a particular file that
 * survives the session, so a second save can go back to the same place without asking.
 *
 * There are three kinds of reference because there are three levels of what a shell
 * will let the app do:
 *
 * - `path` — the desktop build. A real absolute path, written by this app's own Rust
 *   commands. Re-writable forever, and its directory is reachable, so the auto-save
 *   sidecar can sit next to it.
 * - `handle` — a browser with the File System Access API (Chromium). Re-writable
 *   across reloads once the user re-grants permission, but a file handle cannot
 *   address its own siblings, so there is nowhere to put a sidecar.
 * - `download` — everything else (Firefox, Safari). Not a reference to anything: the
 *   file left through a download and the app can never touch it again. It exists so
 *   the rest of the app can ask "can I quick-save?" and get an honest no.
 *
 * `isTauri()` picks the backend at call time rather than at module load, the same way
 * every other dual-target feature here does.
 */
import { isTauri } from '@/engine/platform';

export type ProjectFileRef =
  | { kind: 'path'; path: string }
  | { kind: 'handle'; handle: FileSystemFileHandle }
  | { kind: 'download'; name: string };

/** The File System Access API, which only some browsers have. */
interface FilePickerWindow {
  showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (options: unknown) => Promise<FileSystemFileHandle[]>;
}

/** Permission methods the FSA spec puts on handles but TypeScript's lib does not. */
interface PermissionCapableHandle extends FileSystemFileHandle {
  queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

function pickerWindow(): FilePickerWindow {
  return typeof window === 'undefined' ? {} : (window as unknown as FilePickerWindow);
}

/** True when this shell can write back to a file the user picked. */
export function canQuickSave(): boolean {
  return isTauri() || typeof pickerWindow().showSaveFilePicker === 'function';
}

/**
 * True when this shell has an Open dialog of its own. When it does not, opening
 * falls back to the hidden `<input type=file>` — which yields a `File` to read but
 * no reference to write back to.
 */
export function canPickFiles(): boolean {
  return isTauri() || typeof pickerWindow().showOpenFilePicker === 'function';
}

/** True when a reference names a file that can be written again. */
export function isReusable(ref: ProjectFileRef | null): ref is ProjectFileRef {
  return ref !== null && ref.kind !== 'download';
}

/**
 * What a picker offers to save or open.
 *
 * A parameter rather than a constant because the pickers below are not only the
 * project's: an instrument template goes through the same three-kinds-of-reference
 * plumbing and differs only in what the dialog should call it.
 */
export interface FileFilter {
  name: string;
  extensions: string[];
}

export const PROJECT_FILTER: FileFilter = {
  name: 'Chord Composer Project',
  extensions: ['json'],
};

/** The user cancelling a picker is not an error; it is answered with `null`. */
function isCancellation(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * A filter in the shape the File System Access API wants.
 *
 * Everything the app writes is JSON, whatever the extension says, so the MIME type is
 * fixed and only the suffixes vary.
 */
function fsaTypes(filter: FileFilter) {
  return [
    {
      description: filter.name,
      accept: { 'application/json': filter.extensions.map(e => `.${e}`) },
    },
  ];
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** The last path segment of a reference — what the UI calls the open file. */
export function fileLabel(ref: ProjectFileRef): string {
  switch (ref.kind) {
    case 'path':
      return ref.path.split(/[\\/]/).pop() || ref.path;
    case 'handle':
      return ref.handle.name;
    case 'download':
      return ref.name;
  }
}

/**
 * Where a reference's auto-save goes: `song.json` beside `song.autosave.json`.
 *
 * Deliberately a sibling rather than the file itself. An auto-save fires every few
 * seconds on work in progress, and the whole point of an explicit save is that it is
 * the version the user chose — one must never overwrite the other.
 *
 * Null for the two browser kinds. A `FileSystemFileHandle` can only address the file
 * it names, and reaching the folder around it would take a second, separate directory
 * permission prompt; the caller falls back to localStorage there.
 */
export function autosaveRef(ref: ProjectFileRef | null): ProjectFileRef | null {
  if (ref?.kind !== 'path') return null;
  return { kind: 'path', path: ref.path.replace(/(\.json)?$/i, '.autosave.json') };
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

/**
 * Ask the user where to save. Returns null when they cancel.
 *
 * The cancel case matters: the old code could not tell a cancelled picker from a
 * broken one and fell through to a download either way, so backing out of Save As
 * still dropped a file in the Downloads folder.
 */
export async function pickSaveRef(
  suggestedName: string,
  filter: FileFilter = PROJECT_FILTER
): Promise<ProjectFileRef | null> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: suggestedName, filters: [filter] });
    return path ? { kind: 'path', path } : null;
  }

  const showSaveFilePicker = pickerWindow().showSaveFilePicker;
  if (showSaveFilePicker) {
    try {
      const handle = await showSaveFilePicker.call(window, {
        suggestedName,
        types: fsaTypes(filter),
      });
      return { kind: 'handle', handle };
    } catch (err) {
      if (isCancellation(err)) return null;
      // A picker that failed for any other reason still leaves the download route,
      // which is the only thing the browsers below can do anyway.
    }
  }

  return { kind: 'download', name: suggestedName };
}

/** Ask the user which project to open. Returns null when they cancel. */
export async function pickOpenRef(
  filter: FileFilter = PROJECT_FILTER
): Promise<ProjectFileRef | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, directory: false, filters: [filter] });
    return typeof path === 'string' ? { kind: 'path', path } : null;
  }

  const showOpenFilePicker = pickerWindow().showOpenFilePicker;
  if (!showOpenFilePicker) return null; // Caller falls back to the hidden file input.

  try {
    const [handle] = await showOpenFilePicker.call(window, {
      multiple: false,
      types: fsaTypes(filter),
    });
    return handle ? { kind: 'handle', handle } : null;
  } catch (err) {
    if (isCancellation(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

/**
 * Confirm the app may still write to a reference, asking the user if it has to.
 *
 * A handle restored from IndexedDB after a reload carries no permission, and the
 * re-grant prompt only opens from a user gesture — which is why this is called from
 * the save path, on the keystroke, and not on mount.
 */
export async function ensureWritable(ref: ProjectFileRef): Promise<boolean> {
  if (ref.kind === 'download') return false;
  if (ref.kind === 'path') return true;

  const handle = ref.handle as PermissionCapableHandle;
  if (!handle.queryPermission) return true; // Nothing to ask; the write will tell us.
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted';
}

/**
 * Whether a reference can be read right now without asking the user for anything.
 *
 * Start-up reopens the remembered file, and start-up has no user gesture to spend: a
 * desktop path is readable as long as the file is still there, while a restored
 * browser handle carries no permission until the next save re-grants it. Answering
 * false is not an error — it means the project opens untitled-looking rather than
 * with a prompt the user never asked for.
 */
export async function canReadSilently(ref: ProjectFileRef): Promise<boolean> {
  switch (ref.kind) {
    case 'path':
      return refExists(ref);
    case 'handle': {
      const handle = ref.handle as PermissionCapableHandle;
      // Nothing to ask means nothing to refuse; the read itself will say.
      if (!handle.queryPermission) return true;
      return (await handle.queryPermission({ mode: 'read' })) === 'granted';
    }
    case 'download':
      return false;
  }
}

/** Write text to a reference. A `download` ref sends it to the Downloads folder. */
export async function writeRef(ref: ProjectFileRef, text: string): Promise<void> {
  switch (ref.kind) {
    case 'path': {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('project_write', { path: ref.path, contents: text });
      return;
    }
    case 'handle': {
      const writable = await ref.handle.createWritable();
      await writable.write(new Blob([text], { type: 'application/json' }));
      await writable.close();
      return;
    }
    case 'download': {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = ref.name;
      anchor.click();
      URL.revokeObjectURL(url);
    }
  }
}

/** Read a reference's text. A `download` ref names no readable file. */
export async function readRef(ref: ProjectFileRef): Promise<string> {
  switch (ref.kind) {
    case 'path': {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<string>('project_read', { path: ref.path });
    }
    case 'handle':
      return (await ref.handle.getFile()).text();
    case 'download':
      throw new Error('That file was downloaded and cannot be read back.');
  }
}

export async function refExists(ref: ProjectFileRef): Promise<boolean> {
  if (ref.kind !== 'path') return false;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean>('project_exists', { path: ref.path });
}

/** Delete a reference's file. Missing is success — the caller is clearing a sidecar. */
export async function removeRef(ref: ProjectFileRef): Promise<void> {
  if (ref.kind !== 'path') return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('project_remove', { path: ref.path });
}

/** When a reference was last written, or null when it is missing or unreadable. */
export async function refModifiedAt(ref: ProjectFileRef): Promise<Date | null> {
  if (ref.kind === 'handle') {
    try {
      return new Date((await ref.handle.getFile()).lastModified);
    } catch {
      return null;
    }
  }
  if (ref.kind !== 'path') return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const ms = await invoke<number | null>('project_modified_ms', { path: ref.path });
  return typeof ms === 'number' ? new Date(ms) : null;
}
