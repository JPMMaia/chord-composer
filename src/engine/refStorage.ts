/**
 * Remembering which files the app had open — the project, and the formula libraries
 * beside it — across reloads and restarts.
 *
 * IndexedDB rather than localStorage because of what is being stored: in the browser
 * a reference holds a live `FileSystemFileHandle`, which is an object the browser
 * owns and will only round-trip through structured clone. It cannot be turned into a
 * string, so the one store that keeps objects is the only place it can go. Desktop
 * path references ride along in the same record for the sake of one code path.
 *
 * A restored handle carries no *permission* — that has to be asked for again on the
 * next write, from a user gesture. See `ensureWritable` in `projectFile.ts`.
 *
 * Every operation swallows its failure and answers null. There are real environments
 * without IndexedDB — private windows, the jsdom the tests run in — and forgetting
 * which file was open is a small enough loss that it must never stop the app loading.
 */
import type { ProjectFileRef } from '@/engine/projectFile';

const DB_NAME = 'chord-composer';
const STORE_NAME = 'files';
const CURRENT_KEY = 'current';
const LIBRARIES_KEY = 'formula-libraries';

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Store or clear the reference to remember.
 *
 * A `download` reference is dropped rather than stored: it names a file that left
 * through the Downloads folder and can never be written again, so remembering it
 * would only make the UI claim a file it cannot save to.
 */
export async function storeCurrentRef(ref: ProjectFileRef | null): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  try {
    const keep = ref && ref.kind !== 'download' ? ref : null;
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    if (keep) store.put(keep, CURRENT_KEY);
    else store.delete(CURRENT_KEY);
    await new Promise<void>(resolve => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  } catch {
    // Storage may be unavailable or the handle unclonable; the file is still open.
  } finally {
    db.close();
  }
}

/** The remembered reference, or null when there is none or it cannot be read. */
export async function loadCurrentRef(): Promise<ProjectFileRef | null> {
  const db = await openDatabase();
  if (!db) return null;
  try {
    const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
    const request = store.get(CURRENT_KEY);
    const value = await new Promise<unknown>(resolve => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    return isRef(value) ? value : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Store the files the open formula libraries came from, in the order they are shown.
 *
 * The libraries' *contents* are deliberately not stored: a library is its file, and
 * caching a copy here would let the two drift apart with no way to tell which is the
 * one the user has been editing. `download` refs drop out for `storeCurrentRef`'s
 * reason — they name a file that can never be read again.
 */
export async function storeLibraryRefs(refs: ProjectFileRef[]): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  try {
    const keep = refs.filter(ref => ref.kind !== 'download');
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    if (keep.length > 0) store.put(keep, LIBRARIES_KEY);
    else store.delete(LIBRARIES_KEY);
    await new Promise<void>(resolve => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  } catch {
    // Storage may be unavailable or a handle unclonable; the libraries are still open.
  } finally {
    db.close();
  }
}

/**
 * The remembered library files, or an empty list when there are none.
 *
 * Guarded per entry rather than wholesale, so a record an older build wrote
 * differently — or one a single unclonable handle spoiled — still yields the
 * libraries that survive rather than none of them.
 */
export async function loadLibraryRefs(): Promise<ProjectFileRef[]> {
  const db = await openDatabase();
  if (!db) return [];
  try {
    const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
    const request = store.get(LIBRARIES_KEY);
    const value = await new Promise<unknown>(resolve => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    return Array.isArray(value) ? value.filter(isRef) : [];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Guard the stored record, which an older build may have written differently. */
function isRef(value: unknown): value is ProjectFileRef {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { kind?: unknown; path?: unknown; handle?: unknown };
  if (candidate.kind === 'path') return typeof candidate.path === 'string';
  if (candidate.kind === 'handle') return typeof candidate.handle === 'object' && candidate.handle !== null;
  return false;
}
