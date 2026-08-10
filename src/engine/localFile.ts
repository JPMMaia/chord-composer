/**
 * Reading files the user points the app at, on the desktop build.
 *
 * The webview cannot open a path, so this is a thin front for the native
 * `file_read_*` commands — the mirror of what `projectFile.ts` does for the project
 * itself, kept separate because these files are read-only and are not the project.
 *
 * In a browser build there is no path to read, so every call rejects rather than
 * returning empty: a caller that got an empty `.sfz` back would build a silent
 * instrument and never say why.
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/engine/platform';

/** Read a text file whole. Rejects if it is missing, unreadable, or not on desktop. */
export async function readLocalText(path: string): Promise<string> {
  requireDesktop(path);
  return invoke<string>('file_read_text', { path });
}

/**
 * Read a file as raw bytes.
 *
 * The native side answers with an `ArrayBuffer` over the raw IPC channel. Older
 * bridges hand back a number array for the same command, so both are accepted —
 * the difference is invisible to callers, which only ever want the buffer.
 */
export async function readLocalBytes(path: string): Promise<ArrayBuffer> {
  requireDesktop(path);
  const result = await invoke<ArrayBuffer | number[] | Uint8Array>('file_read_bytes', { path });

  if (result instanceof ArrayBuffer) return result;
  if (result instanceof Uint8Array) return toArrayBuffer(result);
  return toArrayBuffer(Uint8Array.from(result));
}

/** Whether the file is there. False in a browser build, where nothing is. */
export async function localFileExists(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>('file_exists', { path });
  } catch {
    // A failed check is not proof of absence, but treating it as "gone" is the safer
    // of the two: the caller only uses this to label an instrument, never to delete.
    return false;
  }
}

/**
 * The directory a file sits in, with forward slashes and no trailing one.
 *
 * Forward slashes throughout, on Windows too: the paths coming back from here are fed
 * to string work — joining, comparing, showing — and Windows accepts them for reads
 * just as happily as it accepts its own.
 */
export function directoryOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  return cut <= 0 ? normalized.slice(0, cut + 1) : normalized.slice(0, cut);
}

/** The file's own name, with directories and, optionally, its extension removed. */
export function fileNameOf(path: string, stripExtension = false): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
  return stripExtension ? name.replace(/\.[^.]+$/, '') : name;
}

/**
 * Resolve a path stated relative to a directory, collapsing `.` and `..`.
 *
 * An SFZ names its samples relative to itself, and `../shared/piano.wav` is ordinary
 * in a library that shares samples between instruments. An already-absolute path is
 * returned as it came.
 */
export function resolvePath(directory: string, relative: string): string {
  const path = relative.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return path;

  const segments = directory.replace(/\\/g, '/').split('/');
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Never past the root: a sample escaping the drive is a broken file, and
      // clamping gives a path that simply fails to read rather than a nonsense one.
      if (segments.length > 1) segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join('/');
}

function requireDesktop(path: string): void {
  if (!isTauri()) {
    throw new Error(`Cannot read ${path}: reading local files needs the desktop app`);
  }
}

/** A view's bytes as a standalone buffer, never the whole pool it may sit in. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
